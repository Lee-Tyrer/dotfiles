---
name: create-pr
description: Create a GitHub pull request from the current branch, generating its title and description from the changes and following repository PR guidance. Use only when explicitly invoked with /skill:create-pr.
disable-model-invocation: true
---

# Create a pull request

Run this workflow only after the user explicitly invokes `/skill:create-pr`. Invocation authorizes pushing the current branch and opening a PR. It does not authorize editing files, staging changes, or creating commits.

Arguments after the command can set or override PR details, for example `draft`, `base=release`, `title="..."`, `body="..."`, `reviewer=@name`, `assignee=@me`, or `label=bug`. Generate the title and body when they are not provided. Add reviewers, assignees, labels, or a milestone only when requested or required by repository guidance.

## Preflight

1. Confirm this is a GitHub repository with `git rev-parse --show-toplevel`, `gh repo view`, and a successful `gh auth status`. Stop with the relevant error if GitHub CLI is unavailable, unauthenticated, or the repository cannot be identified.
2. Check `git status --short`. If the worktree has staged, unstaged, or untracked changes, stop without changing anything. The PR must contain committed work only; report the dirty paths so the user can decide what to do.
3. Confirm the current branch is named and is not the repository's default branch. Find the default branch with `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`; use it as the base unless the user specified another base. Stop if the base does not exist on the selected remote or is the current branch.
4. Select the branch's configured push remote; fall back to `origin` only if no upstream remote is configured. Confirm that remote exists. Fetch the base branch, then inspect the commits and full diff from the merge base to `HEAD`. Do not include uncommitted files or unrelated commits by inference. If there are no commits to propose, stop.
5. Check whether an open PR already exists for the current branch with `gh pr list --head <branch> --state open`. If one exists, report its URL and stop rather than creating a duplicate.

If the branch contains unrelated commits, the base is ambiguous, or the changes cannot be summarized accurately, stop and ask the user instead of guessing.

## Prepare the PR

Read the relevant commits and diff. Check for repository PR guidance and templates, including `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/PULL_REQUEST_TEMPLATE/`, and root-level `PULL_REQUEST_TEMPLATE.md`. Follow the applicable template and contribution guidance. If several templates are plausible and the right one is unclear, ask which to use.

Generate a concise title in the repository's established style. Write a specific description grounded in the actual diff. Fill template sections and checkboxes only with information supported by the changes or checks actually performed. If there is no template, use:

```markdown
## Summary
- ...

## Testing
- ...
```

Include relevant migration, compatibility, UI screenshot, or issue-reference details when supported by the changes. Never invent issue links, test results, reviewers, labels, or impact. State when tests were not run. Apply explicit title/body overrides from the command arguments.

Before pushing, report the proposed base, title, and body. If the user did not explicitly ask for a draft, create a regular PR. Do not ask for confirmation when the details are clear; ask only if a required detail is ambiguous or the changes appear unrelated to the intended PR.

## Push and create

Push the current branch to its configured remote, setting upstream if needed. Do not force-push. If the push fails, stop and report the error without changing history. Create the PR with `gh pr create`, passing the selected base, generated or supplied title and body, and only the explicitly requested metadata. Use `--draft` when requested. Do not rely on an interactive editor or leave the PR body blank.

Report the resulting PR URL, title, and base. If creation fails, report the error and do not claim that a PR was created.
