# Pilot Next, Native Shell chat slice

Additive macOS native chat runtime. The shipping GPUI binary and its entry point
are unchanged. This is not a complete replacement or a release package.

## Source and reuse

NSH **0.4.0**, upstream HEAD observed **2026-11-06**:
`0e4a20bd41ee72a35515cecbf9a7fba88742d911`.
All NSH dependencies, including testing and transitive platform/core crates,
share this exact revision in `../Cargo.lock`. No NSH patches, forks, Cargo-cache
edits, QuickJS, TSX or WebViews are used.

The layout and tokens start from `experiments/nsh-pilot` at `39a4913c`, not the
older patched `nsh-chat` study. NSH owns native input, undo, text selection,
Markdown, scrolling and rendering. Pilot owns canonical locations and actions.
The slice uses upstream Rust `Input` (native multiline composer/search),
`Button`, `TextView` (Markdown/plain documents), `Scroll`, `VirtualList`, keyed
regions, and the Rust application-menu API with native editing/window roles.
There is no custom text editor, button engine, scroll engine or text renderer.
The AppKit embedding host is needed because upstream `run_app` closes immediately
and exposes no cancellable draft-save close hook at this revision. It owns only
native input capture and the existing courier's close acknowledgment.
The embedding delegate also targets native Undo/Redo menu roles. Upstream's
plain embedding window has no responder for these actions. AppKit owns the undo
stack; the delegate reports its result with NSTextView's standard text-change
notification so NSH and the saved draft stay in sync. The fixture explicitly
groups synthetic insertions, which are not real hardware keyboard events.
The upstream `Tree` was also inspected. The sidebar keeps the production flattened
project/mission/fold-action rows and composes NSH Buttons inside Scroll, rather
than introducing a second expansion/selection model for the same rows.
The small `../src/nsh_adapter.rs` facade uses the shipping `LocalClient`,
`Interaction`, `delivery_store::Store`, `local_model`, `sidebar_tree` and
`sidebar_memory`. It creates no new transport, delivery protocol or storage
schema. The temporary dependency on `pilot-desktop` still builds GPUI. Separating
that dependency is later work, not a second copy of the safety-critical code.

## Build and run

From the repository root:

```sh
bash apps/desktop/scripts/bootstrap.sh
bash apps/desktop/scripts/cargo.sh build --locked -p pilot-nsh
# Explicit existing-daemon connection. Never starts or replaces a daemon.
apps/desktop/target/dev/debug/pilot-nsh --local
```

`--local` uses existing Local profile discovery and hello identity pinning. This
is the established loopback contract, not authentication. Running it explicitly
enables user-driven sends and Stop. It shares the shipping draft directory and
format; the existing writer lock refuses a second simultaneous writer. It never
deletes a lock or migrates data. `--state-dir PATH` selects a separate private
directory in that same format. No arguments make no connection.

The composer keeps exact UTF-8 text, including whitespace and multiline input.
Each callback captures its canonical chat and navigation generation. The existing
courier saves immutable operations before effects, reconciles eligible sends with
the same durable envelope, and keeps Unknown across restart. Historical Unknown
is not a new send. Stop is not automatically replayed. Ordinary legacy Ask and
restricted chats remain read-only. Pending questions and unsupported saved draft
forms direct the user to the current app, without sending them as ordinary text.

AppKit Close/Quit captures the native input and releases focus, then waits for
the existing courier's final `Close`/`Flushed` publication and exact saved drafts.
Marked text, unsaved input or save failure keeps the window open. This embedding
host is Pilot integration, not a patched NSH lifecycle.

## Isolated verification

```sh
bash apps/desktop/scripts/cargo.sh test --locked -p pilot-nsh \
  --features native-probes --test chat -- --test-threads=1
bash apps/desktop/scripts/cargo.sh clippy --locked -p pilot-nsh \
  --features native-probes --all-targets -- -D warnings
bash apps/desktop/scripts/cargo.sh build --locked -p pilot-nsh --features native-probes
apps/desktop/target/dev/debug/pilot-nsh --fixture --capture /tmp/nsh-light-wide.png
apps/desktop/target/dev/debug/pilot-nsh --fixture --dark --capture /tmp/nsh-dark-wide.png
apps/desktop/target/dev/debug/pilot-nsh --fixture --width 680 --capture /tmp/nsh-light-narrow.png
apps/desktop/target/dev/debug/pilot-nsh --fixture --dark --width 680 --capture /tmp/nsh-dark-narrow.png
```

The fixture binds an OS-assigned loopback port. Both the runtime and tests use
the actual production HTTP/WebSocket reader and courier against it. It makes no
provider/model/account calls. Automated captures require `--fixture`, create
hidden AppKit views and never activate a window. The synthetic host is test
authority only, not an alternate production transport.
`nsh/scripts/native-check.py` runs all four appearance/width combinations and
then starts a second process per profile to check exact saved-draft restoration.
It also checks that normal Send/Stop settled before closing. The adapter tests
cover a refused second writer and failed private save without a false close ACK.

## Slice boundary

Home, Inbox, Review, Missions, Automations and Settings are visibly unavailable.
Chat creation, attachments, question/permission responses, richer tool disclosure,
full-history Find, persistent sidebar preferences, update/package integration and
other workflows remain in the current app. Stored sources remain untouched;
unsupported image/artifact content shows a placeholder, never a browser fallback.
Earlier history uses the existing reader, but complete long-history navigation
and anchor qualification remain later acceptance work.

Tests and captures do not qualify hardware IME, cross-recycled-row selection,
large-history speed, OS shutdown/logout, power loss, updater close coordination or
Linux. No performance or production-completeness claim is made.

## Attribution

Existing MIT and third-party notices remain in `../licenses/`. NSH is unmodified
upstream Apache-2.0 code. Embedded fonts and Lucide icons keep their existing
attribution there; the source references the existing app assets and prototype
icon mapping rather than duplicating them.
