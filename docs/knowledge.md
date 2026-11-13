# Project memory and knowledge

## Small project preferences

Project coordinators can record small explicit user choices with a cited user note.
These choices belong only to that project. They are not wiki facts, global defaults
or permissions. Changes keep their source and revision history; stale edits fail
instead of replacing newer choices. Day Settings support is a separate UI slice.

Mission records hold current agreement and work. Knowledge holds sourced project
understanding. Posthorse keeps working context. Existing memory and history are
unchanged. See the [backend contract](technical/project-preferences.md) for limits.

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
