# Stored conversation image previews

Pilot Next automatically shows already-loaded, paint-visible committed Local
message images. PNG/JPEG show a static raster; GIF shows its first frame.
Unsupported or decoder-rejected content retains a truthful placeholder. Click the
image or Expand for the native reader. Fit, 100%, zoom and Reset are contextual
reader controls; two-axis wheel/trackpad scrolling pans magnified content.
Ordinary transcript scrolling never changes zoom. Copy source identity retains
bounded provenance; expanded Copy source retains the exact embedded data URL.

## Actual source contract

Daemon history and chat-stream entries carry `entry.model[message].content[block]`
pi-ai blocks shaped `{type:"image", mimeType, data}`. `data` is raw canonical
base64, not a URL. The existing selected reader checks compatible hello daemon
and storage-lineage identity, selected session, stream and sequence before reducing
messages. Image rows retain that pinned host/chat, canonical entry/message/block
key and SHA-256 of MIME + NUL + exact base64. Presentation IDs are not provenance.
Uncommitted generation images are not previewed. Unsupported content is not sent
through Markdown's image loader.

Swift's `PilotCore/Transcript.swift` currently reduces image blocks to `[image]`.
`ImageAttachments.swift` stores clipboard images and submits textual instructions
with attachment paths; the read tool's subsequent image result uses the inline
block contract. There is no general conversation-image asset GET contract in the
daemon. This implementation neither interprets those paths nor borrows the
separate artifact revision route. Path-only attachments remain text. The parent
attachment workflow is unchanged: no picker, paste, drop, upload, send, filesystem
fallback, remote image fetch, new endpoint or host capability.

## Bounds and ownership

Local hello/history reads have no size cap; artifacts retain their
[image-envelope budget](local-read-budgets.md). The
WebSocket frame and whole-message reads also have no source-byte cap.
Loaded message text and inline image base64 have no per-message or aggregate
source-byte limit. Exact sources remain retained regardless of their combined
size, including history pages, live commits and same-head reconnects. Existing
entry, row and content-block counts still apply. Hashing and reduction run on
the Local reader, not in rendering. Memory usage scales with retained source;
this is not an RSS guarantee.

Decoding reuses `artifact_image.rs`, without changing formats or limits: separate
source/compressed-size admission, canonical base64/MIME/signature validation,
8192 per axis, 8,388,608 pixels, 32 MiB raw/native output, 32 MiB independent GIF
frame scratch, and existing advisory codec allocation limits. See the
[raster allocation audit](image-allocation-audit.md). These are not an RSS ceiling.
No animation-frame collection or WebP decoder is introduced.

One FIFO global read/decode permit is shared with artifact previews. Every
paint-visible supported row queues automatically, not just a selected image.
The transcript retains decoded pixels only for visible rows, retiring them on
scroll-out, replacement, scope change or reset. Each raster keeps its existing
32 MiB maximum; the viewport and existing row counts bound the number
of visible entries. There is no eager whole-history decoding or image LRU.
Source strings and pixels are Arc-backed. Rendering does not decode pixels.
Cancellation retains admission until bounded codec work finishes. Source,
scope and cancellation-token checks reject late results, including same-row
replacements. Expanded readers observe their canonical source and become inert
if it is replaced or removed. The native dialog owns focus restoration and
uses Kit's normal window-selection clearing on modal entry/exit. Composer draft
text, its selection and active preedit remain with the existing editor owner;
marked text prevents sibling reader opening before pointer blur.

Loading rows reserve a 12-rem viewport. Decoded images hug their aspect-fitted
size, using the available conversation width and a 720pt height ceiling without
enlarging small images (48pt minimum click target). This follows Swift's actual
transcript `ArtifactCard` / `ArtifactViewerLayout.inlineSize(image: true)` policy,
not composer attachment thumbnails. Next retains its existing conversation
column width rather than imposing Swift's separate 760pt artifact column cap.
Raster artifact rows use the same fitting policy; native visual sizing is unchanged.
Contain preserves the complete image without cropping or stretching. Decode
completion remeasures the affected list row through the existing scroll owner,
preserving follow/reading anchors. Unsupported rows stay compact. Existing
virtualized reader keys, text parsers and copy paths remain authoritative.

## Scoped synthetic verification

```sh
python3 scripts/check-scoped.py --unit conversation_images --test conversation_images --lint
python3 scripts/check-scoped.py --unit local_model --native-probes
python3 scripts/check-scoped.py --unit local_client --native-probes
python3 scripts/check-scoped.py --unit artifact_image --native-probes
```

The owned faux loopback fixture exercises real hello/chat/entry projection and
rejects wrong-chat content. Native probes mount the production transcript at
680/1100 in light/dark, inspect painted BGRA pixels, shrink/grow its actual parent,
copy user text/provenance, retain a Markdown text selection, replace same-ID sources,
mount unsupported/decoder-error
states, preserve a reader anchor with tall streaming text, and cancel on reset.
All windows are offscreen. No production profile, live mutation or app/daemon
restart is involved. This is not OS IME, performance, Linux, production or whole
Swift-parity acceptance.


Source regressions retain exact Unicode text above 1 MiB plus multiple real PNGs
above 1 MiB each, exceeding 8 MiB combined. They exercise snapshot/prefix,
history paging, same-head reconnect, entry append, live text deltas and committed
images, retaining canonical identities and hashes. Native probes scroll through
six large image rows from the same pinned faux Local source and await real
decode. Codec rejection remains separate: 16 MiB compressed input (including
its base64 envelope admission), axis/pixel/output and GIF scratch bounds are
unchanged; rejected sources remain retained rather than source-budget placeholders.
