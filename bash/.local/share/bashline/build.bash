#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cache=${XDG_CACHE_HOME:-$HOME/.cache}/bashline
module=$cache/bashline-${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}-${MACHTYPE}.so
if [[ -f $module && $module -nt $root/bashline.c && $module -nt ${BASH_SOURCE[0]} ]]; then
  exit 0
fi

# Local package extraction supports building without installing system packages.
headers=${BASHLINE_HEADERS:-/usr/include}
if [[ ! -f $headers/bash/builtins.h && -f $HOME/.cache/bashline-dev/usr/include/bash/builtins.h ]]; then
  headers=$HOME/.cache/bashline-dev/usr/include
fi
if [[ ! -f $headers/bash/builtins.h || ! -f $headers/readline/readline.h ]]; then
  printf 'Build dependencies: sudo apt install build-essential bash-builtins libreadline-dev\n' >&2
  printf 'Or set BASHLINE_HEADERS to an include directory containing bash/ and readline/.\n' >&2
  exit 1
fi
mkdir -p -- "$cache"
temporary=$(mktemp "$cache/build.XXXXXXXX.so")
trap 'rm -f -- "$temporary"' EXIT
# Resolve Readline symbols from Bash itself, not a second libreadline instance.
"${CC:-cc}" -std=c11 -O2 -g -Wall -Wextra -Werror -fPIC -shared \
  -I"$headers/bash" -I"$headers/bash/include" -I"$headers" \
  "$root/bashline.c" -o "$temporary"
chmod 755 "$temporary"
mv -f -- "$temporary" "$module"
printf 'Built %s\n' "$module"
