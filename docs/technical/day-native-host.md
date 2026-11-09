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

`write_interview(mission, contextDigest, InterviewWrite)` accepts only `interview-save` and
`interview-submit`. It rechecks the exact displayed interview CAS and complete context, fsyncs the
entire native-created `DurableOperation`, checks again, then uses the existing `/api/operations`
endpoint. Native capability authentication and current owner/project checks guard both execution
and `/api/operations/receipt`. The existing `MissionInterviews`, `OperationJournal` and
`missions.sqlite` transaction/replica remain the only backend effect owners. Human saves preserve
exact option meanings/text. Proposal approval is an answer in the existing exact review round,
followed by complete submission, not a new approval API. None of these operations starts work.

`planning_operations(mission)` exposes only operation summaries; envelopes and credentials stay
in Rust. `check_planning(operationId)` resolves the retained exact envelope by passive lookup.
Cold open never resends, even if a crash preceded POST. Unavailable/missing/mismatched receipts
remain Unknown. A matched terminal ACK is kept if later lookup fails. Joined native close covers
entered planning HTTP and receipt/journal writes as well as Today controls.

### Remaining bootstrap and execution gaps

- The mock CLI entry remains unchanged. Native bootstrap still must pass the selected, root-owned
  host to the Day feeds and join it before replacement/quit. UI mapping belongs to the interview UI.
- Fresh creation requires a trusted enrollment adapter which creates a new coordinator already held
  at the interview boundary. No such production adapter is installed. Mission existence, legacy
  `planningVersion`, a caller actor label or a native bearer alone cannot enroll an existing mission.
- Kernel `missionPlanning`/`missionInterview` options already load the actual pinned upstream skills,
  not imitation prompts, but no worker IPC/profile/hold binding currently supplies those options.
  The status says `coordinatorProfile: not-configured`; this ingress does not start a generic worker.
- A qualified continuation adapter is absent. It must durably dedupe the exact submitted intent and
  pass allocation/coordinator, permission/model, Stop/pause, review and lifecycle gates at actual
  guarded admission. Continuation/admission remain unavailable rather than fall back to a message.
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
remain regression gates. Fixtures create records directly only as trusted test setup; they never prove
that the missing production enrollment or worker admission adapters exist.
