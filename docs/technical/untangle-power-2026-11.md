# Power helper cleanup decisions, November 2026

## Status and scope

Initial read-only audit was followed by parent authorization for the pure decoder
and fake-only behavior characterization. Only that slice is implemented. CI,
packaging, state serialization and Swift differential acceptance remain unchanged.
This is an application binary (`publish = false`, edition 2024, Rust 1.98), not a
public Rust library. No new crate, framework, dependency or power policy is needed.

Read `CODING_STANDARDS.md`, the Rust best-practices and review skills,
`apps/power/PORTING.md`, the codebase/native cleanup logs, the power helper source,
daemon wire consumer and Linux qualification guidance. Repository simplicity and
behavior-preservation rules take precedence over generic library recommendations.

The smallest useful first change is a pure command decoder in the existing
`protocol.rs`. Keep platform dispatch, state reporting, timing and teardown separate.
Do not combine this with macOS lifetime changes or Swift fixture reorganization.

## Existing ownership boundaries

- `packages/daemon/src/power.ts` owns settings, work accounting, idle grace,
  durable preparation and recovery. Those decisions must not move into this helper.
- `packages/daemon/src/power-helper.ts:8–66` defines and validates the wire state.
  Linux capability fields are optional for macOS but required for KDE reports.
- `protocol.rs` owns limited NDJSON framing. `runtime.rs` is the macOS reactor,
  also compiled by tests on Linux. It is not an existing universal backend runtime.
- `macos.rs` owns IOKit sensors/assertions and a serial guardian/authorization worker.
  `guardian.rs` owns the independent override-restoration lease and recovery loop.
- `linux.rs` owns asynchronous KDE/logind connections, inhibition cookies and delay
  FDs. `serve` closes both connections even after errors from `serve_connected`.
- `apps/day/macos` still supplies pure Swift comparison fixtures and shared packaging
  helpers. This audit does not authorize deleting that directory or its consumers.

## Backend differences to preserve

| Concern              | macOS                                                                                                                                                       | Linux KDE Wayland                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Activity             | Idle-system assertion plus optional guardian-backed closed-lid override. Worker rechecks AC, Wi-Fi, sleep and stop state before the write.                  | Automatic session-interruption inhibition only; rejects `closedLid: true`. Cookie ownership does not prove active inhibition. |
| Authorization        | Fixed grant and explicit prompt through worker.                                                                                                             | Always replies false; no grant or prompt.                                                                                     |
| Sleep request        | Replies true without an operation for an active override or a lid not known closed; otherwise up to six lid-sleep attempts, 500ms apart.                    | Replies true without initiating sleep.                                                                                        |
| Sleep ACK            | Valid unsigned generation is passed to the one-shot native token owner; stale generation cannot consume a newer token.                                      | Valid unsigned generation replies true, but releases delay FD only while sleeping with matching generation.                   |
| Preparation fallback | Generation-bound five-second main-queue fallback, independent of blocking worker.                                                                           | Four-second delay-FD fallback, with logind's own outer limit.                                                                 |
| Heartbeat lease      | Five-second checks; expires only when elapsed heartbeat age is greater than 20 seconds at a check. Separate unsafe-lid cutoff despite continued heartbeats. | Resettable 20-second timer; no unsafe-lid override policy.                                                                    |
| Wake evidence        | Kernel wake time, display awake and graphics capability determine report.                                                                                   | Observed logind resume creates wake token; startup is never a later wake.                                                     |
| Network              | Native general connectivity and usable Wi-Fi paths; AC/lid sensors.                                                                                         | Optional NetworkManager state plus `networkKnown`; false AC/Wi-Fi and null lid are placeholders, not override evidence.       |
| Availability         | Sensor availability is masked until guardian readiness.                                                                                                     | Requires active local KDE Wayland and required service APIs; owner/session/bus loss fails closed.                             |
| State report         | Typed `runtime::Sample`, no KDE extension keys, duplicate reports coalesced.                                                                                | JSON with `backend`, `inhibitionActive`, `networkKnown`, `qualification: unqualified`; duplicate reports coalesced.           |
| Output errors        | Runtime report/reply writes are best effort.                                                                                                                | Output errors propagate and cause connection cleanup.                                                                         |
| Input line size      | Monitor accepts 8192; guardian accepts 4096, both with 8192 accumulated-frame limit.                                                                        | Input line limit 4096, accumulated-frame limit 8192.                                                                          |

Do not normalize these differences as incidental duplication. In particular, a
shared reply helper must not discard Linux write errors, and a common lease must
not silently change either expiry boundary. No Linux display/idle/logind block
inhibitor or macOS policy change belongs in this cleanup.

### Input behavior is not fully identical

`runtime.rs:169–210` and `linux.rs:153–183` repeat action/ID/boolean/generation
inspection. Both accept a heartbeat without an ID and do not reply to it. Both
require signed 64-bit request IDs, actual JSON booleans for activity, and unsigned
64-bit generations. Unknown string actions with valid IDs reply false. Extra fields
are ignored. Invalid activity fields or generations reply false without shutting down.

There is one important malformed-input difference: macOS shuts down for a missing
or non-string action, even if the ID is valid. Linux replies false and continues
when that frame has a valid ID. Without a valid ID, both stop. Invalid JSON,
truncated/oversized frames and EOF stop input processing. These are existing
semantics, not proposed improvements. Keep them even though the daemon sends valid
commands. Do not replace the parser with strict derived deserialization that rejects
unknown fields, coerces values or turns all decode errors into shutdown.

## Selected first slice, authorized

### Pure command decoding

**Rule:** `CODING_STANDARDS.md` simplicity; Rust best practices sections 1, 4 and 11
(concrete application types, preserve quirks, test behavior).

Add one private decoder beside the existing framing implementation. Return typed
valid commands, a recoverable invalid request carrying its ID, and distinguish
missing/non-string action from missing ID. For example, the outer result can be
`Heartbeat`, `Request { id, command }`, `MissingAction { id: Option<i64> }`, or
`MissingId`. Request commands can carry activity's named `awake`/`closed_lid` fields
and `allowSleep`'s generation, with an invalid/unsupported request outcome.
This is a sketch of the required information, not a required public API.

Both callers match the decoded command, but keep their own effects and replies.
macOS maps `MissingAction` to shutdown; Linux uses its optional ID to reject or
stop. Keep heartbeat handling before ID validation. No backend flag, callback
router or generic backend trait is needed. Guardian frames (`heartbeat`/`on`, no
request IDs) remain a distinct protocol and do not use this decoder.

This removes the concrete duplicated knowledge: action spelling, ID numeric type,
activity field names/types and generation numeric type. It does not claim to remove
two different policy state machines. Keep existing `Frames` and buffering limits.

Before switching callers, add table-driven pure decoder cases and fake-runtime/
private-bus cases for malformed action divergence. Cover missing/non-string action,
missing/non-integer/out-of-range IDs, negative IDs, heartbeat with invalid ID, unknown
actions, invalid boolean/generation types, and ignored extra fields. Assert replies,
stop/continue behavior and absence of native effects, not enum representation.

## Deferred decisions

### Typed state output: not selected

Although many state keys repeat, the KDE extension keys and sensor semantics are
different. Moving `Sample` out of `runtime.rs` and adding optional extension fields
would introduce coupling without helping the selected decoder change. A future
typed Linux report can be local to Linux. Any shared schema must preserve omitted
macOS extension keys, Linux required keys, state coalescing and output-error policy.
Do not add a common state machine merely to share serialization.

### macOS guardian lifetime: keep required concurrency separation

`macos.rs:297–446` distributes ownership across shared optional child stdin,
worker-local reply reader, a detached child waiter and a shutdown work message.
`run` also detaches signal, worker and reactor threads. `guardian::read_frames`
discards its reader handle. These are real navigation costs, but not evidence that
joining everything is safe. Main-run-loop notifications and fallback timers must
remain independent of blocked authorization/guardian work. The shutdown worker
currently restores under the override lock, then exits the process.

**Rule:** Rust best practices sections 3 and 7 (explicit ownership and concurrency),
qualified by section 4's behavior-preserving refactoring rule.

Follow-up inspection considered grouping only pipe and reply-reader methods without
changing joins or policy. It provides no concrete gain: the reader is already private
to the serial worker, but heartbeat sending and pipe closure must remain accessible
from the reactor while that worker blocks. A wrapper would still expose that split
capability and leave startup/send/read/close ordering with the same callers. Hiding
send-plus-read under one lock would instead prevent heartbeat or closure during a
blocked reply. The child waiter must independently notify the reactor of exit.

Keep this existing concurrency separation, not an open must-fix. Do not add blocking
joins in `Drop`, on the main queue or on the reactor, or group handles merely to
reduce field count. `macos.rs` and `guardian.rs` are unchanged.

### Swift differential evidence: keep acceptance, defer lane change

`tests.rs:761–807` compiles only pure Swift support with `xcrun swiftc`; it checks
generation behavior and the complete installation script byte-for-byte. It neither
launches the native helper nor performs power operations. It currently runs in
the normal macOS Rust suite. `.github/workflows/tests.yaml` runs `ci.sh power-check`
on Linux and macOS; that wrapper runs formatting, clippy, tests and build.

A separately named migration suite could make the compiler dependency explicit,
but is not needed for decoder extraction. If later authorized, keep it mandatory
in macOS acceptance/CI and document the explicit local command in `PORTING.md`.
Do not silently ignore it, gate it off by default without replacement, delete Swift
support, or replace the byte comparison with copied Rust expectations.

## Verification plan and evidence boundary

The initial audit used source reads and searches only. Authorized implementation
adds `protocol::decode_command` and switches the two callers to typed commands.
Tests characterize exact JSON numeric/boolean types, ignored fields, heartbeat
precedence, macOS stop-versus-reject behavior and Linux continue-versus-stop behavior
with private fake-bus fixtures and no native work.

After the native agent released the compiler lane, the supported wrapper passed
all 39 tests and all-target Clippy with warnings denied on macOS arm64. The tests
include the four new characterization tests, private Linux peer fixtures and the
unchanged Swift byte-for-byte differential acceptance. Pinned Rust formatting
and whitespace checks also passed. The compiler lane was released to the parent
immediately after completion for the Day agent. No native
helper, host service, authorization, assertion or power operation was run. No
hardware or performance qualification is claimed. State serialization and the Swift
comparison test remain unchanged.

Independent native cross-review found no production semantic regression, but found
that the invalid-ID test could pass after heartbeat lease expiry. The corrected
test keeps its sender alive until exit and requires exit within two seconds, well
below the 20-second lease. Both new Linux tests now limit initial-state, reply and
shutdown waits to two seconds. This allows fake-bus scheduling without accepting
lease expiry as command rejection. After the fix, the supported wrapper rerun of
all 11 Linux tests and all-target Clippy passed; pinned Rust formatting passed.
The compiler lane was immediately released again for the Day agent.

### Source-semantics review before compilation

Reviewed the production diff against the original branches after extraction:

- `decode_command` still checks string action and heartbeat before request ID.
  Linux's former JSON equality check for `heartbeat` accepts exactly the same
  string value as the decoder. A heartbeat with an invalid ID remains valid.
- Numeric extraction still uses `as_i64` and `as_u64`; no coercions, safe-integer
  tightening or new unknown-field rejection were added.
- Missing/non-string action retains an optional valid ID for Linux's false reply;
  macOS ignores that ID and stops. Invalid payloads and unknown string actions
  remain false replies without native dispatch on both backends.
- macOS activity still queues work, authorization remains asynchronous and sleep
  uses the unchanged retry path. Valid generation ACKs still dispatch once before
  replying true. Shutdown effects and report/reply order remain with the reactor.
- Linux closed-lid activity still rejects before any cookie mutation. Accepted
  ordinary activity has unchanged add/release/property-check ordering. Valid but
  stale generation still replies true without releasing a newer preparation FD.
- Linux output still uses fallible `emit`; macOS still uses best-effort `reply`.
  No shared reply policy, state output, timing, queue, connection, shutdown, grant,
  sensor or guardian implementation changed.

This review found no extra policy shift. Compiler and fake-only test execution ran
only after the native audit released its compiler lane. Source review and formatting
alone are not a passing test claim.

Verification used the existing pinned wrapper and fake-only fixtures:

```sh
bash apps/power/scripts/cargo.sh fmt -- --check
bash apps/power/scripts/cargo.sh test --locked
bash apps/power/scripts/cargo.sh clippy --locked --all-targets -- -D warnings
```

Keep macOS and Linux CI coverage: these tests compiled Linux fake-bus code on
macOS, but do not replace a native Linux build or Linux-only private bus tests. Keep
the Swift comparison in macOS acceptance. Select daemon `power-helper.test.ts`
and `power.test.ts`, then `power-handoff.test.ts` with relevant session-power tests
through the existing Node test runner if wire handling changes. Keep packaging
and helper discovery contracts unchanged; no new packaging suite is needed for
a decoder-only source change.

Never run the built helper, connect to host power buses, call native assertions,
sudo/authorization/pmset, exercise sleep/lid actions, or start/restart/install live
services. Hardware qualification remains the separately authorized test-machine
procedure in [agent-sleep.md](agent-sleep.md). Structural audit success does not
verify implementation that has not yet been made.
