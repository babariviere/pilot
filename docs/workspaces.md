# Workspaces and pull requests

## Keep edits separate

Build normally uses an isolated workspace. jj projects have separate working copies
but **share history and bookmarks**. Git-only projects use private clones.
Direct-checkout mode edits your own checkout instead; choose it deliberately.

Project settings choose the default workspace policy. A new chat can override it.
Build chats can use a workspace terminal; close live terminals before operations
that need a safe workspace or daemon handoff.

## Review delivery

With **Require PR** enabled, agents deliver through task branches and pull requests.
With it disabled, direct default-branch delivery is permitted. Credentials,
repository permissions, and branch protection still apply.

Review changes in the chat. Attach an existing PR from **Changes** with its GitHub
URL or number. A PR elsewhere on the same branch is not automatically owned by the chat.

Pilot monitors eligible agent-owned PRs for CI failures, review feedback, and conflicts.
Follow-ups are bounded; unresolved problems return to you. Agents do not merge PRs.
Any supported app merge action requires your confirmation.

## Archive and restore

Archiving preserves the conversation, but generated outputs such as `node_modules`
and Rust `target` can be deleted immediately. Safe archived jj workspaces may later
be reclaimed and restored from saved snapshots. Dependencies may need reinstalling.

Track files you need to keep. Ignored files are not a general-purpose backup.
Reading archived history does not restore a workspace or start an agent.
