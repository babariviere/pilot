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

## External native termination: deferred request/reply

The original `external-terminate` safety regression sent **`NSApplication
terminate:` directly**, with a held faux Send and newer unsent text. It failed
at the real shutdown observer with `external termination bypassed the draft
drain`. The earlier characterization separately proved no Flushed, a locked
Store and open input lanes despite dirty preferences. Process-exit cleanup was
not a successful save. This task implements the approved should-terminate
boundary, not another `willTerminate` observer.

### Platform and root ownership

The existing checksum-pinned GPUI patches expose opt-in `App::on_should_quit`.
On macOS the actual `applicationShouldTerminate:` delegate returns
`NSTerminateLater`, then invokes the owner outside the native callback/App
borrow and replies through `replyToApplicationShouldTerminate:`. Apps without
an owner and non-macOS platform implementations retain their legacy behavior.
A failed App borrow or absent root is refusal, not permission. There is no
production deadline that grants exit.

The current Local root uses its existing composer/queued-input preedit,
Settings-window/shared-preferences, daemon-upgrade and restart/checkpoint
vetoes. It enqueues the existing priority courier Close, without another Store,
executor, checkpoint or replay path. Refusal and write-listener failure/EOF
reply NO. Window teardown also refuses while retained view handles still exist;
dropping the root closes its reply channel. Replacing a root cancels its old
reply, and old-root Flushed cannot terminate the new owner. A refused attempt
cannot be revived by a late projection. A fresh explicit request may recheck an
already-confirmed drain.

YES requires this root's actual Flushed with no writer error and current root
vetoes still clear. Already-drained ordinary exits use the same checks without
sending another Close. An updater exit must additionally remain
`ExitAuthorized` with the existing exact current generation, draft/outbox receipt
and preferences durability safety. A checkpoint or COMMIT alone is insufficient.
Prepare, confirmation, uncertain COMMIT/Unknown, rollback and legacy platform
paths are not reimplemented.

Courier Close clears the transient checkpoint acknowledgment. The terminal
updater receipt therefore reuses the existing exact draft/question validation
with the same retained checkpoint fence and a real `closing && Flushed` ACK.
The ordinary checkpoint receipt still requires its original acknowledgment;
an absent/reset fence, wrong generation, error or mere Close intent is never
reconstructed from an old Flushed projection.

Two additional native integration failures were found rather than hidden with
settling sleeps:

- AppKit runs a nested event loop during deferred `terminate:`. If the original
  call is itself on the main dispatch queue, that queue cannot deliver GPUI's
  courier listener or even its foreground deadline. Installing the hook enables
  common-run-loop foreground wakes in the pinned Apple dispatcher, including
  before requests so previously queued work remains serviceable. Background
  dispatch/timers and apps without the hook remain unchanged. Refusal posts an
  inert application-defined event to release `nextEvent`'s inner wait without
  user input. That event authorizes nothing.
- A reentrant `terminate:` can bypass AppKit's delegate while a termination loop
  is already pending. The existing GPUIApplication subclass therefore coalesces
  at the application entry as well as at the should-terminate delegate. One
  outstanding native request owns one reply. There is no selector swizzle,
  replacement delegate, polling pump, runnable registry or second lifecycle
  controller. Source patches and their original archive checksums are tracked in
  `patches/`; generated `.patched` inputs are never edited by hand.

### Focused verification

The hidden application corpus retains the existing actual window Close/menu
Quit and three already-drained updater cases, and adds external unsent, held
Send, durable Unknown Send, durable Unknown answer and Close-time private-disk
failure cases. Every child first refuses dirty preferences through actual
window Close, menu Quit and external termination. A real reentrant terminate is
scheduled while the first native request is outstanding, not merely called
back-to-back after a refusal. Held external Send explicitly enters from the
native main dispatch queue, preserving the original red fixture's blocked-queue
boundary even after GPUI foreground dispatch opts into the common run loop.

The production owner is instrumented at its future's return, not replaced by a
synthetic delegate: before returning YES, each successful case independently
opens Store, verifies the latest Unicode text and captured answer/model/intent,
and verifies closed command, priority-Close and wake receivers. The actual
shutdown observer repeats the checks. The held server's late ACK cannot mutate the replacement-owned file;
post-process reopen checks exact draft bytes and metadata again. Each held case
has exactly its one original execute/receipt request, and retained Unknown cases
have no mutation or receipt lookup. Fault cases prove NO and retained
app/input/Store ownership. Their explicit test-only termination override is
cleanup, **not** successful graceful exit or persistence acceptance.

Focused root/context tests additionally cover an intermediate non-Flushed
projection, duplicate sender protection, changed preferences at completion,
late Flushed after refusal, current-owner replacement, window teardown with
retained entities, marked input, upgrade/restart and checkpoint vetoes. They
also refuse saving and durability-unconfirmed preferences without closing the
writer. These are synthetic input-handler/state checks, not OS IME or native
filesystem preference-failure evidence. The native process deadline runs on an
independent thread so a blocked main event loop fails instead of stranding the test.
Readiness otherwise uses owner/courier notifications and explicit HTTP barriers,
never sleeps or polling.

```sh
python3 scripts/check-scoped.py \
  --unit local_view::menu_routing::tests \
  --test application_quit --test native_menus --lint
python3 scripts/check-scoped.py \
  --unit chat_editor::tests::update_checkpoint --native-probes --lint
python3 scripts/check-scoped.py \
  --unit interaction::tests::close_ack_releases_store_before_waking_application_exit \
  --native-probes --lint
bash scripts/cargo.sh build --locked -p pilot-desktop --bin pilot-desktop
```

On macOS27.2 arm64/Rust1.98.1, 15 hidden process cases passed (13 successful
drains, two explicitly cleaned-up fault refusals), plus the native no-window
menu/default-hook regression. Eleven root tests, five checkpoint tests and the
synchronous Store/input-release regression passed. Selected Clippy, changed-file
rustfmt and the plain locked binary build passed using the private target and
serial mbx CPU2/4GiB admission with fresh disk checks. No broad suite was run.

All processes use private Stores/preferences, hidden unfocused AppKit windows
and the faux loopback daemon. This is not OS shutdown/log-out, force-kill/power
loss, packaged bootstrap, native OS IME/pasteboard, visible-window/performance,
Linux/Wayland or daemon/service/PilotPower survival qualification. The opted-in
foreground scheduling change is necessary for nested termination, not evidence
of broad native modal/input parity. No installed app, live profile/data,
provider, daemon/service/runtime, release/feed/signing or Swift build is touched.

The previous isolated updater-helper corpus separately covered verified install,
cancel, expired guard, interrupted fixture parent, failed startup, external and
UI-only reconnect, and prepared-payload tamper refusal, retaining rollback and
recovery assertions. That helper does not use GPUI; it is not rerun or promoted
to external-termination/OS-shutdown evidence by this source-only hook change.
