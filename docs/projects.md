# Projects and Today

Add a repository in **Settings → Local projects**. See [Add a local project](workspaces.md#add-a-local-project-in-day)
for source-copy and import options. Registering a project does not start work. In **New**, choose the project
for that draft explicitly.

**Today** shows attention, working chats and missions across projects. Its filter does not change the project
of your drafts. **Search** (⌘K) finds saved chats, missions, results, artifacts and Knowledge across projects.
Reading a result or chat starts nothing. Go Back to return to your earlier place and draft.

## Historical Pilot Next navigation

The following controls describe Pilot Next, not Day. For kept private working copies and archive behavior,
see [archive and restore](workspaces.md#archive-and-restore).

Add a local repository from the sidebar's project selector with **Add project…**.
Registration does not start a chat or change a draft's destination. Select the
project explicitly when creating work.

- **Home** summarizes work across projects.
- **Inbox** collects work needing attention, ready pull requests, and tracked
  Slack and Linear items. Filter it to a project when needed.
- **Project Overview** brings together that project's work, missions, and related information.

Chats show whether they are working, paused, or need you. Read the reason before
acting: a question, failed run, usage hold, and unmerged work need different responses.
Background jobs can keep a chat working after its agent finishes a reply.

Use a chat's row menu to rename, pin, archive, or restore it. **Archive** in the
project selector lets you search archived chats and read their saved history.
Reading archived history does not restore the chat or start work.

Archiving is not a workspace backup. Eligible private workspace files are permanently
discarded, without a recovery snapshot. History and published artifacts stay available.
See [archive and restore](workspaces.md#archive-and-restore).

New private coding copies started through Day's durable start path are an exception: Pilot
keeps their files, including build outputs and leftovers, through recovery and required review.
Recovery also protects an older private copy when you explicitly retry it in Day. This protection
survives reversible archive, restore, provider continuation and service restart. Final archive and
its cleanup remain unavailable until saved delivery and required reviews can be verified. Idle
unloading releases the agent process after about ten minutes, not its saved state or files.

On macOS, use **⌘K** to find destinations and available actions, **⌘L** to focus
the composer, and **⌘,** for Settings.

## Code outside the project

Agents can read, but not change, two kinds of code outside the project:

- **Dependencies.** The exact versions your `go.mod`, `Cargo.lock` or package lock pins, from your local
  Go, Cargo and `node_modules` caches. Nothing to set up; a dependency that is not downloaded is not offered.
- **Linked projects.** In **Settings → Projects**, open **Also reads** under a project and tick other Pilot
  projects. That project's agents can then read their main branch. Untick to stop.
