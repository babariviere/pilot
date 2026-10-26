# Stored raster previews

Pilot Next reads exact stored Local image revisions without evaluating prepared
HTML, JavaScript, SVG, paths or URLs. PNG and JPEG render as a static preview;
GIF renders its first frame only. PNG animation is not played. WebP remains an
explicit unsupported preview, with its stored source and provenance retained.
The pinned WebP adapter does not forward an allocation budget to its underlying
metadata/animation decoder. See the [allocation audit](image-allocation-audit.md).

## Admission

The existing route is `GET /api/sessions/:owner/artifacts/:id?revision=N`,
surrounded by compatible Local identity checks. No new endpoint is introduced.
Canonical image JSON contains its data URL twice, in `source` and derived
`html`. Typed image deserialization skips prepared HTML, never executing it or
materializing it as a second preview string.

| Domain | Limit |
| --- | --- |
| Other/unknown HTTP reads | Existing 4 MiB |
| Known image revision JSON | 44 MiB, including redundant HTML |
| Stored image source | 22,369,656 UTF-8 bytes, matching storage admission |
| Encoded raster bytes | 16 MiB |
| Dimensions | 8192 per axis, 8,388,608 total pixels |
| Caller raw output | 32 MiB, checked before pixel allocation |
| Native BGRA frame | 32 MiB |
| GIF independent first-frame scratch | 32 MiB, reserved by the adapter |
| Other requested codec allocation limit | 96 MiB, advisory, not a total/RSS bound |

These budgets are independent. Sixteen-bit PNG can exceed raw-buffer admission
even when its pixel count fits. JPEG coefficient buffers and PNG/GIF metadata
are not all accounted by the same allocator limit. No total working-memory or
process-RSS ceiling is established.

Unknown transcript pins get the image quota only after an exact current-chat
canonical owner/id/revision match. Unindexed unknown pins retain the small read
quota and can fail on large responses. Image revision navigation requests an
image and requires the response to confirm image kind and exact owner/id/revision.
A kind-changing revision fails closed, rather than entering another runtime
under an image allowance. Visual source retains its existing 3 MiB and VM limits.

Canonical base64, MIME, raster signature, dimensions and raw/native buffers have
separate checks. Maintained codecs run on the selected reader thread, not the UI
or daemon event loop. EXIF orientation is applied before BGRA upload; dimensions
describe the oriented preview. Source bytes and their SHA-256 remain unchanged.

## Ownership and interaction

One FIFO permit admits image/untyped reads and decoding globally. Visible
readers wait their turn instead of showing an admission failure. An untyped
visual read releases this permit before entering the separately bounded visual
runtime. Closing or
switching cancels network work and checks cancellation between decode stages.
An in-flight codec is not forcibly preempted and retains admission until it ends.
Generation, owner and exact revision fences discard stale publication.

The pane retains one current decoded image and at most one retired image,
32 MiB each. The retired image is released through `App::drop_image` before a
new open and on All artifacts; remaining window resources end with the window.
No historical image LRU or data-URL-keyed GPUI resource loader is introduced.
Native Metal does not implement the test-support atlas `contains` query, so GPU
retirement is source/API evidence, not a dynamically measured VRAM guarantee.

Fit is the default. 100% maps one stored pixel to one device pixel independently
of application rem zoom. Zoom in/out stays between 10% and 800%. Fit and Reset
clear pan displacement; Contain preserves the painted aspect ratio. The native
viewport supports two-axis wheel/trackpad pan and middle-button dragging, plus
Option-arrow pan and ⌘+/⌘−, ⌘1 and ⌘0 keyboard controls in the expanded reader.
Ordinary transcript wheel packets never zoom content.

Source disclosure shows bounded provenance, not megabytes of base64 text.
Copy source explicitly prepares the exact stored string off-UI, then fences its
clipboard write by generation. Opening or displaying an image never copies it.
Native tab traversal/Space activation, previous revision, All artifacts and text
selection remain available. No image-to-clipboard operation is introduced.

## Verification

The scoped unit/transport cases cover canonical base64, MIME mismatch,
malformed/truncated input, dimension bombs, 16-bit raw-buffer admission,
independent GIF frame scratch, announced JPEG Extended XMP length, first-frame
GIF, early WebP refusal, exact wire quota/HTML skipping, same-title distinct IDs,
owner/revision/kind changes, identity/status gates, cancellation and stale pane
publication. Larger-than-old-text-cap image envelopes are accepted only on the
image path; unknown/visual reads keep their original limits.

The `artifact_images` target uses an owned faux HTTP server and the production
selected reader/pane. It asserts actual committed light/dark appearances at
680/1100 widths, BGRA pixel painting, two-axis actual-size overflow/scrolling,
fit reset, tab/Space, explicit source copy, revision pixel replacement, old
decoded-pixel release, Back, format/error states and copy-after-close/chat fences.

```sh
python3 scripts/check-scoped.py --unit artifact_image --native-probes --lint
PILOT_NEXT_IMAGE_DIR=/tmp/stored-image-captures \
  python3 scripts/check-scoped.py --test artifact_images --lint
```

Actual source/evidence receipts are recorded in the delivery handoff. Failed
preliminary runs are not passing qualification. Offscreen captures do not prove
OS IME/accessibility, visible motion, Linux support, runtime performance, whole-app
Swift parity or user acceptance. No real profile/account, live mutation, arbitrary
file/URL input, service or application restart is used.
