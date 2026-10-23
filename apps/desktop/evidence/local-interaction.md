# Local interaction implementation

Experimental source, not a default switch, release or Swift replacement.
All mutation verification uses synthetic daemons and isolated private state.
No real chat create/send/Stop/approval, visible unattended app or real content
capture was performed. The older `local-viewer.md` describes the earlier
read-only revision, not the current live write boundary.

## Implementation

- `chat_editor.rs`: live input capture before navigation, submit and receipt
  adoption. Deferred Change callbacks cannot drop the last character or turn a
  programmatic clear into a new revision. Marked text refuses keyboard/pointer
  sends. Pending UI requests latch by draft and request counter. Rendered
  Send/Stop controls retain their chat key. Late create acknowledgement only
  opens its target when the matching new draft is still selected and empty.
- `delivery_store.rs`: full-identity-owned, bounded private snapshots, persistent
  lock inode, safe permissions/no-follow regular files, initialization fence,
  immutable producer/sequence/operation/payload/target, durable atomic adoption.
  Terminal send revisions survive later Stop metadata. Recovery has a separate
  revision and shared immutable backing; delayed removal cannot erase newly
  withdrawn text. Empty records retire only after UI adoption. This is entirely
  separate from Swift state and backend receipt retirement.
- `interaction.rs`: single background owner for persistence and allowlisted
  HTTP writes, eight commands, 128 latest-edit slots, one coalesced full update.
  Full hello checks and fresh ordinary-chat permission checks before delivery.
  Original operation receipts are checked before posting; pending is never
  reposted, Unknown retries reuse the exact envelope, startup does not execute
  or reconcile automatically. Stop is once-only with explicit uncertainty.
- `local_model.rs`/`local_client.rs`: existing bounded live transcript, with
  queue counts and generation-safe clearing. Control/specialist/continued/
  archived chats stay readonly. No edit, archive, mark-read or approval route.

The Local API remains unauthenticated loopback + Origin rejection, as disclosed
for the viewer. Pinning identity is not authentication. No backend was changed.
New chats require the user to supply a folder, default to Ask, and never inherit
another agent's isolated worktree. Existing backend permissions remain authority.

## Reproduce

```sh
cd apps/desktop
bash scripts/check.sh
bash scripts/cargo.sh test --lib --locked private_snapshot_writer_workload -- --ignored --nocapture
bash scripts/cargo.sh build --locked
# Only by deliberate user choice, opens the real Local client:
bash scripts/run.sh --local
```

The complete check wrapper includes rustfmt, strict all-target Clippy, all library
tests and the native offscreen rendering executable. The interaction additions
cover private-file restart/corruption/missing-state/failed-write fences,
late acknowledgement, explicit same-envelope retry, pending/no-repost,
lost accepted replies, refusal/identity mismatches, once-only uncertain Stop,
normal close cancellation/flush, revision-safe recovery and bounded cleanup.
Actual Kit editor events cover rapid switches, double Enter/click, preedit,
read-only controls, stale acknowledgements and initial autosave revisions.
Earlier selection, tail, grapheme, streaming and read-only network tests remain.

Final verification on 2026-10-21: **56 library tests passed**, one opt-in disk
workload ignored by default (run separately and passed); rustfmt, strict Clippy,
native offscreen fixture/browser rendering and locked normal build all passed.
The existing dependency `block 0.1.6` still emits a future-incompatibility notice.

## Observations and gaps

An explicit synthetic 128-draft workload produced a roughly 4.02 MiB snapshot.
Ten full atomic updates took approximately 0.69 seconds on this host. This runs
off UI, but is a **write-amplification risk**, not a performance win: sustained
250 ms updates at that size can rewrite about 16 MiB/s. Large recovery snapshots
are more expensive. A later [bounded autosave checkpoint](draft-autosave.md)
reduces sustained typing writes without changing the atomic snapshot format;
these original numbers describe the earlier 250 ms fixed batching policy.
Incremental persistence/performance work remains warranted.
Streaming alone does not schedule draft saves, and unchanged permission updates
do not invalidate the composer. Recovery text is not joined/copied during render.

Native rendering remains offscreen and synthetic. It checks the existing
fixture/browser, not a visible interaction session. The companion static SwiftUI
layout artifact is a mock, not the compiled GPUI views. No smoothness, matched
Swift speedup, actual OS IME candidate-window or native Wayland claim is made.
The known giant-message parser scaling problem is unchanged.

Normal in-app window close and Cmd/Ctrl-Q wait for persistence before exit.
Crash/force-quit can lose edits still labelled Saving, not acknowledged saved
intent. GPUI's native Dock/system termination deadline and lack of a quit veto
remain a platform lifecycle gap; that path is not guaranteed to flush pending
edits. Corrupt/failed ownership keeps data intact and disables writes, rather
than silently emptying the store. Disk failures may require copying unsaved
text and restarting after restoring storage. These are prototype limits, not
shipping lifecycle parity.

Source/lockfile/patches/build instructions are publishable. Private state,
raw logs, identifiers, screenshots, targets and downloaded tools are not.
