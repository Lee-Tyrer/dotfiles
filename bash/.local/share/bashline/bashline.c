/* SPDX-License-Identifier: GPL-3.0-or-later */
#define _XOPEN_SOURCE 700
#include <config.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <wchar.h>
#include "shell.h"
#include "builtins.h"
#include "builtins/common.h"
#include <readline/readline.h>
#include <readline/history.h>

/* Readline's physical cursor column, including prompt and wrapped input. */
extern int _rl_last_c_pos;
extern int _rl_last_v_pos;

static int active, ghost_drawn, suggestion_visible;
static rl_voidfunc_t *previous_deprep;
static rl_getc_func_t *previous_getc;
static rl_completion_func_t *previous_completion;
static rl_compignore_func_t *previous_ignore;

struct binding {
    const char *sequence;
    rl_command_func_t *function;
    int type;
    char *macro;
};
static struct binding bindings[] = {{"\t", NULL, 0, NULL},
                                    {"\033[C", NULL, 0, NULL},
                                    {"\033OC", NULL, 0, NULL}};
static Keymap bound_keymap;

static FILE *output(void)
{
    return rl_outstream ? rl_outstream : stdout;
}

static void clear_ghost(void)
{
    if (ghost_drawn) {
        fputs("\033[K", output());
        fflush(output());
        ghost_drawn = 0;
    }
}

static const char *history_suffix(void)
{
    unsigned long excluded = RL_STATE_ISEARCH | RL_STATE_NSEARCH |
        RL_STATE_SEARCH | RL_STATE_COMPLETING | RL_STATE_DONE |
        RL_STATE_SIGHANDLER | RL_STATE_NUMERICARG;
    if (!active || rl_done || (rl_readline_state & excluded) ||
        rl_editing_mode != 1 || rl_point != rl_end || rl_end == 0 ||
        !rl_line_buffer || strchr(rl_line_buffer, '\n'))
        return NULL;

    HIST_ENTRY **entries = history_list();
    for (int i = history_length - 1; entries && i >= 0; --i) {
        const char *line = entries[i]->line;
        if (!strncmp(line, rl_line_buffer, (size_t)rl_end) &&
            strlen(line) > (size_t)rl_end && !strpbrk(line, "\r\n"))
            return line + rl_end;
    }
    return NULL;
}

/* Clip to this physical row; never wrap ghost text or emit control bytes. */
static size_t visible_bytes(const char *text, int columns)
{
    mbstate_t state = {0};
    size_t offset = 0;
    while (text[offset] && columns > 0) {
        wchar_t character;
        size_t length = mbrtowc(&character, text + offset, MB_CUR_MAX, &state);
        if (length == (size_t)-1 || length == (size_t)-2 || length == 0)
            break;
        int width = wcwidth(character);
        if (width < 0 || width > columns)
            break;
        columns -= width;
        offset += length;
    }
    return offset;
}

static void draw_suggestion(void)
{
    clear_ghost();
    suggestion_visible = 0;
    const char *suffix = history_suffix();
    if (!suffix)
        return;

    int rows, columns;
    rl_get_screen_size(&rows, &columns);
    size_t length = visible_bytes(suffix, columns - _rl_last_c_pos - 1);
    if (!length)
        return;
    FILE *stream = output();
    fputs("\0337\033[90m", stream);
    fwrite(suffix, 1, length, stream);
    fputs("\033[0m\0338", stream);
    fflush(stream);
    ghost_drawn = suggestion_visible = 1;
}

/* Draw after Readline redisplays, then erase before it handles the next key.
   Leaving rl_redisplay_function untouched preserves Readline's resize handling. */
static int bashline_getc(FILE *stream)
{
    draw_suggestion();
    int key = previous_getc(stream);
    clear_ghost();
    return key;
}

static void bashline_deprep(void)
{
    clear_ghost();
    suggestion_visible = 0;
    previous_deprep();
}

static int accept_suggestion(int count, int key)
{
    const char *suffix = suggestion_visible ? history_suffix() : NULL;
    if (!suffix || count <= 0)
        return rl_forward_char(count, key);
    char *copy = strdup(suffix);
    if (!copy)
        return 1;
    clear_ghost();
    suggestion_visible = 0;
    rl_begin_undo_group();
    rl_insert_text(copy);
    rl_end_undo_group();
    free(copy);
    return 0;
}

static void free_matches(char **matches)
{
    if (matches) {
        for (size_t i = 0; matches[i]; ++i)
            free(matches[i]);
        free(matches);
    }
}

/* fzf owns its UI; Readline still owns quoting and insertion of the result. */
static char *choose_match(char **matches)
{
    FILE *input = tmpfile();
    if (!input) {
        builtin_error("completion input: %s", strerror(errno));
        return NULL;
    }
    int failed = 0;
    for (size_t i = 1; matches[i]; ++i)
        if (fwrite(matches[i], 1, strlen(matches[i]) + 1, input) != strlen(matches[i]) + 1)
            failed = 1;
    if (fflush(input) || fseek(input, 0, SEEK_SET))
        failed = 1;
    int result[2];
    if (failed || pipe(result) < 0) {
        builtin_error("completion input: %s", strerror(errno));
        fclose(input);
        return NULL;
    }
    fcntl(fileno(input), F_SETFD, FD_CLOEXEC);
    fcntl(result[0], F_SETFD, FD_CLOEXEC);
    fcntl(result[1], F_SETFD, FD_CLOEXEC);

    sigset_t blocked, old_mask;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGINT);
    sigaddset(&blocked, SIGQUIT);
    sigaddset(&blocked, SIGCHLD);
    sigaddset(&blocked, SIGWINCH);
    sigprocmask(SIG_BLOCK, &blocked, &old_mask);
    clear_ghost();
    rl_deprep_term_function();
    fflush(output());

    pid_t child = fork();
    if (child == 0) {
        int signals[] = {SIGINT, SIGQUIT, SIGCHLD, SIGWINCH, SIGPIPE,
                         SIGTSTP, SIGTTIN, SIGTTOU};
        for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); ++i)
            signal(signals[i], SIG_DFL);
        sigprocmask(SIG_SETMASK, &old_mask, NULL);
        if (dup2(fileno(input), STDIN_FILENO) < 0 ||
            dup2(result[1], STDOUT_FILENO) < 0)
            _exit(126);
        close(result[0]);
        close(result[1]);
        fclose(input);
        unsetenv("FZF_DEFAULT_OPTS");
        unsetenv("FZF_DEFAULT_OPTS_FILE");
        execlp("fzf", "fzf", "--read0", "--print0", "--no-multi",
               "--layout=reverse", "--height=40%", "--border=rounded",
               "--info=inline", "--no-sort", "--cycle", "--prompt=complete> ",
               "--bind=tab:down,btab:up", (char *)NULL);
        _exit(127);
    }
    close(result[1]);
    fclose(input);

    char *selection = NULL;
    size_t capacity = 0;
    ssize_t length = -1;
    FILE *pipe_stream = NULL;
    if (child > 0) {
        pipe_stream = fdopen(result[0], "r");
        if (pipe_stream)
            length = getdelim(&selection, &capacity, '\0', pipe_stream);
        else
            kill(child, SIGTERM);
    }
    if (pipe_stream)
        fclose(pipe_stream);
    else
        close(result[0]);
    int status = 0;
    pid_t waited = -1;
    if (child > 0)
        do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
    else
        builtin_error("completion process: %s", strerror(errno));

    rl_prep_term_function(1);
    /* fzf restores the input cursor. Redraw from the first physical input row. */
    fputc('\r', output());
    if (_rl_last_v_pos > 0)
        fprintf(output(), "\033[%dA", _rl_last_v_pos);
    fputs("\033[J", output());
    rl_forced_update_display();
    sigprocmask(SIG_SETMASK, &old_mask, NULL);

    int valid = waited == child && child > 0 && WIFEXITED(status) &&
        WEXITSTATUS(status) == 0 && length > 0 && selection[length - 1] == '\0';
    if (valid) {
        valid = 0;
        for (size_t i = 1; matches[i]; ++i)
            if (!strcmp(selection, matches[i])) {
                valid = 1;
                break;
            }
    }
    if (!valid) {
        free(selection);
        return NULL;
    }
    return selection;
}

static char **menu_completion(const char *text, int start, int end)
{
    char **matches = previous_completion ? previous_completion(text, start, end) : NULL;
    if (!matches && !rl_attempted_completion_over)
        matches = rl_completion_matches(text, rl_completion_entry_function ?
            rl_completion_entry_function : rl_filename_completion_function);
    rl_attempted_completion_over = 1;
    /* Bash can change this hook for cd or a programmable completion. */
    rl_compignore_func_t *ignore = rl_ignore_some_completions_function;
    rl_ignore_some_completions_function = NULL;
    if (!matches)
        return NULL;

    /* Apply Bash's FIGNORE and directory filters before opening the menu. */
    if (ignore && rl_filename_completion_desired)
        ignore(matches);
    if (!matches[0]) {
        free_matches(matches);
        return NULL;
    }
    /* The menu runs before Readline's normal duplicate removal. */
    size_t unique = 1;
    for (size_t i = 1; matches[i]; ++i) {
        size_t j;
        for (j = 1; j < unique; ++j)
            if (!strcmp(matches[i], matches[j]))
                break;
        if (j == unique)
            matches[unique++] = matches[i];
        else
            free(matches[i]);
    }
    matches[unique] = NULL;
    if (unique == 2) {
        free(matches[0]);
        matches[0] = matches[1];
        matches[1] = NULL;
    }
    if (!matches[1])
        return matches;

    char *selection = choose_match(matches);
    free_matches(matches);
    if (!selection)
        return NULL;
    char **single = calloc(2, sizeof(char *));
    if (!single) {
        free(selection);
        return NULL;
    }
    single[0] = selection;
    return single;
}

static int complete_menu(int count, int key)
{
    (void)count;
    clear_ghost();
    suggestion_visible = 0;
    previous_completion = rl_attempted_completion_function;
    previous_ignore = rl_ignore_some_completions_function;
    rl_attempted_completion_function = menu_completion;
    rl_completion_invoking_key = key;
    int result = rl_complete_internal('\t');
    rl_attempted_completion_function = previous_completion;
    rl_ignore_some_completions_function = previous_ignore;
    return result;
}

static void disable_bashline(void)
{
    if (!active)
        return;
    clear_ghost();
    suggestion_visible = 0;
    if (rl_getc_function == bashline_getc)
        rl_getc_function = previous_getc;
    if (rl_deprep_term_function == bashline_deprep)
        rl_deprep_term_function = previous_deprep;
    for (size_t i = 0; i < sizeof(bindings) / sizeof(bindings[0]); ++i) {
        struct binding *binding = &bindings[i];
        /* rl_generic_bind takes ownership of a restored macro string. */
        char *data = binding->type == ISMACR ? binding->macro : (char *)binding->function;
        rl_generic_bind(binding->type, binding->sequence, data, bound_keymap);
        binding->macro = NULL;
    }
    active = 0;
}

static int enable_bashline(void)
{
    if (active)
        return EXECUTION_SUCCESS;
    if (!isatty(fileno(output())) || rl_editing_mode != 1) {
        builtin_error("requires an interactive terminal with Emacs Readline bindings");
        return EXECUTION_FAILURE;
    }
    bound_keymap = rl_get_keymap();
    for (size_t i = 0; i < sizeof(bindings) / sizeof(bindings[0]); ++i) {
        struct binding *binding = &bindings[i];
        binding->function = rl_function_of_keyseq(binding->sequence, bound_keymap, &binding->type);
        if (binding->type == ISMACR) {
            binding->macro = strdup((char *)binding->function);
            if (!binding->macro) {
                for (size_t j = 0; j < i; ++j) {
                    free(bindings[j].macro);
                    bindings[j].macro = NULL;
                }
                return EXECUTION_FAILURE;
            }
        }
    }
    previous_getc = rl_getc_function;
    previous_deprep = rl_deprep_term_function;
    rl_getc_function = bashline_getc;
    rl_deprep_term_function = bashline_deprep;
    rl_bind_keyseq_in_map("\t", complete_menu, bound_keymap);
    rl_bind_keyseq_in_map("\033[C", accept_suggestion, bound_keymap);
    rl_bind_keyseq_in_map("\033OC", accept_suggestion, bound_keymap);
    active = 1;
    return EXECUTION_SUCCESS;
}

int bashline_builtin(WORD_LIST *list)
{
    const char *argument = list ? list->word->word : "status";
    if (list && list->next) {
        builtin_usage();
        return EX_USAGE;
    }
    if (!strcmp(argument, "on"))
        return enable_bashline();
    if (!strcmp(argument, "off")) {
        disable_bashline();
        return EXECUTION_SUCCESS;
    }
    if (!strcmp(argument, "status")) {
        printf("bashline: %s (history suggestions + fzf Tab menu)\n", active ? "on" : "off");
        return EXECUTION_SUCCESS;
    }
    builtin_usage();
    return EX_USAGE;
}

void bashline_builtin_unload(char *name)
{
    (void)name;
    disable_bashline();
}

static char *documentation[] = {
    "Enable or disable history ghost text and an fzf-backed Tab completion menu.",
    "Right Arrow accepts the visible history suggestion at the end of input.",
    "With no argument, print the current status.",
    NULL
};

struct builtin bashline_struct = {
    "bashline", bashline_builtin, BUILTIN_ENABLED,
    documentation, "bashline [on|off|status]", NULL
};
