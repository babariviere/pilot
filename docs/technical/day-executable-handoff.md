# Day executable self-update handoff

Status: **not production-qualified**. Source audit on 2026-11-11, against Pilot
`7075f155c78f5da6325707539f3e67d424ec9f65` and unmodified longbridge/nsh
`v0.4.0`, peeled commit `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`.
The tagged checkout had no tracked changes. No app, service, registration,
signature or release was changed. This audit does not qualify the joined update
sequence in [Day update pipeline](day-update-pipeline.md).

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
NSH. That production executable and its deferred-close owner are still missing.
The existing opt-in `macos_host::WindowOwner` is a qualification component, not
that executable. Its hidden capture fixture does not exercise every real form.

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

## Existing owners and exact missing handoffs

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
