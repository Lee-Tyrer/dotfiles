# Pane Resurrect

Reruns the command that was running in each herdr pane when herdr last stopped
(reboot, crash, `herdr server stop`). Agent panes are left to herdr's own
integrations.

- `pane-resurrect.bash` (sourced from `~/.bashrc`) writes
  `~/.local/state/herdr-pane-resurrect/<session>/<pane-id>` when a command
  starts and empties it when the prompt returns.
- On herdr startup, `pane-resurrect.mjs startup` reruns each record whose pane
  still exists, in the recorded cwd.
- Closing a pane, tab, or workspace deletes its record. Ctrl-C or a normal exit
  empties it, so stopped commands stay stopped.

Extra commands to skip go in
`~/.config/herdr/plugins/config/lee.pane-resurrect/config.json`:

```json
{ "ignore": ["ssh", "vim"] }
```

Action "Show commands that will be restored" lists current records.
