# Bashline

Bash extension for history-based inline suggestions and an fzf Tab menu. It loads automatically in new interactive Bash terminals and SSH sessions.

## Use it

Open a new terminal or reconnect over SSH. Run `bashline-shell` if you want an additional nested shell, and `exit` to return from it.

- Type the beginning of a previous command to see the newest matching history entry in grey.
- Press Right Arrow at the end of the input to insert the entire suggestion. Enter executes only the text you have accepted or typed.
- Press Tab to complete. A single candidate is inserted immediately; multiple candidates open fzf. Type to filter, use arrows or Tab/Shift-Tab to select, and press Enter to insert. Escape or Ctrl+C cancels the menu.
- Existing fzf Ctrl+R history search, Ctrl+T file selection, and Alt+C directory selection remain available.
- `bashline off` restores normal Readline bindings in the current shell; `bashline on` re-enables the extension. `bashline status` shows its state.

Bash generates the completion candidates and applies its own quoting, directory slashes, and completion options. The extension does not evaluate suggestions. History lookup and suggestion display run inside Bash without launching a process for each key.

## Build

Requires Linux, Bash 5.2 with loadable builtins, a C compiler, Bash development headers, Readline development headers, and fzf. On Ubuntu, the header packages are `bash-builtins` and `libreadline-dev`.

The dotfiles installer installs the build dependencies and builds the module before linking the Bash configuration. `bashline-shell` also builds the module when necessary and caches it under `${XDG_CACHE_HOME:-$HOME/.cache}/bashline/`. It links to the Readline symbols already in Bash. To use extracted development packages, set `BASHLINE_HEADERS` to their `usr/include` directory.

Source files are in `~/.local/share/bashline/`. The launcher and the Bash startup configuration are managed by the dotfiles `bash` Stow package.

## Scope

Uses Emacs-style Readline editing and an ANSI-compatible terminal. Suggestions come from the current shell's in-memory history, use single-line entries, and appear only at the end of input. Grey text is clipped at the right edge of the current terminal row; accepting it inserts the complete suggestion. Normal input can still wrap and Readline handles multiline commands and bracketed paste.

There is no syntax highlighting or custom multiline editor. The completion menu uses its own fzf options so global fzf options cannot change its selection-output format.
