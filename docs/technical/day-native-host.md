# Day native daemon host

`apps/day/native/src/host.rs` is the trusted Today transport. It reads the real
daemon and uses its existing native capability for mission Pause and Resume.
The default `apps/day/nsh.sh run` entry still uses mock data. Nothing discovers, starts,
registers, updates or restarts the user's daemon. No live controls were exercised.

## Native boundary

The native owner supplies a `Source`: exact profile directory, loopback port,
daemon/lineage pair, selected project ID and project path. There is no environment,
cwd, cached-home, replica or coordinator fallback. Changing selection means closing
and joining the old `NativeHost`, then opening a new one. Their Desks and callbacks
are separate. The owner must await `NativeHost::close()` before safe app close or
profile replacement. Closing fences new intents immediately and joins entered
HTTP work, the WS task, journal and worker. It never Stops or resumes agents.

`TodayFeed::from_host(host)` is a Rust-only factory under the root NSH owner.
It uses the same typed snapshot/listener and Pause/Resume/Check boundary as the
mock feed. It does not export selection, HTTP, paths, credentials or arbitrary
requests to TSX. Native navigation calls `host.read_mission(id)` to fetch exact
detail, and `host.refresh()` is passive. The eventual native bootstrap must pass
this feed into the screen; the CLI mock constructor is deliberately unchanged.
Attention has a separate Rust-only transport below. `TodayFeed::from_host` projects it into the
decision and action cards ([attention cards](#attention-cards)).

The shared `apps/native-daemon/credentials.rs` reader is the existing Local
private-file contract, used by GPUI's scoped actions and Day. It checks the daemon
and lineage in `github-app-capability`, ownership, private permissions, file kind,
size and no-follow open. Tokens stay in Rust, in sensitive request headers only.
HTTP is loopback-only, no proxy, redirects, retries or alternate-host fallback.
Hello requires protocol compatibility, independent execution and `dayOverview: 1`.
Controls additionally require `missionControls: 1`. Missing capabilities do not
become an empty inventory or enable a fallback mutation.

## Reads

Authoritative GETs supply `DayOverview` and exact mission detail. The selected
project, coordinator and identity are checked again after async work. WS frames
only invalidate. They never populate the Desk, confirm a command or establish
durability. One bounded invalidation slot coalesces bursts; a generation check
discards a read raced by a newer frame. Only the selected detail is refreshed.
WS disconnect keeps the last read, disables controls and requires explicit native
reopen to reconnect. There is no polling loop.

Freshness is explicit: cached (saved, not checked), stale (invalidated or stream
disconnected), offline (transport loss), unavailable (identity, capability,
protocol, storage or shape failure), and live. Legacy unreadable remains supported.
Cached reads are pinned to the entire Source and never restore execution authority.
The cache is private, byte-limited and replaced atomically after file sync.

## Controls and recovery

One native worker serializes commands. Each new explicit intent binds the shown
revision, exact project/home/coordinator, a fresh operation UUID, and, for Resume,
the exact Pause UUID. It checks current detail and controls, saves the entire
command in a private append-only journal, calls `sync_all`, then repeats authority
checks before the single POST. The daemon's own CAS and owner/membership fences
remain the final admission guard. Stop and independent holds are never cleared
by the native host; the real daemon selectively resumes its Pause-owned members.

The journal has an exclusive writer lock, a 16,384-operation limit and a 64 MiB
byte limit. It refuses capacity, partial/corrupt records and write/sync failures;
it never evicts, truncates, repairs or resends uncertain records. File replacement,
hardlinks and unexpected length changes refuse further writes. Exact receipts
are saved before accepted delivery is projected. A receipt-save failure keeps
the exact volatile receipt and Unknown, with a storage failure on safe close.

Cold open restores pending records as Unknown. It never POSTs historical work,
even if the crash could have happened before POST. Check only GETs the saved
mission/operation path. The entire command, home, project, revision, action,
Pause ID and receipt identity must match. Absent, entered, mismatched or unreadable
receipts remain Unknown. Current controls or WS activity cannot settle them.
Acknowledged receipts are historical, not proof of current control authority.

## Attention transport

`host/attention.rs` uses the same native worker, Source, capability reader, close fence and journal.
Rust-only `read_attention` calls authenticated `POST /api/native-attention` with an exact version,
local home and project. This POST is a passive read, not completion or admission. The daemon checks
the current project, writable origin chat, membership, Stop generation, configuration and mission
control fence. Ordinary questions come from the passive current kernel boundary, not a historical
transcript search. Stopped, replaced, answered and database-access questions cannot become choices.
Question scope carries the backend's exact entry/event/content/authority identity.

`send_attention` accepts only native action progress/defer/resume/completion, ordinary question
answer, help, or one exact destination. Rust assigns operation IDs, pins the complete envelope,
syncs it in the existing ledger, rereads authority, then sends once. Human-action state and receipts
use `AttentionService` and the original SQLite tables, not a second attention DB. Ordinary answers
use `attention-answer` in the existing OperationJournal and the kernel's exact questionReplyId and
inputGeneration admission. Re-entry can only look up an already accepted input. It never sends it
again, clears Stop, restores a hold or treats a prior answer as current approval.

`save_attention_draft(DraftKey, value)` saves exact draft JSON locally under source, kind, item ID,
revision and content digest. Saving/navigation never answers or completes anything. Old revisions
stay readable as history and cannot select a current option. Drafts have a 16 KiB byte limit. The
shared native ledger allows at most 4,096 attention draft/intent locations; the daemon separately
allows 4,096 combined help/operation records. Both refuse capacity explicitly, without eviction.
The existing 64 MiB total journal limit still applies. No file repair or cleanup is automatic.
The daemon rejects action inventories above 8 MiB before JSON hydration; it never truncates a feed.

`check_attention` uses only the exact saved intent and authenticated receipt lookup, even on cold
recovery or after a request failed before reaching the daemon. Missing, entered and mismatched
receipts stay Unknown; a terminal matched ACK cannot be erased by a later failed lookup. Drafts,
pending intents and exact receipts restore on native reopen. Operation summaries contain historical
receipts, not current authority. WS only invalidates; it cannot settle any operation.

Action resources are checked off the daemon event loop with limited file reads. Local files must be
inside the origin's current workspace, with no symlink traversal below that selected root. Reads pin
a descriptor, size, inode, timestamps and SHA-256, and reject replacement. The 64 MiB per-file limit
refuses larger files rather than truncating them. Visual artifacts use exact committed numbered JSON
bytes and SHA-256, never a latest substitute or rendered source. Destination/package labels describe
the requested target, not verified remote publication. No network check, download or upload occurs.

Native navigation requires a root-owned `UrlOpener` supplied through `open_with_navigation`. Screen
code cannot install one or name an arbitrary URL. The daemon rechecks the exact action, authority and
resources and returns only its pinned HTTPS destination; Rust invokes the opener once. Its saved
receipt proves authorization only, not OS navigation, upload or publication. Navigation outcome is
explicitly Unknown in historical summaries, and checking/reopening never opens the URL again. The
default host has no opener and reports `canOpenUrl: false`.

Help execution and dependent-work continuation are separate qualification ports. The server installs
neither, advertises both as unavailable and never fabricates help. `completion` returns an exact,
current, durable **user-report** receipt only after resources and authority pass again. It grants no
new authority and dispatches nothing. Opening/downloading, Later, saved drafts/progress and agent
prose cannot produce that receipt; even a completed report is not verified publication.

### Attention cards

`native/src/attention_host.rs` maps the attention read to Today's cards with pure functions, and
`attention_feed.rs` binds them to `TodayFeed::from_host`. An agent's ordinary question becomes a
decision card (`question-<session>-<entry>`, revision 1, since an entry never changes) that takes a
pick, the user's own words or both, sent once as the chat composers do (label, blank line, words).
Nothing is preselected for it: a suggestion is not an answer. A human action keeps the record's
revision. Requests are built from the latest host read and name the revision the screen showed; the
host rechecks authority before and after its fsync, as above.

A question whose `multiSelect` is set and that offers more than one option becomes a card that takes
several picks (`Decision.multiple`). Its draft keeps every pick (`picks`) and the exact words, and the
answer sends every picked label as `- label` lines in the order shown, then a blank line and the words,
as the GPUI and Swift composers do. One pick is sent as its label alone. A question that takes one
refuses several picks, and a pick that names no option refuses the whole answer; nothing is sent. An
unconfirmed answer shows the options it sent (`sentOptions`) after a restart, read from the saved
request; Check only looks it up.

- Drafts (pick, own words, help question, action notes) go to `save_attention_draft` under the exact
  draft key. The feed saves after a short pause or on `flushDrafts`, one at a time, so the ledger
  grows slowly. `TodayFeed::close` (Rust only) queues unsaved drafts before the close fence; the host
  writes queued drafts during its joined drain. A failed save stays on screen, marked unsaved.
- The user's own Later on an action is a new revision: the feed moves the draft to it. A revision the
  agent made leaves the old draft as read-only history (`earlierReport`), which counts only once sent.
  Later on a question is saved with that question's draft (`later`) under its exact key, so the
  question stays after the others across a restart. It is Day's own ordering: nothing is sent, the
  daemon and the agent are not told, and the chat still waits for an answer. A draft save that does
  not say Later keeps it; only a sent and accepted answer clears the draft. Questions put off before
  this run come before the ones put off in it.
- Only an acknowledged receipt is success. A question with an accepted answer leaves the cards; a
  report adds a note that says Pilot has not checked the result. A lost answer or report stays
  Unknown, including after its question leaves the read or after restart; Check only looks it up.
- Help stays unavailable while the daemon reports it so: the card says it once, and its keys and
  intents send nothing. `openLink` needs the root's opener and reports nothing. A navigation request
  never blocks the user's own report, since it changes no record and has no receipt to look up.
- The attention read has its own freshness (`Today.attention`). The host reads it again on every
  authoritative refresh once a feed asked for it. A failed or unsupported read is unavailable, never
  an empty list, and attention errors no longer mark the missions' read stale.

`native/tests/attention_feed.rs` drives the feed headlessly against the isolated daemon: drafts across
safe close, restart and an agent's replacement, the user's Later, stale and exact completion, a lost
completion settled only by lookup, an unconfirmed answer that is never resent, unavailable help and a
permission-checked link that leaves the action pending. It also covers a question that takes several:
picks changed and unpicked, a saved Later and the exact words across restarts, an earlier revision and
an unknown option that send nothing, the exact several-pick message, and a lost answer that only a
lookup checks. Continuation after a report and a help producer remain absent.

Hidden tests exercise the real daemon/router, private native capability, SQLite, HTTP transport and
native ledger, with synthetic current-question/input ports and no providers or real navigation.
Kernel tests separately verify current question/Stop admission and cold-reader exclusion. Coverage
includes stale/revoked identities, resources, capacity, draft/receipt restart, lost ACK, mismatches,
lookup-only uncertainty, explicit unavailable help/continuation, and close joining entered I/O.
These are transport checks, not card/native hardware, keyboard/IME or production provider acceptance.

## Saved interviews and planning

`read_planning_inventory()` uses authenticated `GET /api/projects/:project/planning-inventory`
on the existing worker. It reads active planning-version-1 missions from the existing SQLite
mission/interview/plan records, including missions not opened by this app. Each row has its mission
ID, title, stage, needs-you state, full current interview fence, interview revision and nullable plan
revision. No answers, histories, credentials, receipts or action authority enter the inventory.
The fixed 100-mission limit reads one extra sentinel; overflow is 503, never a successful first page.
Only this authenticated route's version-1 `planning_inventory_capacity` error, with the selected
project and limit 100, maps to the native `capacity` refusal through `day.plan.inventory`.
Other 503s and authentication failures stay unavailable. A refused read clears the cached list;
`day.plan.inventorySnapshot` never presents old or partial rows as a current empty inventory.
A valid empty project returns `status: available`, `total: 0`. Missing service/authentication,
unqualified or revoked owners, changed project/context and storage errors refuse the entire read.
The daemon pins and rechecks every owner/project/round across durability, including the empty-list
barrier. It writes no records, starts no worker and requests no continuation.

`planning_inventory_snapshot()` maps only a current, complete read to `Planning`/`PlanRow`.
`PlanFeed::from_host` uses it instead of listing only its selected mission. Inventory errors are
isolated from Today controls; unavailable is not a live empty list. Once requested, WS changes
invalidate the list and trigger a fresh authenticated GET on the same worker. Events never supply
rows or settle effects. The released JSON boundary exposes the same passive read as
`day.plan.inventory` with no arguments. TSX Today wiring is separate.

Passive mission-detail reads also requalify once after a concurrent WS invalidation, fetching all
gates, overview and detail again. Further races still refuse; project and overview/detail owner
mismatches stay fail closed. Controls, saves and continuation never use this passive retry.

The same `NativeHost` worker and private command ledger now carry saved interview actions.
`read_planning(mission)` uses authenticated `GET /api/projects/:project/missions/:mission/planning`.
It returns the existing `MissionPlans.view`, including the complete proposal spec, testing decisions,
slices, dependencies, ownership, frontier, fog, sources and saved interview. It never substitutes a
digest for the proposal. Native memory keeps only the selected complete read; SQLite owns drafts.
`questionDigests` supplies the backend's exact digest per displayed question. Do not recompute it
with a UI serializer, whose key order may differ. After a matched acknowledgement, the host passively
rereads saved progress; a failed/raced read cannot erase the historical receipt.

The daemon checks current project, coordinator membership/owner event fences, session mode and
configuration, decisions, brief and complete planning revision across async reads. A context digest
binds that evidence. A legacy/non-enrolled mission returns `status: not-enrolled`, `view: null` and
explicit unavailable capabilities. This differs from an enrolled interview with no map yet.

`view.interviewHistory` lists every original submitted snapshot in SQLite append order, including
the latest submission. Each entry contains the complete `interview` at submission (revision,
owner fence, enrollment/question/answer revisions, exact questions, option meanings, custom text,
submission operation/digest and brief revision). Its `plan` is the immutable snapshot that opened
that question set through the same operation, or `null` for an initial interview without one.
It is not today's plan. No new store, migration or guessed historical context is used.
The same current owner/project checks and durability barrier protect history. An empty list means
no submissions; failed authorization, storage or a missing history field is unavailable, not empty.
The native mapper fills the existing read-only `RoundLine` list in that order. History never supplies
the current interview, intent, review approval, worker hold or continuation authority.

`write_interview(mission, contextDigest, InterviewWrite)` accepts only `interview-save` and
`interview-submit`. It rechecks the exact displayed interview CAS and complete context, fsyncs the
entire native-created `DurableOperation`, checks again, then uses the existing `/api/operations`
endpoint. Native capability authentication and current owner/project checks guard both execution
and `/api/operations/receipt`. The existing `MissionInterviews`, `OperationJournal` and
`missions.sqlite` transaction/replica remain the only backend effect owners. Human saves preserve
exact option meanings/text. Proposal approval is an answer in the existing exact review round,
followed by complete submission, not a new approval API. Saves never start work. For an explicitly
enrolled new planning owner, final complete submission can request one guarded **planning-only**
continuation through the [worker binding](day-mission-planning.md#worker-enrollment-and-return-boundary).
It is not workflow approval or builder admission.

`planning_operations(mission)` exposes only operation summaries; envelopes and credentials stay
in Rust. `check_planning(operationId)` resolves the retained exact envelope by passive lookup.
Cold open never resends, even if a crash preceded POST. Unavailable/missing/mismatched receipts
remain Unknown. A matched terminal ACK is kept if later lookup fails. Joined native close covers
entered planning HTTP and receipt/journal writes as well as Today controls.

### New interview creation

`NativeHost::open_planning(source, ledger, model)` is a Rust-only, explicit native selection.
It does not enable a profile, discover a user's home or adopt an existing chat. Ordinary
`NativeHost::open` has no creation model and cannot enroll. Changing the source or model requires
closing and joining the old host, not changing a VM field.

`prepare_planning()` reads authenticated `GET /api/projects/:project/planning-profile` and checks
the selected project, home and capability again after the asynchronous probes. The backend's
`configurationDigest` and complete profile value are kept, not rebuilt from a native constant or
rehashed to substitute for the backend digest. A prepared setup pins that response, the model,
source, purpose and fresh enrollment/owner UUIDs. Its opaque digest is all TSX can name, alongside
the user's exact goal. Missing configuration or authority leaves `planning_setup()` unavailable.
Discovery is passive: it creates no daemon record, worker or provider request.

`enroll_planning(NewIntent)` builds the existing `PlanningEnrollment` request and a native-created
`DurableOperation` with kind `planning-enroll`. It checks the profile, fsyncs the whole pending intent
in the same native ledger, then checks the profile/authority again before one `/api/operations` POST.
The daemon's `PlanningWorkers` remains the only enrollment/admission owner. The goal is kept byte
for byte; only the display title is shortened to the backend's UTF-8 byte limit. Caller-supplied
owner/session/enrollment IDs and existing-chat adoption are not part of this API.

One shown setup is consumed once. Repeated identical intents return only the saved outcome;
different goal text against a consumed setup is stale. A later passive prepare can make a new
identity after a settled outcome, but cannot replace an uncertain intent. Lost ACKs, crashes before
POST, missing receipts and mismatched results remain Unknown. Recovery uses the retained exact
envelope at `/api/operations/receipt`, never historical enrollment POSTs. Accepted receipts must
match the payload hash, destination, operation, enrollment and fresh owner, and name a mission.

`PlanFeed::from_host` begins passive discovery. Its typed `prepareNew()` and `checkNew()` methods
prepare a later New screen or check uncertain creation without resending. `plan(NewIntent)` now
binds to native enrollment and selects the acknowledged mission. `canCreate` means mission creation
only; separate `canStart: false` and `startReason` describe the still-absent standalone-chat adapter.
The native `start` method refuses independently. No TSX screen or live bootstrap is activated here.

An acknowledged mission may still have `status: preparing`, `view: null` and no context digest.
That is not an empty completed interview: no answers or submission can be built from it. Coalesced
WS invalidations trigger authenticated reads of the selected planning page, so the full saved round
can replace preparing. Event bodies never supply questions or settle the creation receipt. Joined
host close covers entered enrollment HTTP and ledger work without stopping the daemon's agents.

### Remaining bootstrap and execution gaps

- The mock CLI entry remains unchanged. Native bootstrap still must pass the selected, root-owned
  host to the Day feeds and join it before replacement/quit. `PlanFeed::from_host` maps planning reads
  and builds exact `InterviewWrite` requests (`apps/day/native/src/plan_host.rs`); it never closes the host.
- `PlanningWorkers` implements creation-only enrollment, trusted kernel profile/IPC, saved round
  holds and exact planning-only continuation. Native New is now typed and journaled, but the CLI
  remains mock-only and no live bootstrap selects a creation model. The planning-read field
  `enrollment: unavailable` cannot enroll an existing mission; the prepared native setup governs New.
  Mission existence, legacy `planningVersion`, an actor label or a native bearer alone cannot adopt
  an existing chat or mission.
- Existing flows retain unavailable profile/continuation status. Only an exact new-flow binding
  reports `coordinatorProfile: 1`, `continuation: 1` and its saved phase/continuation operation ID.
  Stop, pause or unavailable authority leaves those capabilities unavailable. No generic send fallback
  is used. An empty bootstrap reports `preparing` and cannot be answered or submitted.
- Agreement/build and small-ask admission adapters remain absent. Submission cannot bypass their
  independent approval, assignment, permission/model, review, budget or lifecycle gates.
- Trusted coordinator map/proposal/publication writes are not human native operations. Published-task
  amendments remain refused by the existing service; no amendment adapter is added.

These are explicit integration gaps, not native production acceptance. There is no live enrollment,
provider run, automation activation, app/service restart, release, default switch or legacy removal.

## Verification

### Retained Changes

`ChangesFeed::from_host` is native-only and runs under the root owner. The bootstrap
owns the shared host and must join `close`; dropping this feed cancels only its
listener task. The mock constructor and default CLI remain unchanged.

`host/changes.rs` uses the existing project review inventory, session
`review?view=changes&expectedProjectId=…&after=…`, per-session review requests,
exact `/:snapshotId/history` and `/patch`. It follows every cursor to null before
publishing, including when later pages contain the newest snapshots. Bounds are
100 chats, 100 combined feed/request pages, 2,000 rows per kind and 8 MiB of metadata.
An exceeded limit is Unavailable with `more: true`, not a complete partial feed.
An unavailable source is distinct from an available empty project. One exact
reopened page stays in native memory; history pagination remains explicitly marked.

Reads recheck project inventory, immutable native selection/capability and generation
after asynchronous work. Reopen checks the backend's original comparison digest,
snapshot/session/project and retained patch hash without BOM decoding or newline
normalization. The existing projection keeps unknown/unavailable source states.
Reopening is passive, never a live fallback, capture, approval or feedback write.

Later/Bring back require the displayed request revision and a matching fresh history.
The native worker saves the exact command/target and fsyncs before admission, repeats
source/identity/CAS checks, then enters one snooze/resume POST with the existing native
capability. Receipts must match native actor, operation, canonical payload hash, request,
revision, state and exact target. Lost replies remain Unknown. Restart restores only
uncertainty; recovery uses the saved operation GET, never a historical resend or a
latest-state inference. A terminal receipt is history, not a new currentness grant.
All entered I/O and journal work belongs to the existing joined host worker.

`native/tests/changes_host.rs` uses the isolated real daemon/retained store in
`packages/daemon/src/fixtures/day-native-changes.ts`. It covers multiple sessions and
pages, exact Unicode/CRLF bytes, Later/Bring back CAS, lost ACK and daemon/native restart,
missing/mismatched lookups, source/identity/capability revocation during reads and after
journaling, incomplete feeds, unavailable versus empty, digest refusal and joined close.
No provider, worker, visible UI, live mutation, activation or service restart is involved.

`ChangesFeed::refresh` (and native `more`) queues one complete read. A refusal known at
once (closed host, stale generation, full queue) returns Stale or Rejected; otherwise the
answer is admission only and the list changes when the read ends. It sends nothing and
settles no Unknown operation. `native/tests/changes_feed.rs` drives the feed a root owner
builds with `from_host` under a headless root: the first read past the WS admission race,
Read again, unavailable and limited sources that never show rows, a revoked source during
reopen, the exact reopened snapshot, revision-fenced Later/Bring back, a lost answer that
stays Unknown through a re-read and reopen, lookup-only Check (whose receipt is not a
current read) and refusal after the bootstrap's joined close. The Changes screens show
Read again, the read limit and a snapshot that cannot show now. Native bootstrap
selection is still not built; this is not native screen acceptance or cutover permission.

```sh
pnpm install --frozen-lockfile
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo +1.99.1 test \
  --manifest-path apps/day/native/Cargo.toml -j 2
node --test --test-timeout=120000 --test-concurrency=2 \
  packages/daemon/src/mission-controls.test.ts \
  packages/daemon/src/project-dashboard-server.test.ts \
  packages/daemon/src/native-mission-planning.test.ts
node --test --test-timeout=120000 packages/daemon/src/interview-history.test.ts
apps/day/scripts/typecheck.sh
```

`native/tests/host.rs` starts a real isolated daemon through
`packages/daemon/src/fixtures/day-native-host.ts`, with a temporary profile and
faux participant adapters. Its loopback proxy injects transport faults and checks
the exact native command journal before forwarding POST. It covers source changes,
missing capabilities, stale reads/WS races, selective Resume/holds, Stop, lost ACK,
cold recovery, missing/mismatched receipt lookup, exclusive journal ownership,
storage failure and close while POST is entered. No real agents, providers or
user controls run. Native screen acceptance and live bootstrap integration remain
separate gates; these are native transport tests, not UI acceptance.

`native/tests/planning.rs` drives the real Rust host against an isolated production daemon with disk
SQLite and the actual operation journal. It checks exact drafts/restart, complete submission, lost ACK,
missing/mismatched exact lookup, cold-open no replay and joined close. The daemon ingress suite adds
authentication, project/home/owner/configuration fences, topic changes, complete proposal availability,
late authority loss and explicit legacy non-enrollment. Existing interview/planning/skill-loader suites
remain regression gates. The additional native worker journey uses production HTTP enrollment,
SessionManager and a real forked faux kernel, checks all-question completion and one continuation,
then joins host/daemon/kernel teardown. It is a hidden transport/lifecycle fixture, not a visible
screen test, real-provider generation or live activation.

`native/tests/enrollment.rs` starts from an unenrolled isolated daemon. A loopback fault proxy uses
the real Rust host/credential reader/ledger and a forked faux kernel. It checks passive discovery,
exact new enrollment, changed configuration/project/owner, post-journal rechecks, single-use setup,
preparing then the full round, Stop/Pause, lost ACK/result mismatch, restart/no resend and joined
teardown. The default mock CLI, standalone chat start and production native bootstrap stay separate.

`native/tests/plan_host.rs` also drives three rounds through the real native host and isolated daemon,
then reopens both. It checks exact retained history, independent active edits, chronological mapping,
old-review refusal, revoked-owner refusal, missing-versus-empty history and zero historical resends.
`interview-history.test.ts` checks the original submitted snapshots and opening topic/review context,
changed-proposal publication refusal and owner-membership ABA. These are hidden fixture checks, not
live enrollment, provider runs or native visual acceptance.
