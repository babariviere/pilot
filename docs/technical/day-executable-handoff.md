# Day executable self-update handoff

Status: **not production-qualified**. The Day-owned executable and deferred
close owner, app-only controller and verified successor startup are implemented
below. Signed packaging and real replacement acceptance remain separate gates.
The original source audit on 2026-11-11 was against Pilot
`7075f155c78f5da6325707539f3e67d424ec9f65` and unmodified longbridge/nsh
`v0.4.0`, peeled commit `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`.
The tagged checkout had no tracked changes. No app, service, registration,
signature or release was changed. This audit does not qualify the joined update
sequence in [Day update pipeline](day-update-pipeline.md).

## Implemented Day-owned bootstrap and close

`apps/day/native/src/main.rs` is the `pilot-desktop` binary (feature
`macos-host`). It uses `bootstrap.rs`, `macos_app::ApplicationOwner` and the
same `macos_host::WindowOwner`, `Bridge` and sole `DayRoot` as the native
fixtures. It does not call stock `run_app`. All application screens remain TSX.

Bootstrap requires an explicit native selection: `--profile`, `--port`,
`--daemon-id`, `--lineage-id`, `--project-id`, `--project-path` and `--journal`.
These are native launch arguments, not screen inputs or credentials. There is
no inferred profile or live registration. The production path first checks the
fixed executable layout, compiled trust and existing `NativePlatform` signature,
version and payload verification. Only then does it read the package's
`Contents/Resources/nsh/bundle.nshc` through NSH's trusted reader and bind the
host. It never uses `NSH_APP_DIR` or `NSH_CHUNK_DIR`; runtime-delivered chunks
are disabled. A signed resource closure must contain the connected TSX entry
with its exact declared host methods. The default mock bundle is not that
closure. Missing compiled identity or signed payload refuses startup. No
development bypass, mock fallback or compiler/signature receipt was added.

The application owns its AppKit window, delegate and standard menus. Both the
window's Close and application's Quit begin one deferred attempt:

1. Fence new effects, commit current native preedit through NSH's ordinary
   text events, record exact attached bytes and UTF-16 selection, and freeze
   native editors. A transparent app-owned sibling intercepts window input
   and keeps keyboard focus outside the NSH surface while saving. It is not
   a replacement screen. Independent daemon work and Stop are unchanged.
2. Ask the live TSX entry to save every form. The existing FIFO worker's ACK
   follows admitted form saves and journal durability. Native windows require
   the final `SavedView`, including New's unsent goal. The worker appends an
   exact-source `window-capture` record to the existing private journal even
   when no update is pending, then saves any update-specific capture. The
   journal keeps the latest capture per source (256-source limit, included in
   the existing global record and byte limits), with window identity,
   generation and admitted save sequence. Missing view or failed persistence
   cannot ACK. Native readiness and that exact generation's ACK are both
   required. No timer fabricates an ACK.
3. Recheck attached bytes and seal the generation plus last admitted save
   sequence exactly once. Start `NativeHost::close` and await its entered I/O,
   journal, WS and worker join off the AppKit thread, with engine/window alive.
4. Consume the opaque joined result for that same seal. Only a successful
   result permits engine stop and window disposal. Then the application loop
   returns to the executable. Duplicate close/Quit callbacks do not join again.

Escape or the app menu's Cancel Close cancels an unsealed attempt. A missing
or failed form ACK reaches a 30-second deadline, cancels that exact attempt
and restores native editing, focus and selection in the same engine. Old
generation ACKs/deadlines and old root identities cannot close a newer attempt
or root. Failed native capture also restores editing. A failed entered host
close keeps the engine/window alive but does not pretend the sealed, closed
host is editable or safe to replay; it remains a native recovery failure.
Selection/profile replacement must close this owner completely before opening
a new selected root; there is no reload or in-place root replacement API.
Cancel keeps captured preedit as committed text; it does not reconstruct an
IME's private composition session. `NativeHost::saved_window` exposes the exact
saved capture only for the same native selection, including after reopen. That
passive native read grants no action or startup authority. The joined successor
path below separately owns display restore and native startup acknowledgement.

`WindowOwner::seal_close` returns a non-cloneable `SealedClose` continuation.
The production updater owner keeps it across the existing controller handoff,
entering the existing signed controller once with `prepare_update`,
then consume the same continuation with `close_sealed`. It must await entered
preparation before controller/close completion. `Closing` yields an opaque
`JoinedClose`, so callers cannot synthesize a successful join for disposal.
There is no second seal or second handshake in this continuation. The
executable consumes `--updater-receipt` through the verified successor path
below. It never treats that argument as permission to cold-start an unrelated
profile or to resume agents.

## Joined app-only handoff and successor

The production owner consumes each fresh app confirmation once. It captures
native editors and the final TSX `SavedView`, seals that exact generation and
admitted save sequence once, and awaits the serialized native update command.
`handoff::Controller` reopens the existing signed staged transaction under its
target lock, prepares the external independent-daemon guard, saves the exact
native selection/journal/capture with the existing navigation API, and calls
the existing `PreparedExit::launch`. Only the real helper's READY permits the
next step. The controller rechecks the seal, profile credentials and close/Stop
fence after preparation I/O and after READY, immediately before its one COMMIT.
The root keeps the stage, lock and helper control, including uncertain COMMIT,
after the host worker joins and until executable exit. No daemon reservation,
pause, stop, registration or resume is part of this app-only path.

An acknowledged COMMIT still is not parent exit or replacement. The same opaque
`SealedClose` then enters and joins `NativeHost::close`; only that joined result
can dispose the engine/window. A failed save, stale seal, cancelled capture,
unverified target, failed handoff or failed join never disposes the live root.
An uncertain COMMIT stays Unknown and cannot re-launch a helper or resend COMMIT.
Cold open and Check read retained evidence only. Recovery payloads and rollback
evidence are not cleaned or interpreted as a verified rollback.
After sealing, a failed/uncertain entered handoff or close keeps the current
sealed engine for native recovery. It does not unseal a possibly committed
operation or turn Cancel into permission to retry it.

Fresh native launches still require the explicit selection above. The optional
native-only `--update-transaction`, `--update-source` and `--update-build` must
appear together and identify an already staged signed target; they do not
stage, sign or grant its validity. Missing payload/trust remains unavailable.
These paths never enter TSX. The successor accepts only `--updater-receipt`
plus its absolute retained transaction, not mixed fresh-selection arguments.
It verifies the running signed payload, existing startup receipt, external
guard, manifest source/build and exact retained Day operation. Its saved native
source, journal, window identity, generation, sequence and final view must agree.
Managed/combined receipts remain unsupported, even if another controller could
acknowledge them. No new updater protocol or fixture trust gate is used.

The existing TSX restore shows the saved state and acknowledges display only.
The production native owner separately observes that current window's durable
display acknowledgement and enqueues the final native startup command. That
command journals entry before the existing installer's startup ACK API, rechecks
identity/authority and writes completion only after the updater's durable ACK.
A crash after startup entry is lookup-only: an existing exact
`StartupAcknowledged` journal may reconcile completion, but a missing ACK never
causes another send. A new display restore, daemon hello or matching version
alone proves neither replacement nor execution authority. Agents never resume
from this path.

The audit tables below describe the original stock-runner gaps. Controller,
successor, executable and pre-disposal close ownership are superseded by the
implementations above. Signed packaging and actual replacement acceptance are
still missing. Hidden attached tests are component/native-boundary evidence, not visible desktop,
signed distribution, whole-form production acceptance or replacement acceptance.

Focused verification entry points (private dependencies/cache/target, installed
Rust 1.99.1, `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_INCREMENTAL=0`, one Cargo job):

```sh
apps/day/scripts/cargo check --locked --offline --manifest-path apps/day/native/Cargo.toml --features macos-host --all-targets -j1
apps/day/scripts/cargo test --locked --offline --manifest-path apps/day/native/Cargo.toml --features macos-host --test application_owner -j1
apps/day/scripts/cargo run --locked --offline --manifest-path apps/day/native/Cargo.toml --features macos-host --example capture_probe -j1
apps/day/scripts/cargo test --locked --offline --manifest-path apps/day/native/Cargo.toml --features macos-host --lib --test public_bridge --test connected_update --test boundary -j1
```

`application_owner` is a main-thread, `harness=false` hidden AppKit test. It
constructs the production owner but never orders a window front or runs the
visible application loop. `capture_probe` separately exercises attached field
and multiline preedit plus the one-use seal/close continuation. Bridge and
connected-update tests use headless components. None supplies a signed Day
payload or claims successful helper handoff/startup.

The original close-owner macOS arm64 run on 2026-11-11 passed the all-targets check,
99 library/boundary/Bridge/connected-update/update-host tests, the hidden
application-owner test and attached capture probe. The hidden owner also
checked missing-view ACK refusal, exact saved capture after reopen, a different
profile's refusal to adopt it, and a real private-journal write refusal that
keeps the engine/text alive. The original executable rejected successor receipts
before opening AppKit; the joined startup path above replaces that refusal.
Those original checks are isolated component and native
boundary checks. The visible event loop, physical IME/keyboard/menu interaction,
all production forms, signed package and successor restore are not accepted.

The joined-controller run passed 102 Day library/model/boundary/Bridge/update
tests plus the hidden production owner, all-targets check, executable build,
scoped Clippy and 84 focused updater tests. One mounted-volume test stayed
ignored; OS signing tests were excluded. The owner now also checks automatic
app-confirmation capture, cancellation without resurrecting that intent, and
missing-signed-payload refusal without losing exact bytes or closing the window.
Controller tests cover one COMMIT after READY, a lost ACK with no second send,
fresh safety/authority refusal, and startup-entry lookup-only recovery. Updater
tests cover retained phases/source/build, final startup authority after payload
verification, durable ACK discovery, EOF/COMMIT/parent exit and rollback evidence.
The startup metadata unit test uses a test-only synthetic platform; the public
production verifier always uses the real `NativePlatform` and its signed payload
closure. No compiler evidence or fixture trust is accepted by production.
These remain component/hidden-boundary checks, not a real signed Day replacement,
successful successor launch, visible native acceptance or live update.

Full `clippy::all` is blocked by unchanged large-enum warnings in host Work and
update Command, plus two collapsible-if warnings in the existing native capture
module. The all-targets scoped lint passes with only those existing lint classes
and the previously reported items-after-test-module class allowed on the command
line. No source lint suppression or unrelated enum refactor was added. Installed
toolchain warnings about `rust-objcopy`'s missing `libLLVM.dylib` and the debug
linker's large unwind section remain; checks still exit successfully. No shared
toolchain/cache repair was attempted.

## What the released bootstrap actually supports

Paths below are relative to the tagged NSH checkout.

| Source | Observed contract | Consequence for Day |
| --- | --- | --- |
| `crates/nsh-cli/src/rust_app.rs`, packaged runner generation | Generated mixed `main` registers UI/component factories, then calls `nsh_macos_app::main`. | Registering Day exports does not open a `NativeHost`, bind a `DayRoot`, or own an update. |
| `crates/nsh-macos-app/src/lib.rs`, `main`/private `setup` | Reads bundled `nsh/bundle.nshc` through `Bundle::read_trusted`, then calls `run_app`. Supports development `NSH_APP_DIR` and `NSH_CHUNK_DIR`; only parses `--fps`. | No caller-supplied bootstrap, Day host handler, or `--updater-receipt` consumption. A renamed runner still cannot restore/ACK a Day transaction. Production must not inherit a development resource override as trusted package identity. |
| `crates/nsh-platform-macos/src/app.rs`, `AppOptions.host` and `AppView::new`/`load` | Public same-process host channel and embeddable view. Typed engine context is defaulted internally. | Existing `Bridge` over the sole `DayRoot` is the supported route. No second root, global credentials or typed-context workaround. |
| Same file, private `Delegate`, `finish_running` and `main_menu` | Stock window close stops the engine. Quit calls `finish_running`, closes the window and stops its engine before returning to the caller. No all-form save/defer callback in `AppOptions`. `keep_alive_on_close` hides a window but does not guard Quit. `quit_app` stops the standalone runner, not an embedded host. | Joining a root *after* stock `run_app` returns is too late to capture TSX-only text/preedit. The stock menu/delegate cannot be used as the production save owner. |
| `crates/nsh-cli/src/package.rs`, `package_macos` | Builds the name/ID/executable from app config, copies NSH resources, and seals ad hoc. | Stock `Pilot Day.app`/`PilotDay` (`dev.pilot.day`) is not the updater's signed distribution contract. |

This is a limitation of the **stock runner**, not proof that unmodified NSH
cannot host Day. Public `AppView::view` exposes an embeddable AppKit view. An
application-owned AppKit window, delegate and menu can use it without patching
NSH. The production executable and deferred-close owner above now use this
route. Its hidden capture fixture does not exercise every real form.

## Identity and verified payload closure

Keep the existing `apps/desktop/updater` contract unchanged:

- `layout::running_root` requires the real current executable at
  `Pilot Next.app/Contents/MacOS/pilot-desktop` on macOS. This is a path gate,
  **not** a signature or payload verification result.
- GUI and helper require the same separately compiled `helper::compiled_trust`
  configuration. `Trust::validate`, signed manifest verification,
  `ExpectedTarget` source/build matching and `NativePlatform` verification stay
  mandatory. No production key or usable default is supplied by Day.
- The installed helper is
  `Contents/Helpers/pilot-desktop-update-helper`. `run_native` verifies its own
  installed bundle, actual parent GUI executable, peer identity and inherited
  target lock before reopening the signed transaction. Merely finding a helper
  file is not READY.
- `bundle_runtime.assemble(..., gui_resources=...)` can include an exact NSH
  resource closure bound to the GUI digest, immutable source, arm64 target and
  tagged release. It still requires source-matched GUI, helper, native helpers,
  runtime inventory and matching compiled configuration receipts. It also still
  requires `pilot-visual-worker`. The input builder compiles the GPUI GUI; it
  does not produce a trusted Day bootstrap or its compiler receipt.

The assembler therefore closes resource copying, **not** Day executable
production. Do not rename a stock runner, synthesize compiler evidence, omit the
visual-worker requirement, accept a fixture key or bypass signature verification
to manufacture a passing package. No signed production Day payload was available
for this qualification. Preserving the current installed app and data takes
priority over making an update appear available.

## Original owners and missing handoffs (historical audit)

This table records the original audit, not the current implementation status.
The joined production path above replaces its controller/startup/close gaps.
It does not establish signed package or replacement acceptance.

| Stage | Existing owner/evidence | Missing production integration |
| --- | --- | --- |
| Select/confirm | Root-only `host::updates::Selection`; exact profile/connection/trust/target and credential pin. One-use confirmation saves the operation before capture. Registration remains explicit. | Trusted executable constructs selection. TSX cannot supply paths, PIDs, credentials, trust or transaction identity. |
| Save/capture | `Bridge` fences admission, native capture reports attached editor bytes/preedit, form ACK covers its generation and last admitted save sequence. `WindowOwner` checks bytes again before sealing. Failed ACK leaves the engine alive; cancellation restores editing/focus. | Production window routes close, Quit, reload, selection replacement and update through that same owner. No engine disposal before the save barrier. |
| Enter app preparation | `Bridge::commit_update` requires the sealed proof. Existing serialized host fsyncs `entered` before `Selection::enter` verifies the signed prepared target and creates/verifies `ExitGuard::prepare_external`. | This only prepares a guard. It does not launch a helper, receive READY, send COMMIT or prove replacement. |
| READY | Existing `Updater<Worker>`/`PreparedExit::launch` owns helper control and locks; helper rechecks trust/parent/guard and prepares the payload before READY. | Day has no owner for this controller/staged lifetime. Passing an `AppTarget` path is not transferring a `Staged` lock or helper lifetime to the root. Reuse the controller, not a second handshake. |
| COMMIT and close | Existing controller requires fresh `Safety`/flush evidence. Helper fsyncs Committed before ACK, then waits for the exact native parent exit. `NativeHost::close` and `Worker::close` join their own entered work. | `WindowOwner::finish_close` seals, stops its engine and closes the root; it does not expose an update continuation. Pre-sealing outside it makes its second `seal_flush` fail. Do not skip that seal or close the host before its entered app preparation settles. A production owner must join capture, controller handoff and close as one lifetime. |
| Successor startup | Existing installer launches with `--updater-receipt`. `startup_receipt`, `coordinated::startup` and `ExitGuard::external_startup` inspect exact evidence; `ExitGuard::acknowledge_startup` verifies the installed payload and allowed post-swap phase. | Day does not parse/validate the receipt, verify its own running identity, load the exact saved state, or own the final durable native ACK. `day.update.restored` only ACKs display restoration, never helper startup or agent resume. |
| Recovery | Installer retains archive, signed manifest, journal, rollback inode and uncertain phases. Check and cold-open are lookup-only. | No joined Day GUI/daemon recovery or compatible-old-app rollback acceptance. A retained old directory is not a verified rollback. |

App-only updates must keep the independent daemon and its agents running. They
must not acquire a daemon interrupt reservation. Combined app-and-daemon remains
explicitly unsupported until the existing controllers share a durable sequence
and exact selective recovery. Do not emulate it with two unrelated calls.

## Interruption rules

1. Failed identity, signature, target or prepare checks enter no replacement.
2. Failed native capture/form save keeps the original engine and unsaved bytes.
   No helper COMMIT or daemon stop follows.
3. Before helper COMMIT, ordinary EOF/cancel aborts preparation. A joined host
   close is not evidence that a separately running helper has exited.
4. Lost/malformed COMMIT ACK remains Unknown. Never resend COMMIT, restart a
   helper or undo durable commit intent from a missing reply.
5. COMMIT ACK is not parent exit. The helper must observe its exact parent's OS
   exit, then recheck the guard, before swap. It is not whole job-subtree proof.
6. A failed launch/post-swap interruption keeps both payloads and recovery
   evidence. No blind second exchange or automatic rollback.
7. Opening the successor, daemon hello, restored UI or a status read is not the
   durable startup ACK. A pending journal refuses interpretation as success.

Unconfirmed historical job descendants remain a **refusal**, not a successful
jobful update. See the pinned-provider limit in the pipeline document. Nothing in
this executable audit clears that independent acceptance blocker.

## Offline evidence and limits

The new macOS layout test actually copies and executes the updater's test binary
under four isolated bundle/executable layouts. Both stock Day naming combinations
and a wrong fixed executable are refused. The fixed layout resolves correctly,
but the real `NativePlatform` verifier refuses the incomplete synthetic package.
No fixture verifier is used for that refusal. This is executable **layout**
evidence, not a signed Day identity.

The native parent-watch test holds a private `/bin/cat` child alive through its
owned stdin. An immediate wait refuses exit. A watch installed before stdin EOF
then observes native process exit and the test reaps the child. Teardown kills
and reaps it even on assertion failure. This tests the real kqueue boundary,
not the helper's full verified-GUI-parent handoff or a descendant subtree.

Existing focused suites separately cover failed saves/prepare, exact fresh
flushes, entered-I/O close, lost replies, signed startup discovery, interrupted
journals, retained rollback and refusal of blind second swaps. Installer swap
tests use a synthetic platform/exit capability; they are not real Day package
acceptance. No test here substitutes those fixtures for production identity.

Only macOS arm64 is audited/executed here. Linux uses a different native
layout/pidfd/systemd contract and remains unqualified by this evidence. No visible
window, signing, notarization, release, provider send, OS service change, live
registration/update/restart, default switch or legacy removal is authorized or
performed by these checks.
