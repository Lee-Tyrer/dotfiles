#!/usr/bin/env bash
# Report every Space's jump number and label as the $num metadata token,
# e.g. "1 glowmetry", so the sidebar shows them without a separator dot.
set -euo pipefail

herdr="${HERDR_BIN_PATH:-herdr}"

"$herdr" workspace list \
  | jq -r '.result.workspaces[]
      | ("\(.number) \(.label)") as $value
      | select(.tokens.num != $value)
      | "\(.workspace_id)\t\($value)"' \
  | while IFS=$'\t' read -r id value; do
      "$herdr" workspace report-metadata "$id" --source lee.space-numbers --token "num=$value" >/dev/null
    done
