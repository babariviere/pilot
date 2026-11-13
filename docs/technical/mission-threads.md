# Focused mission discussions

Backend API for the approved focused coordinator threads. The native screen is separate work.
There is no pre-mission thread, second transcript, new chat engine or task tracker.

## Records and reads

`MissionStore.threads` saves small mission-owned topic records: stable ID, title, original
coordinator session, native user operation attribution, revision, references, input intents and
`open | later | discarded` disposition. Disposition changes are reversible. They do not archive,
Stop, pause, decide, accept an agreement, approve or Start anything. Immutable operation results
keep prior metadata and dispositions. Original history and referenced evidence are never removed.

Authenticated routes (the existing native app capability, `x-pilot-github-capability`):

- `GET /api/projects/:projectId/missions/:missionId/threads` returns `MissionThreadsView`.
- `GET /api/projects/:projectId/missions/:missionId/threads/:topicId/history?before=N&limit=N`
  reads the original coordinator history without opening or subscribing to its worker. Default
  limit is 32, maximum 100. Entries keep original IDs, roles and payloads. This is explicitly
  **coordinator history**, not a topic-only transcript. Only exact referenced entries and saved
  input operation identities belong to a topic; unrelated assistant output is not silently
  attributed to whichever topic the UI has open.

Reads require the current active mission, same-project current coordinator and membership, and
valid project/session access. History also checks the original coordinator's project. Historical
topics keep their original session when ownership changes; they never retarget a draft or send.
History rechecks sources after I/O. Holds do not prevent passive reads. Unavailable access refuses
instead of returning an apparently empty history. SQLite durability precedes responses.

`hello.capabilities.nativeThreads === 1` advertises the API, not permission to send to every
coordinator. `discussion.available` is a current preview, never a reservation or admission ACK.
The first version is host-local metadata, not a new cross-host replication protocol.

## Exact human operations

Use the existing authenticated `POST /api/operations` and `/api/operations/receipt` with the full
original `DurableOperation`. `targetId` is the mission ID. Use the read's opaque `source` for both
`bindingId` and `payload.source`, with `bindingGeneration: 1`. Payloads are `MissionThreadWrite`
in `packages/protocol/src/mission-thread.ts`:

| purpose | Other payload fields |
| --- | --- |
| `thread-create` | `topicId` (new caller-chosen stable ID), `title` |
| `thread-disposition` | `topicId`, `disposition` (`open`, `later`, `discarded`) |
| `thread-reference` | `topicId`, `reference` (canonical task/decision ID or original session/entry ID) |
| `thread-send` | `topicId`, `text` (exact bytes, no trimming or replacement) |

Unknown fields refuse. References must exist in this mission or the topic's original history.
At most 100 topics, 100 references per topic, 2048 metadata events per mission and 32000 UTF-8
bytes per send are supported. Existing journal, planning-call and kernel receipt capacities also
apply. A full store refuses; nothing silently pages away or deletes evidence.

Metadata writes and input intents are durable before ACK or dispatch. Source fences include
canonical mission revisions, task/decision/owner/membership events, controls, project/session
identity and topic revisions. The final asynchronous admission guard checks these again inside
the kernel input transaction. Concurrent source changes refuse or remain Unknown after entry.

`thread-send` has a distinct trusted planning/discussion purpose. It reuses qualified Revisit
admission only for an existing **published, idle, active, unheld, unstopped enrolled planning
coordinator**, with the topic still open and owned by that exact session. The normal planning
profile and trusted skills remain in force. Discussion asks for clarification, not implementation.
There is no generic Build/sendNotice fallback, legacy adoption, automatic wake, task Start,
agreement acceptance, new approval or permission grant. Held/paused/stopped planners refuse;
neither the host nor kernel clears a hold for discussion. A fresh input generation after Stop
cannot use this first-version admission path.

## Unknown and client drafts

Accepted send results include the saved topic and exact planning admission ID. A saved
`topic.inputs` item alone is an **intent**, not proof of admission, completion or acceptance.
After a lost ACK, keep the exact draft, topic, target and full operation envelope. Check only the
original operation. Recovery reads the original canonical metadata effect and kernel input
receipt; it never resends, creates a replacement operation or re-enters planning. Missing evidence
stays Unknown, even if that prevents another discussion until resolved. Terminal duplicates return
their original result, not the topic's later state. Reads and receipt checks requalify access.

Tests use canonical temporary SQLite/journals and fake sessions, with no provider, native window
or live profile effects: `mission-threads.test.ts`, the shared `published-planning.fixture.ts`,
`revisit-planning.test.ts` and selected `planning-boundary.test.ts` cases. UI integration and native
acceptance are not established by these backend checks.
