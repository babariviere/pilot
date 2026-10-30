# Graceful application Close and Quit

This qualification is narrower than force-quit, power loss or restarting an
installed app. It uses private temporary Stores and a loopback faux daemon.
It does not touch the user's app, daemon, service, profile or settings.

## Current ownership and entry points

- `main.rs` wraps the selected desktop view in Kit's window root. Closing the
  last window requests GPUI exit. Bundled startup eventually constructs the
  same `LocalViewer::new`; its startup/service ownership is not this test.
- `LocalViewer::register_close` installs the actual native window-close veto
  and main Quit owner. It is shared by production Local startup and this
  fixture, rather than copying the callback into the test.
- AppKit's **Quit Pilot Next** item dispatches `Quit`, through
  `menu_routing::quit` to `request_menu_quit`. Settings/preedit and existing
  restart/upgrade vetoes remain in place. The main window callback checks
  Settings and restart/upgrade state before asking its editor to close.
- `ChatEditor::request_close` records current editable text/question input,
  retains unsavable input, and sends priority Close to its shared Interaction.
  `LocalViewer::listen_writes` applies the real courier projection. The real
  editor `Flushed` event reaches `menu_routing::exit`, then `App::quit`.
- The main composer, child composers, mission conversion and project
  registration share that Interaction's one draft Store/courier. Close cancels
  an outstanding cancellable HTTP effect, preserves admitted intent as Unknown,
  flushes the edit mailbox and does not execute queued mutations or replay.
- Settings has its own worker. Its file lock is per save, not a persistent
  draft Store lock. Pending/dirty/unconfirmed preference saves veto ordinary
  Quit. Sidebar-memory tasks are not draft/outbox checkpoint acknowledgments.

## Demonstrated race and narrow repair

Previously, `Interaction::run` published `flushed: true` before dropping Store.
An immediately woken application could enter native termination while the
worker still held the private file lock. Waiting for channel EOF hid this
race, which is why owner-only Close/EOF coverage was insufficient.

`close_ack_releases_store_before_waking_application_exit` registers a real
channel receiver with a synchronous waker. The waker independently opens Store
at the final publication boundary, before the worker's poll returns. It failed
against the old ordering (`Some(false)`, expected `Some(true)`), without a
sleep, scheduler race or injected production hook. The final acknowledgment
must follow Store release and termination of the courier input lanes. A second
deterministic assertion failed when input receivers still existed at that wake;
the final branch now releases both before publishing. Failed saves still
produce no Flushed acknowledgment.

## Application-root executable corpus

`tests/application_quit.rs` runs separate real GPUI/AppKit application processes,
not `HeadlessAppContext` (whose TestPlatform Quit is a no-op). Each child creates
a hidden, unfocused native window. It installs the shared production close
registration and production write listener/editor-event subscription. It drives
`NSWindow performClose:` and the actual NSMenu GPUI delegate for Quit outside
the App borrow. No window is shown or activated by the fixture.

The reader/sidebar connection is synthetic, with two exact IDs (`a`, `b`) and
identical titles. Navigation uses `LocalViewer::open`; delivery uses the mounted
production Send button and actual courier HTTP against the faux server. No
default Store discovery or real daemon reader is involved.

| Case | Assertions |
| --- | --- |
| Close and menu Quit | Latest unsent combining/emoji/Japanese text, two same-title draft owners, pending debounce drained, no mutation HTTP. |
| Held Send, then Close or Quit | One captured execute, newer unsent text and second chat saved, exact operation/payload unchanged, unresolved answer/model metadata retained, Unknown not settled or resent. |
| Durable Unknown, then Quit | Source-owned shown-text hides the captured original; a fresh GUI checkpoint acknowledgment can retain Unknown, then later edits survive actual Quit. Checkpoint is not Store close or installation permission. |
| Unknown question answer, then Quit | Exact captured reply request remains Unknown with the unresolved question panel mounted; answer/config metadata remains frozen while newer ordinary text and another chat draft are retained. |
| Settings veto | Both native entry points leave the editor/selected exact chat open while preferences are dirty; explicit fixture Revert permits the subsequent path. |
| Accepted ACK/private persistence failure | A private snapshot-path rename refusal retains volatile Accepted evidence. GUI checkpoint and graceful Quit remain vetoed. Explicit fixture cleanup exits only after testing that refusal; it is **not** a successful graceful Close. |

At GPUI's actual `on_app_quit` boundary, successful cases require the real
Flushed state and immediately open an independent Store while the old entities
still exist. This checks that retained entity/Interaction handles do not retain
the lock. The faux server then attempts an exact late ACK for the cancelled HTTP
while the replacement owns that lock; its filesystem bytes must remain unchanged.
The barrier proves the server finished that attempt, not client ACK delivery.
The parent waits for the child's actual OS exit status, immediately reopens and
writes using another Store owner, and checks saved draft bytes/metadata again.

Readiness is driven by courier/editor notifications and explicit faux HTTP
barriers, not polling or settling sleeps. The application deadline and late
response deadline are failure bounds only. Deterministic worker polling proves
the pending-debounce publication ordering separately from native scheduling.

## Verification and limits

Focused entry point:

```sh
python3 scripts/check-scoped.py \
  --unit interaction::tests::close_ack_releases_store_before_waking_application_exit \
  --test application_quit --lint
```

Verified on macOS27.2 arm64 with pinned Rust1.98.1: all seven native child
scenarios passed (the fault case proves veto, not graceful exit). Ten focused
library tests passed: the new synchronous publication regression, six existing
menu/focus/preedit contracts, failed explicit Close, held Send Close and update-
lane EOF/immediate reopen. Selected library/native Clippy, changed-file rustfmt,
24 scoped-runner Python tests and the plain locked desktop binary build passed.
Cargo used the existing private target and serial mbx CPU2/4GiB admission with
fresh disk checks. No broad suite or performance/visible-window claim is made.

This is source-level, isolated macOS native application-root evidence, not just
calling DeliveryOwner Close. It does not qualify the full packaged `main.rs`
bootstrap, every auxiliary editor, native OS IME/pasteboard, selection/scroll
restoration across a real app restart, force-kill/power loss, or Linux/Wayland.
The unchanged veto paths retain their existing focus/IME/history contracts;
this fixture does not simulate an OS IME or alter presentation.

## Updater exit release

The follow-up corpus reproduced `ExitAuthorized` reaching the real GPUI shutdown
observer with `flushed == false` ("root bypassed courier drain"). A durable
checkpoint alone kept the writer and Store alive. The repair uses existing
orchestration, not a new lifecycle owner:

- `ExitAuthorized` rechecks the current exact generation and preferences via
  `safety`, then asks `ChatEditor::close_gui_update` to enqueue priority Close.
- The editor verifies the exact receipt again and retains its checkpoint/input
  fence. Ordinary Close still cannot bypass that fence. Repeated advancement
  queues no second Close. Missing/stale/error receipts do not authorize exit.
- The real courier releases Store and its input receivers before publishing
  Flushed. The checkpoint branch now forwards that event to the existing root
  exit subscription instead of swallowing it as another checkpoint update.
- Prepare, COMMIT, verified installation, rollback, confirmation and Unknown
  behavior are unchanged. No timer, menu request or mere checkpoint calls Quit.

Three added hidden application processes cover an unsent Unicode draft, durable
Unknown Send, and durable Unknown answer with the unresolved question mounted.
They use the production restart checkpoint, a real preferences worker/private
preferences directory, the actual write listener and root exit subscription.
Only the updater controller's `ExitAuthorized` result is injected; these three
cases do **not** install or relaunch a bundle. Each requires pre-exit Flushed,
closed courier inputs, exact retained immutable request/answer/model metadata,
both same-title draft owners and an independent Store reopen at the native
shutdown boundary and after OS process exit. Unknown cases issue no HTTP mutation
or receipt lookup. The existing accepted-ACK/private-disk-fault case still proves
checkpoint/Quit refusal, not a successful exit after a failed save.

The focused editor regression checks absent/stale/wrong-generation/error receipts,
one priority Close, continued fencing, no mutation replay, no Flushed on an error
projection and forwarding of the later Flushed event. It uses recorded channels,
not a real filesystem-failure claim after an already completed checkpoint.

## External native termination: demonstrated bypass, implementation blocked

The added `external-terminate` child sends **`NSApplication terminate:` directly**
on its own hidden application, outside the App borrow. An execute is held by the
faux daemon, newer unsent text exists, and preferences are dirty. At GPUI's actual
shutdown observer it demonstrates all three facts:

- no Flushed acknowledgment;
- an independent Store open is refused because the original still owns its lock;
- the original courier still accepts an input command.

The process nevertheless exits, despite preferences that veto the app's Quit
menu. Post-process Store reopen succeeds, but that is OS resource cleanup, **not
a graceful drain or veto**. This case deliberately makes no claim that the latest
text was saved, that the held request was acknowledged, or that a timeout was safe.

Current GPUI macOS registers `applicationWillTerminate:`, not
`applicationShouldTerminate:`. Its callback invokes `App::shutdown`; quit
observers run after termination is committed and have a bounded 200ms wait.
They cannot refuse termination. Adding a best-effort observer would not repair
the demonstrated veto gap, and the ordinary window/menu orchestration cannot
intercept this external entry. **No external-path source fix is made.**

Proposed narrow contract, requiring scope review before implementation: an
explicit macOS should-terminate request/reply hook, returning deferred termination
while the existing application owners check their current vetoes and drain. Reply
yes only after the exact current attempt's real Flushed acknowledgment, or for
an already drained authorized exit. Dirty/preedit/failed/unconfirmed state must
reply no and retain the app/input; a deadline is never success. Keep
`applicationWillTerminate:` as observation/cleanup only, avoid duplicate requests
or reentrant App borrows, and preserve ordinary Quit and updater confirmation.
This would be a platform-boundary addition, not permission to implement it here.
OS shutdown/log-out behavior needs separate isolated qualification after review;
direct `terminate:` is not evidence of an actual OS shutdown.

## Follow-up verification scope

The selected native target now has eleven child cases: three updater exits,
one external-bypass characterization, six successful ordinary Close/Quit cases
and one fault-refusal case. A passing characterization means the **defect was
observed**, not that external termination is safe. Five focused editor checkpoint
tests and matching library/native Clippy passed on macOS27.2 arm64/Rust1.98.1.

```sh
python3 scripts/check-scoped.py \
  --unit chat_editor::tests::update_checkpoint --test application_quit --lint
```

Existing synthetic native helper lifecycle qualification remains separate from
the injected controller-result/root-release proof above. All eight existing
helper modes passed with private fake apps/daemon/payloads: verified install,
cancel, expired guard, interrupted fixture parent, failed startup, external and
UI-only reconnect, and prepared-payload tamper refusal. Retained rollback and
recovery assertions stayed in place; fixture interruption is not a graceful
drain, force-termination or power-loss acceptance claim.

The initial helper run passed six modes then timed out at UI-only startup.
Its stale assertion expected a retained daemon capsule and runtime-owner inspect
calls on macOS. The current macOS `Guard::startup_connection` deliberately
returns the verified GUI target with reconnect-only authority and pins hello
without those management calls. Only that example fixture's expectations were
corrected; Linux expectations and production trust/guard code are unchanged.
The full eight-mode rerun passed with its source-unchanged check.

Three selected updater tests passed for exact persistence-owner receipts,
uncertain COMMIT recovery and lost-COMMIT-ACK retention. The synchronous courier
Store/input-release regression also passed. Matching application library/native
and helper-example Clippy, changed-file pinned rustfmt, the lifecycle script's
Python regression and the plain locked desktop binary build passed. Checks ran
serially through existing Cargo/mbx CPU2/4GiB admission with Rust1.98.1, a private
copy-on-write target/toolchain and fresh disk checks. No full suite was run.

External-path implementation is blocked for platform contract review in #517.
No frontend-close
result promises daemon, service, parent-process or PilotPower survival. No live
app/store/service/runtime/feed/key/install/restart, force-kill, power-loss, OS IME,
OS shutdown or Linux acceptance is claimed.
