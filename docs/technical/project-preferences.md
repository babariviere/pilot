# Small project preferences and context

Status: backend, agent tools and Day's Settings bridge/UI. No live data conversion,
provider call, app restart or activation is part of this change.

## Source of truth

- Mission records hold the live agreement, decisions, tasks and work.
- Knowledge holds durable project understanding with sources and scoped checks.
- Preferences hold small explicit user choices for one project. No global inheritance.
- Posthorse keeps working-context continuity, not another wiki or authority layer.

Mission-specific agreement takes precedence for that mission. Surface conflicts,
rather than infer consent. None of these records override runtime permissions,
safety, Stop, pause or budget controls. Legacy memory and original session history
remain untouched, with no copying, deletion, conversion or reset.

## Existing contracts reused

`ProjectPreferencesService` uses the supervised Knowledge IPC identity and the
existing project catalog. Its separate revisions table lives in `missions.sqlite`,
using MissionStore's transactions, asynchronous disk replica and durability barrier.
Preferences are not a Knowledge kind or settings/mission decision field. No GPUI
consumer changes are needed.

ProjectStore's general settings update has no preference history/operation receipts;
its automation/environment revision layers serve other purposes. Reusing that file
for these audited choices would add a second journal. Knowledge revisions already
provide the appropriate storage/durability pattern without misclassifying choices
as research or component documentation.

Only the current writable coordinator of an active same-project mission may write
through `project_preferences`. Admission rechecks the actual session/project,
membership, coordinator owner, owner/member event fence, input generation,
permission and mission control fence after I/O, immediately before CAS. The host
also checks the exact current worker and work controls. Bound planning profiles
allow only this scoped preferences surface and context reads, not generic Knowledge
writes. They recheck their trusted binding and hold before writing.

An agent write cites an existing same-mission **human-authored mission note event**
with an exact quote. New preference text must be in that quote. Agent-authored notes
and decisions do not establish human provenance. This first slice does not accept
transcript/interview locators or paraphrases. It refuses unsupported sources instead
of reconstructing consent. Literal provenance is necessary, not a semantic proof
that arbitrary quoted text is a preference. Coordinators must record explicit
project choices only, not wiki facts, task status or inferred policy.

## Typed contract

[`project-preferences.ts`](../../packages/protocol/src/project-preferences.ts) owns
the read, full-list write, source/author, history and operation types. Entry IDs are
client-chosen IDs, not array positions. Unchanged entries keep their original
source, author and time. Every successful edit appends an immutable full revision,
including the change's reason/source/author. Revision zero is the empty state.

Limits: 16 entries, 512 UTF-8 bytes per preference, 512 bytes per reason, 1024 bytes
per cited quote, 8 KiB per complete serialized revision including provenance. History
pages contain at most 20 revisions. History is not silently pruned.

- `GET /api/projects/:id/preferences`: current snapshot, passive and no-store.
- `PUT` same path: full-list `expectedRevision` CAS and explicit `operationId`.
  Requires the existing native app capability. Source/author are host-derived user
  provenance, never payload claims.
- `GET .../preferences/history?before=N&limit=20`: immutable newest-first history.
- `GET .../preferences/operations/:operationId`: exact committed receipt or Unknown.

The Day native bridge uses authenticated `POST /api/operations` with kind
`project-preferences-update`, target ID = project ID, and `ProjectPreferencesIntent`
as the exact payload. It journals the envelope before send. An accepted outer
receipt's result is the saved `ProjectPreferences` snapshot. Receipt lookup uses
the original exact envelope and the same capability. Entered handlers never run
again. A domain row alone cannot turn a missing/pending outer receipt into success.

Writes ACK only after disk durability. Concurrent/stale revisions and reused domain
operation IDs conflict (409). Validation/size failures refuse before commit. Missing
projects/sources fail honestly. After a lost ACK, **lookup only**. Unknown does not
prove failure and never permits an automatic replacement operation or resend.
Already-accepted native envelope duplicates return the saved outer receipt without
re-entering the write handler.

## Context loading

Project Build/coordinator prompts load a fresh `project_records` section through the
same supervised read seam. It carries all small preferences and at most eight linked
Knowledge revision summaries, with author/time, freshness, link revision and exact
pin versus current revision. Bodies/sources remain on-demand canonical reads. More
links are explicit; an empty linked index is not proof of an empty project catalog.
The existing mission section still carries agreement, relevant tasks and decisions.
Membership/project and record changes across read barriers fail instead of returning
obsolete context. Reads never observe/check Knowledge or change its state. Ask and
specialist profiles do not acquire a new broad project read or write capability.

## Day Settings

Day's header opens Settings (⌘,). Its one section shows the window's own project's
preferences: the project name, each preference with its source (added by you, or
recorded by a mission coordinator from your note, with the quoted words) and the
list's last change. Settings has no permission or provider controls.

- `day.preferences.read {}` reads the native root's project and its name. Reading
  sends nothing. A failed read says so and is never shown as an empty list.
- `day.preferences.save {projectId, expectedRevision, entries:[{id|null,text}]}`
  sends the whole list once. The root refuses a project other than its own, rechecks
  the revision, names new preferences, fixes the reason and journals the
  `project-preferences-update` envelope before the one POST.
- `day.preferences.check {operationId}` only looks up that saved envelope's receipt.
- `day.preferences.history {before?}` reads one page of saved revisions (at most 20,
  newest first, strictly older than `before`) for the root's project. It is read only:
  Settings shows who saved each revision, when, its reason, the quoted note and the
  list it saved, with no restore action. A failed read is not an empty history.

Edits form one draft that names its project and starting revision. Save and Revert
show only once the words differ from the saved list. Leaving Settings, closing or
updating keeps the draft in the window's saved view (`settings`, `preferences`).
A newer saved list never replaces typed text: the user keeps their version (then
saves) or uses the saved one. A draft for another project is kept, never saved
here, and discarded only on request. A lost answer stays Unknown and blocks another
Save until Check reads a receipt.
