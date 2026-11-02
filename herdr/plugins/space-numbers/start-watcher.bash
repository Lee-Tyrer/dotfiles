#!/usr/bin/env bash
# Startup hook: refresh $num, then launch watch.py detached (one instance per
# socket). watch.py exits on its own when the Herdr server goes away.
set -euo pipefail

cd "$(dirname "$0")"
bash space-numbers.bash

state_dir="${HERDR_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-space-numbers}"
mkdir -p "$state_dir"
lock="$state_dir/watch-$(printf '%s' "${HERDR_SOCKET_PATH:-default}" | md5sum | cut -c1-12).lock"

setsid flock -n "$lock" /usr/bin/python3 watch.py </dev/null >/dev/null 2>&1 &
