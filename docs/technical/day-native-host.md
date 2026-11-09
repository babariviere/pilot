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

## Verification

```sh
pnpm install --frozen-lockfile
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo +1.99.1 test \
  --manifest-path apps/day/native/Cargo.toml -j 2
node --test --test-timeout=120000 --test-concurrency=2 \
  packages/daemon/src/mission-controls.test.ts \
  packages/daemon/src/project-dashboard-server.test.ts
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
