# Day native daemon host

`apps/day/native/src/host.rs` is the trusted Today transport. It reads the real
daemon and uses its existing native capability for mission Pause and Resume.
The default `pnpm day run` entry still uses mock data. Nothing discovers, starts,
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
Decision/attention transport is separate and unavailable on this native Desk.

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

## Saved interviews and planning

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

```sh
pnpm install --frozen-lockfile
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo +1.99.1 test \
  --manifest-path apps/day/native/Cargo.toml -j 2
node --test --test-timeout=120000 --test-concurrency=2 \
  packages/daemon/src/mission-controls.test.ts \
  packages/daemon/src/project-dashboard-server.test.ts \
  packages/daemon/src/native-mission-planning.test.ts
node --test --test-timeout=120000 packages/daemon/src/interview-history.test.ts
pnpm typecheck
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
