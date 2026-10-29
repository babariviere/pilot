# PilotPower Rust port

Standalone macOS daemon child, with a second instance running `--guardian`.
No GPUI, Swift GUI, profile migration, new power policy or Linux power support.
The legacy Swift helper/support/tests/build remain for Swift coexistence.

## Mapping

| Swift | Rust |
| --- | --- |
| `PowerRuntime` | `runtime.rs` protocol reactor + `macos.rs` sensors/operations |
| `SleepAcknowledgement` | `support::SleepAcknowledgement` |
| `SleepOverride`, `PowerPermission` | `support.rs` |
| `PowerReplyReader` | `protocol::ReplyReader` |
| `runGuardian`, `GuardianConnection` | `guardian.rs`, native serial worker/pipe |
| `command`, `sudoSleep`, `authorize` | `macos/commands.rs`, fixed support command builders |
| `sleepClosedLid`, `restoreLidSleep` | native IOKit operations + pure lid-protection predicate |

Each original support test has the same snake_case name in `src/tests.rs`.
`permission_is_limited_to_two_fixed_commands` also checks the fixed grant; the
macOS differential test compiles **only pure legacy support**, checks generation
behavior and compares the complete install script byte-for-byte. Additional tests
cover the real bounded pipe reader/reactor with injected IOKit/guardian/authorization,
EOF, malformed input, failed restore/recovery, foreign overrides, exclusive flock,
strict lease boundaries, unsafe-lid cutoff despite heartbeats and unchanged reports.

## Preserved behavior

- Only `PreventUserIdleSystemSleep`, with the same name and level. No display assertion.
- Main-run-loop native notifications and generation-bound five-second fallback stay
  independent of the blocking authorization/guardian worker and daemon teardown.
- Five-second heartbeat checks, greater-than-twenty-second lost-heartbeat lease,
  twenty-second unsafe-lid cutoff, EOF/signal cleanup and six 500ms lid-sleep attempts.
- AC + usable Wi-Fi revalidation before the optional global write. No SSIDs/scans.
  Full wake still requires graphics capability, an awake display and a later wake token.
- Existing per-user `~/Library/Application Support/Pilot/Power/{owner.lock,override}`,
  marker-before-write, failure-retained marker, non-adoption of foreign overrides.
- `/etc/sudoers.d/pilot-power`, numeric UID, the two exact `/usr/bin/pmset disablesleep`
  commands, `sudo -n -k`, explicit administrator prompt and failure semantics.
  Grants authorize **pmset**, not the helper's language/path, so no grant migration is needed.
- The opt-in still blocks Apple-menu Sleep even with the lid open. Ordinary mode
  still permits manual/lid sleep. Missing assertion levels/types retain Swift's
  conservative lid-specific protection behavior; numeric CF booleans preserve Swift bridging.
- PowerService still owns saved defaults/settings, agent/job/child/result-handoff
  activity, cancellable 60-second idle grace and durable pause/wake without replay.
  Only development executable resolution changed in TypeScript.

Rust ownership replaces Foundation object lifetime plumbing. Native handles/monitors
are process-lifetime resources; the idle assertion and pending sleep token are explicitly
released on shutdown. Command stdout is drained nonblocking, retained at 64KiB, with
the same five-second command / 115-second authorization deadlines and TERM/KILL grace.
JSON frames use the existing booleans and integer IDs, rather than Foundation coercions
for out-of-contract callers. No additional public protocol or mock mode is shipped.

## Build and packaging

Bootstrap `apps/desktop`'s pinned tools, then:

```sh
bash apps/power/scripts/cargo.sh test --locked
bash apps/power/scripts/cargo.sh clippy --locked --all-targets -- -D warnings
bash apps/power/scripts/cargo.sh build --locked --release
bash apps/desktop/scripts/build-native-helpers.sh /fresh/native-helpers
```

The wrapper uses Rust1.98.1, mbx CPU2/4GiB and a private `apps/power/target`.
Next's immutable-source `bundle_runtime.py native` calls only the helper build:
Rust `PilotPower` plus direct Swift compilation of retained `PilotSystemEvents`.
It never resolves the Swift app package or vendors its GUI dependencies. Existing
source/target/hash receipts, `Contents/Helpers/PilotPower`, inventory, leaf/outer
signature and missing-helper admission contracts remain unchanged. Development
resolution prefers Rust release/debug, then the legacy Swift development helper;
`PILOT_POWER_HELPER` and packaged paths retain precedence.

Retained launchd runtimes continue to carry the sealed helper with their selected
runtime. This changes neither service ownership nor any running helper. Swift
retirement must still retain `PilotSystemEvents`, shared icon/runtime assembly,
power settings/pause state/lock/marker and the existing authorization grant.

## Verification boundary

macOS arm64: Rust unit/injected pipe tests, clippy, native helper-only optimized build,
pure Swift support comparison, focused daemon power/handoff/session-power tests,
packaging source/receipt/missing-helper tests and synthetic bundle signature checks.
The compiled helper is **not launched** by these checks. Native power APIs, real
assertions, sudo/authorization, pmset, sleep/lid actions and live services are untested
and deliberately unperformed. No installation, restart, release or signing/feed
configuration changes. Hardware qualification remains the separately authorized
test-Mac procedure in `docs/agent-sleep.md`, not a claim from compilation or mocks.
Linux CI may run portable injected models only. It does not qualify or enable a
Linux power helper.
