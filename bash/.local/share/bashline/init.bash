# Loaded at the end of interactive Bash startup.
[[ $- == *i* ]] || return
if ! command -v fzf >/dev/null 2>&1; then
  printf 'bashline requires fzf in PATH.\n' >&2
  return 1
fi
if [[ $(type -t bashline) != builtin ]]; then
  _bashline_module=${XDG_CACHE_HOME:-$HOME/.cache}/bashline/bashline-${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}-${MACHTYPE}.so
  enable -f "$_bashline_module" bashline || return
  unset _bashline_module
fi
bashline on
