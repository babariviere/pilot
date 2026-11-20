# Project memory and knowledge

## Pilot Day

Open Settings (⌘,), then **Knowledge → Open library** for the selected project.
Search its saved entries, inspect sources and revision history, or read historical
memory ranges. Old notes and summaries can be stale; new shared understanding
belongs in Knowledge. The daemon no longer starts the shared-note AI summarizer.

**Edit this revision** prepares an unsaved correction. Give a reason and select
**Save new revision** to append it. Earlier revisions and sources stay readable.
Drafts keep their project and base revision across navigation and close. A changed
base needs explicit reconciliation. An uncertain save offers **Check save**, which
only looks up that operation. It never sends the edit again.

Preferences and their sources/history remain in Settings. Preferences are explicit
choices, not permissions. Opening either section does not start AI maintenance,
approve a finding, grant access or change spending limits.

## Small project preferences

Project coordinators can record small explicit user choices with a cited user note.
These choices belong only to that project. They are not wiki facts, global defaults
or permissions. Changes keep their source and revision history; stale edits fail
instead of replacing newer choices. In Pilot Day, open Settings (⌘,) → **Project** to read, edit,
add or remove this project's preferences; nothing is saved until you press Save.

Mission records hold current agreement and work. Knowledge holds sourced project
understanding. Posthorse keeps working context. Existing memory and history are
unchanged. See the [backend contract](../packages/daemon/src/projects/project-preferences.md) for limits.

## Memory

Open **Memory…** from a project's Overview to browse stored notes and summary ranges.
The window is read-only: text is selectable, but editing and forgetting are not offered.

Its case-sensitive literal filter searches only text already loaded in the current
range. It does not search unopened notes or the entire project, and typing does not
issue more reads.

## Knowledge

Open **Knowledge…** from Project Overview to read registered research and component
documentation. Entries include Markdown bodies and cited sources; corrections create
new revisions rather than silently replacing the original.

Agents in writable project chats maintain entries. Coordinators can link them to a
mission, where Mission Overview lists them. Archiving or deleting that mission does
not delete the project's knowledge.

**Needs a check** means relevant changes may have made an entry stale. Saving an
entry is not verification; writers explicitly observe sources and record scoped
checks. A check has limited coverage, not a guarantee that every claim is current.

Opening or refreshing these windows does not start an agent or write repository
documentation automatically.
