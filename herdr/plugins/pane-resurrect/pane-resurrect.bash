# herdr pane-resurrect: record the command running in this herdr pane so the
# plugin can rerun it after herdr restarts. Source from ~/.bashrc (near the end).
#
# While a command runs, its cwd and command line are written to
#   ${XDG_STATE_HOME:-~/.local/state}/herdr-pane-resurrect/<session>/<pane-id>
# and the file is emptied when the prompt returns. A reboot kills the shell
# mid-command, so the record survives and the plugin restores it on startup.

[[ $- == *i* && -n ${HERDR_PANE_ID:-} && -n ${HERDR_SOCKET_PATH:-} ]] || return 0
[[ -n ${__hpr_loaded:-} ]] && return 0
__hpr_loaded=1

__hpr_dir="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-pane-resurrect/${HERDR_SOCKET_PATH//\//_}"
__hpr_file="$__hpr_dir/$HERDR_PANE_ID"
__hpr_armed=
__hpr_wrote=
__hpr_hist=
mkdir -p -- "$__hpr_dir" 2>/dev/null || return 0

__hpr_precmd() {
  # Only clear a record this shell wrote. A freshly restored shell must not
  # wipe the record before the plugin's startup hook reads it.
  if [[ -n $__hpr_wrote ]]; then
    : >"$__hpr_file" 2>/dev/null
    __hpr_wrote=
  fi
  __hpr_hist=$(HISTTIMEFORMAT= builtin history 1)
  __hpr_armed=1
}

__hpr_preexec() {
  [[ -n $__hpr_armed ]] || return 0
  # Ignore completion functions and bind -x widgets (e.g. fzf).
  [[ -n ${COMP_LINE:-} || -n ${READLINE_POINT:-} ]] && return 0
  local cmd=$BASH_COMMAND p
  for p in "${PROMPT_COMMAND[@]}"; do
    [[ $cmd == "$p" ]] && return 0
  done
  __hpr_armed=

  # Prefer the full history line (keeps pipelines, &&, env prefixes). If the
  # line did not create a new history entry (leading space, or ignoredups on a
  # repeat), only trust it when it starts with the command being run.
  local raw line
  raw=$(HISTTIMEFORMAT= builtin history 1)
  if [[ $raw =~ ^[[:space:]]*[0-9]+\*?[[:space:]]+(.*)$ ]]; then
    line=${BASH_REMATCH[1]}
    if [[ $raw != "$__hpr_hist" || $line == "$cmd"* ]]; then
      cmd=$line
    fi
  fi

  printf '%s\n%s\n' "$PWD" "$cmd" >"$__hpr_file" 2>/dev/null && __hpr_wrote=1
}

# Run last in PROMPT_COMMAND so nothing else executes between arming and the
# user's command.
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
  PROMPT_COMMAND+=(__hpr_precmd)
else
  PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}__hpr_precmd"
fi

# Chain onto any existing DEBUG trap.
__hpr_trap_body() { printf '%s' "$3"; }
__hpr_prev_trap=
if [[ -n $(trap -p DEBUG) ]]; then
  eval "__hpr_prev_trap=\$(__hpr_trap_body $(trap -p DEBUG))"
fi
trap -- "__hpr_preexec${__hpr_prev_trap:+; $__hpr_prev_trap}" DEBUG
unset -v __hpr_prev_trap
unset -f __hpr_trap_body
