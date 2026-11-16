# Workspaces and pull requests

## Keep edits separate

### Add a local project in Day

Open Settings, then Local projects. Enter the folder path and preview it before
choosing Add project. A Git remote selects private jj coding copies, including
for Git-only repositories. Ask reads a separate read-only main copy. Pilot does
not initialize jj in your source folder or copy its uncommitted edits.
Without a Git remote, coding uses your folder directly and reads see its changing
local edits. Existing projects keep their previous settings; adding a project
does not migrate them. A changed remote policy needs a new source review.

Import repository previews a GitHub URL and local destination. GitHub access and
SSH setup can check an existing CLI login and normal SSH identity without
replacing credentials or editing Git/SSH configuration. Browser sign-in is
explicit. An optional dedicated key needs approval for the displayed account
and fingerprint. Host-key checking remains enabled.

Read again shows import progress and interrupted imports. Resume uses the saved
operation and checks the existing checkout before continuing. It does not create
another clone. An existing checkout needs explicit confirmation; mismatched
destinations and partial files are kept, not overwritten or deleted. If an action's
receipt is missing, Check action reads only its saved receipt. It never sends the
action again. An unresolved receipt can require service-side investigation.

The chat shows its actual source or working-copy path for your own terminal.
Day has no embedded terminal. Configured setup hooks still run at the existing
new/restored private-copy boundary, subject to their approvals and Automations
being enabled. Existing idle-refresh guards preserve active and unpublished work.
Settings lists configured hooks; this section does not edit commands or grant
new tool access. Unsent folder/import fields survive a saved close or update.

### Existing project settings

Build normally uses an isolated workspace. jj projects have separate working copies
but **share history and bookmarks**. Git-only projects use private clones.
Direct-checkout mode edits your own checkout instead; choose it deliberately.

When mise is installed, new isolated workspaces automatically trust their local
mise configs, including copied ignored configs, before setup commands run.
Pilot does not grant trust to configs outside the workspace.

Project settings choose the default workspace policy. A new chat can override it.
Build chats can use a workspace terminal; close live terminals before operations
that need a safe workspace or daemon handoff.

## Review delivery

With **Require PR** enabled, agents deliver through task branches and pull requests.
With it disabled, direct default-branch delivery is permitted. Credentials,
repository permissions, and branch protection still apply.

Review changes in the chat. Attach an existing PR from **Changes** with its GitHub
URL or number. A PR elsewhere on the same branch is not automatically owned by the chat.

New standalone Build chats in isolated jj workspaces automatically retain committed changes
for Review, including later revisions. Unsaved edits are not captured. Existing chats, Ask,
direct checkouts and Git-only clones are not enrolled. Capture shares the existing retention
limit; pending or failed captures stay explicit, without deleting older comparisons.

Pilot monitors eligible agent-owned PRs for CI failures, review feedback, and conflicts.
Follow-ups are limited; unresolved problems return to you. Agents do not merge PRs.
Any supported app merge action requires your confirmation.

## Archive and restore

Archiving preserves the conversation, but generated outputs such as `node_modules`
and Rust `target` can be deleted immediately. Safe archived jj workspaces may later
be reclaimed and restored from saved snapshots. Dependencies may need reinstalling.

Track files you need to keep. Ignored files are not a general-purpose backup.
Reading archived history does not restore a workspace or start an agent.

## Temporary files

Agents should use `TMPDIR` (or the OS temporary-directory API) for temporary
images, downloads and verification output, then remove their own files. Keep
source and checkouts in the workspace. Publish artifacts that should stay with
the conversation using the artifact tool, not loose files beside session storage.

Hourly maintenance removes known abandoned UUID-named atomic-write files after
seven days. Session files are eligible only after seven archived days, with no
worker, pending work or live terminal, under the archive maintenance lock.
Saved artifacts, history, recovery data, databases, locks and operation receipts
are not temporary files. Unknown folders and legacy scratch need manual review.

Run `node scripts/storage-preview.ts [pilot-home]` for a read-only inventory of
old atomic-write files and unexpected session folders. Sizes are logical bytes,
not a promise of recoverable disk space. The preview never deletes anything and
does not establish that a session is safe to clean.
