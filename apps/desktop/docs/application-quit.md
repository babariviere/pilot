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

An external `NSApplication terminate:`/OS shutdown is distinct from the app's
Quit menu. GPUI's platform termination callback calls `App::shutdown`, whose
`on_app_quit` observers cannot veto. There is no application draft-drain
observer on that bypass path. **That external termination path remains
unqualified**, not covered by the menu/close claim or repaired here.

GUI update restart uses the separate `begin_update_restart` checkpoint,
exact generation/preferences safety checks and updater Prepare/Commit flow.
`ExitAuthorized` calls GPUI Quit directly. This corpus checks editor checkpoint
admission/acknowledgment and refusal, not updater installation, its process
handoff, or pre-exit Store release on that separate path. Existing updater
qualification remains separate. No frontend-close result promises daemon,
service, parent-process or PilotPower survival.
