# Pi extensions cleanup

Goal: clean, simple, readable extensions. Handle errors only where they practically occur.
Behaviour stays the same unless a phase says otherwise.

Baseline for comparison: `HEAD` copies in `/tmp/pi-ext-baseline/`.
Type check: `/tmp/pi-tsc/check.sh ~/.pi/agent/extensions` (strict TS against Pi's own `.d.ts`).
HEAD already has two type errors: `imagegen.ts:329` and `thinking-selector.ts:28`.

## Phase 1: diff.ts

Per-prompt snapshots are the slow part: a `git add --all` of the whole tree before every prompt,
blocking the prompt, in a private repo that grew to 11 GB. Rarely used.

- [x] Drop snapshots entirely (Snapshots class, cleanup, prompt records, session entries).
- [x] `/diff` opens the working tree vs `HEAD` (what the agent has changed and not committed).
- [x] `/diff branch [base]` keeps the branch vs merge-base view.
- [x] Keep review comments sent back as a follow-up. Drop the delivery-ack dance and draft file.
- [x] `nvim/.config/nvim/lua/pi_diff.lua`: drop snapshot GIT_DIR handling and the "since prompt" picker.
- [x] Leave `~/.pi/agent/snapshots/` on disk for the user to delete.
- [x] Found: diffview.nvim had no plugin spec, so /diff could not open. Added `lua/plugins/diffview.lua`.
- [x] Uncommitted view uses plain `DiffviewOpen` so untracked files are listed. Verified: open, comment, send, branch, errors.

## Phase 2: footer, statuses, TTL, auto-resume

- [x] Footer renders `footerData.getExtensionStatuses()` on the left after the model.
      This shows "Claude resumes in Nm" again.
- [x] plan-mode / fast-mode: status only via `setStatus`; delete the `plan-mode:changed` and
      `fast-mode:changed` events and the footer listeners.
- [x] Cache TTL: one `expiresAt` for the model that last answered; redraw once a minute; stop at expiry.
      Durations by provider: `openai-codex` 30m, `claude-bridge` 60m.
- [x] Replace `WorkTimerState` callback bag with the session `ctx`. Keep the billboard animation.
- [x] `usageTotals`: one add-usage helper instead of three copies.
- [x] Merge `new-session-summary.ts` into the footer extension (same totals code) and delete the file.
- [x] claude-auto-resume: keep the ctx, drop tick re-validation already covered by cancel events.

## Phase 3: fast-mode.ts

- [x] Confirm `before_provider_request` alone puts `service_tier: "priority"` on the wire (live request).
- [x] Delete the provider wrapper, adapter symbol and type aliases.
- [x] State: saved toggle for the session, else on. Only applies to GPT-6 Luna; status shows only when it applies.
      Drop `automatic`, `autoFastForNewSession`, the `--fast` flag and the auto-persist on new sessions.
- [x] Follow-up: Fast mode applies to every `openai-codex` model, not only GPT-6 Luna. Verified astra, sol and luna send `priority`.

## Phase 4: task-title.ts

- [x] Remove usage logging and delete `question-summary-usage.json` (+ its `.gitignore` line).
- [x] One timeout (pass `timeoutMs`, drop the extra `setTimeout`).
- [x] One staleness guard (`pendingController === controller`), drop `generation` / `active`.
- [x] Drop the duplicate threshold check and duplicate `.then` / `.catch` guards.

## Phase 5: compact-tools.ts

Keep: compact renderers, context compaction of large/old outputs, grep merging, ripgrep-backed tools.

- [x] Path recovery: replace the directory walker and silent retry with "path not found + parent listing".
- [x] Drop Windows/`file://`/`@`/unicode-space path handling, `historicalSearchDetails`, debug env var.
- [x] Derive the grep exclude glob from `EXCLUDED_DIRECTORIES`.
- [x] Shared renderer helper for the repeated `renderResult` code.

## Phase 6: plan-mode.ts

- [x] Allow `|`, `&&`, `||`, `;` chains when every segment is an allowlisted read-only command.
      Still block redirects and command substitution.
- [x] Add `find` (without `-exec`/`-delete`) to the allowlist; drop the dead npm/node rejection regex.

## Phase 7: smaller files

- [x] worktrees.ts: one Alacritty launch path, drop unused param.
- [x] imagegen.ts: drop unused `token` / `accountId`, simplify base URL, fix type error.
- [x] codex-usage.ts: go straight from API response to display rows.
- [x] thinking-selector.ts: fix type error.

## Phase 8: verify and report

- [x] Type check clean, Pi loads all extensions, TUI smoke test, live Codex + Claude prompts.
- [x] Report lines removed, speed wins, simplifications.

## Outcome

All phases done and verified (strict type check clean, live TUI runs through a pty, live Codex/Claude requests).

- Behaviour checks: /diff open/comment/send/branch/errors; footer statuses, plan mode, TTL 2m -> 1m -> 0m with
  a short-TTL copy; previous-session summary; fast on/off/on -> payload priority/none/priority, identical to HEAD;
  task title summary; compact-tools context transform identical to HEAD on 631 request points from 12 real sessions;
  plan-mode allow/block table; /status identical for Codex and Claude; /worktrees menu and list; imagegen live.
- Not exercised: opening a worktree (launches a real Alacritty window), a real Claude quota rejection
  (status rendering verified with a test status).
- Leftover for the user: `rm -rf ~/.pi/agent/snapshots` (16 GB, no longer used).
