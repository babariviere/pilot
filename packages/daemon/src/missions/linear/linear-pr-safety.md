# Linear pull request safety

For each explicitly contributing task, `mission prGuidance` checks the current contributor set.
Earlier contributors use `Related to ENG-123`. Only the final contributor uses `Closes ENG-123`,
and only when every **other** contributor is Done and the live synchronization guard allows it.
Dropped, delegated, blocked, review and todo tasks are not Done. Reference-only links never qualify.
Recheck before publishing or editing a PR, and after task or link changes, not just planned ordering.

The guard belongs to daemon synchronization. It verifies live identity/status and the accepted
contributor scope, preserving Deployed/Canceled/Duplicated and manual-change/reopen pauses. Missing,
stale or failed safeguards deny closing. Removing a link cannot substitute for scope acceptance.
Completion synchronization remains necessary; the directive is an additional safeguard, not its replacement.

The daemon reads linked, task-owned PR titles, descriptions, branch names and up to 100 commit messages
on attachment, task/link/sync changes and existing PR observations. Checks are coalesced, one network
read at a time, and do not introduce another polling loop. Descriptions are bounded to 65,536 characters,
commit messages to 8,000 each. Incomplete coverage or lookup failures produce an actionable local flag,
not a safe verdict. It recognizes Linear's documented closing words, issue lists, URLs and Markdown links.
This is a conservative text check, not Linear's parser or a required GitHub status check.

Unsafe directives, missing eligible final directives and risky earlier branch names create durable
local correction comments and coordinator notices. Unchanged flags are deduplicated across restarts.
Only flags created by this checker are resolved when corrected. It never edits a PR or commit, posts on
GitHub, merges, or changes Linear status. Human correction and merge review remain required. Checks
cannot eliminate the race between observation and an external merge/status change.

## What Linear's GitHub integration actually does

Verified against [Linear's GitHub documentation](https://linear.app/docs/github) on 2026-10-16.
These are the vendor's documented behaviors, not a live mutation test against a user's workspace:

- Closing words include `close/closes/closed/closing`, `fix/fixes/fixed/fixing`,
  `resolve/resolves/resolved/resolving`, `complete/completes/completed/completing`,
  `implement/implements/implemented/implementing` and `linear issue`. They work in PR titles/descriptions
  and commit messages. PR comments do not establish these links.
- `Related to` and `Relates to` are relation-only words with no status changes. Prefer them for earlier
  PRs. `Refs`, `References`, `Part of`, `Contributes to`, `Toward` and `Towards` are **non-closing**, but
  can still trigger pre-merge workflow transitions. Non-closing is not the same as read-only.
- A ticket ID in a branch name can link the PR independently. Commit linking needs the integration's
  push webhook; pushed commits can move tickets to In Progress and reaching the default branch can
  move them to Done. Copying a branch name can itself start/assign an issue when personal automation
  is enabled. Avoid ticket IDs in earlier branch names and commit messages where those effects are unwanted.
- Merge destinations come from **Linear's team PR/commit automation settings**, with target-branch
  overrides. They can be Done, In QA or Deployed, not necessarily Pilot's configured Merged mapping.
  Integration installation, permissions, webhook settings and branch rules matter. A directive alone
  does not guarantee any transition or delivery/deployment state.
- Linear supports multiple PRs linked to one ticket and documents waiting for the final linked PR's
  required state. That set is not Pilot's explicit contributor set, so it cannot replace task-based checks.
- Direct cancellation or duplication can close PRs linked with Closes or Contributes; a PR also linked
  to another open issue, or linked only as a reference, remains open. Completion and automated
  cancellation have different behavior.

Pilot's pause and terminal safeguards control **its own** synchronization and closing guidance.
They cannot disable Linear's independently configured GitHub automations or undo a transition that
already happened on push/open/merge. Review those settings when strict status ownership is needed;
there is deliberately no promise that a final closing directive targets Merged or preserves a later
manual change made after the check.
