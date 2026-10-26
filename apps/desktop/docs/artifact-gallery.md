# Current-chat artifact gallery

Open **Artifacts** in a Local chat. The native gallery shows only that chat's
canonical metadata, at most64 artifacts. Tiles keep title, type and exact
revision. Stored images load lazily; other kinds remain discoverable as honest
placeholders. Selecting a tile opens its captured revision, not whatever became
latest while the click or reader was waiting.

This is a scoped gallery, not global/project browsing or full artifact parity.
Swift remains available. HTML/React/browser execution, shaders and native SwiftUI
preview generation remain deferred.

## Interaction and state

The gallery's job is choosing an artifact, not displaying renderer internals.
It replaces the text-button wall without adding a dashboard or per-tile toolbars.
Title/type/revision and meaningful failures remain visible; full source,
provenance, detailed codec errors and previous revisions stay in detail.

- Native Buttons support pointer activation and Tab/Space. With the gallery
  itself focused, arrows, Home/End and Page Up/Down move the canonical target;
  Enter/Space opens it. Navigation never sends a chat message.
- Back restores the gallery's owned focus, target and scroll handle. Reordering
  reconciles a canonical top anchor where possible; width/rem changes rebucket
  uniform rows without using window width as a substitute for containing width.
- Long Unicode titles have a bounded two-line region and a full native control
  name; opening detail preserves the full title/source. IDs, not titles or list
  indices, distinguish otherwise identical resources.
- A matching, valid artifacts message establishes received metadata. Before that,
  loading is not empty. Invalid refreshes keep the last usable index; transport
  failure marks it stale. Only a valid received empty index says there are no
  artifacts. A source read still passes both Local hello identity gates.
- Retry previews is contextual and explicit. Decode/read failures do not create
  an automatic retry loop. Source remains readable through existing detail.
- A newer metadata revision may update the gallery, but never retargets an
  already-open or pending exact detail. Owner/host changes cancel it instead.
- Existing entry handlers reuse the caller's navigation/draft/IME guard. Composer,
  delivery identity, transcript storage/anchors and authority remain caller-owned.

## Bounded pipeline

The existing protocol supplies artifact summaries and exact stored revisions,
not native thumbnails. Prepared HTML is **not** a thumbnail. There is no new
endpoint, global crawl or external image fetch.

| Domain | Bound / ownership |
| --- | --- |
| Metadata |64 validated matching-chat refs; explicit first64 label when truncated |
| Desired reads | visible rows plus at most one overscan row, at most12 image refs |
| Source work | one gallery actor, one request and one unacknowledged result; no per-card workers |
| Shared admission | existing nonqueued global image read/decode permit, capacity1 |
| Thumbnail | at most512x320 physical BGRA pixels,640KiB |
| Active CPU cache | LRU, at most12 images and8MiB |
| GPU-eligible active pixels | same12 images /8MiB logical pixel budget |
| Retirement | at most12 images /8MiB pending explicit drop_image |
| In-flight thumbnail | at most one additional640KiB output |

Active and retiring app-owned logical thumbnail pixels therefore have a16MiB
combined budget. These are not a process RSS or physical VRAM guarantee. Codec
scratch, transient full input/raster, renderer atlas page rounding and internal
draw-frame retention are separate. See [stored image limits](stored-images.md)
and the [allocation audit](image-allocation-audit.md).

Only canonical image refs enter the thumbnail actor. It reuses the strict typed
read, known-kind/owner/revision checks and decoder admission. WebP is refused
before base64/decoder construction; PNG/JPEG and labelled GIF first frames use
the existing decoder. Full HTTP/source/encoded/raster objects are transient in
one admitted off-UI operation. Downsampling borrows BGRA pixels rather than
cloning a full32MiB raster. Only the small owned RenderImage reaches a card;
cards/cache entries never retain a22MiB source or full raster. Stored image
reads necessarily transfer the full admitted source because no thumbnail
contract exists.

A lightweight actual-viewport prepaint observation defers a named visibility
intent only when geometry changes. Item renderers do not fetch: uniform_list
also invokes them for offscreen measurement. The handle's last_item_size.item
is the list viewport; row stride derives from total contents height / row count.

Detail has priority. Selecting it stops the gallery actor, drops its cancellation
sender and waits only on a separate completion receiver. Completion follows
permit/source/full-raster teardown, including read/init failure. The UI waiter
never owns the worker it is waiting to stop. A completed detail may still have
an unconsumed large snapshot, so Worker::drop closes/drains output before the
completion is awaited. Back similarly waits for detail cleanup before new
thumbnail work. Pending drains survive scope changes. Generation, reader epoch,
attempt, cancelled-attempt state, current metadata and desired-key checks reject
stale thumbnail results.

Hide, owner/host reset, metadata eviction and view release retire image handles.
Deferred App callbacks run after the current window is reattached and explicitly
drop images. Native Metal's contains query cannot prove GPU residency; checks
use decoded weak-reference release and actual painted replacement, plus the
source/API retirement contract.

## Source index and focused checks

Paths below are relative to apps/desktop.

- src/artifact_gallery.rs: canonical keys/index state, visibility policy,
  borrowed thumbnail generation and bounded cache.
- src/artifact_gallery_worker.rs: image-only actor, cancellation, completion and
  one-result acknowledgment.
- src/artifact_gallery_view.rs: native layout, key/pointer intent, scope/drain
  ownership, viewport observation and image retirement.
- src/artifact_view.rs and src/artifact_worker.rs: retained exact detail route,
  completion barrier and queued-source/raster cleanup.
- src/local_client.rs and src/local_view.rs: actual metadata receipt/stale state
  and existing guarded entry/hide integration.
- src/artifact_gallery_tests.rs, src/artifact_gallery_worker_tests.rs and the
  gallery-named artifact_worker tests: policy/limits/faux reads/lifetime guards.
- src/artifact_gallery_probe.rs and tests/artifact_gallery.rs: actual synthetic
  mounted680/1100 light/dark cases, pixels, keyboard/pointer, Unicode, scroll,
  refresh/pending revision, cache release and metadata states.
- scripts/{check.sh,ci.sh,test_ci.py}: native registration in existing CI.

Select only the changed scope through the existing shared admission:

    python3 scripts/check-scoped.py --unit artifact_gallery --test artifact_gallery --lint

For a view/probe-only correction, use --test artifact_gallery --lint and explicitly
map unchanged unit evidence. No real Local profile, content, sends or mutations
are used. Captures are actual offscreen GPUI, not SwiftUI mocks, visible motion,
OS IME/AX, Linux/Wayland, RSS/performance or full-parity acceptance.

