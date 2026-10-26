# Stored conversation image previews

Pilot Next automatically shows already-loaded, paint-visible committed Local
message images. PNG/JPEG show a static raster; GIF shows its first frame.
Unsupported or over-budget content retains a truthful placeholder. Click the
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

The existing Local wire caps remain 4 MiB per HTTP read and 8 MiB per WS frame.
Inline bytes share the existing 1 MiB per-message source budget with displayed
text, and the existing retained-history source quota (8 MiB minus existing live
and tool reservations). An additional 64 KiB is conservatively reserved while
admitting image blocks for small identity/placeholder rows. Metadata and row
counts remain bounded. Larger sources are not cloned into the projection. Hashing
and reduction run on the Local reader, not in rendering.

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
32 MiB maximum; the viewport and existing source/row budgets bound the number
of visible entries. There is no eager whole-history decoding or image LRU.
Source strings and pixels are Arc-backed. Rendering does not decode pixels.
Cancellation retains admission until bounded codec work finishes. Source,
scope and cancellation-token checks reject late results, including same-row
replacements. Expanded readers observe their canonical source and become inert
if it is replaced or removed. The native dialog owns focus restoration and
uses Kit's normal window-selection clearing on modal entry/exit. Composer draft
text, its selection and active preedit remain with the existing editor owner;
marked text prevents sibling reader opening before pointer blur.

Supported rows reserve a 12-rem image viewport. Loading, decoded content and
failure replace content inside it without moving subsequent rows. The absolute
image box fits the actual available transcript width with Contain; it has no
intrinsic-size overflow. Unsupported rows stay compact. Existing virtualized
reader keys, scrolling, text parsers and copy paths remain authoritative.

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
mount unsupported/overlimit/error
states, preserve a reader anchor with tall streaming text, and cancel on reset.
All windows are offscreen. No production profile, live mutation or app/daemon
restart is involved. This is not OS IME, performance, Linux, production or whole
Swift-parity acceptance.
