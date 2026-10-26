# Stored conversation image previews

Pilot Next offers **Preview image** for already-loaded, committed Local message
image blocks. PNG/JPEG show a static raster; GIF shows only its first frame.
WebP and other formats, missing inline bytes and over-budget content retain a
truthful placeholder. Preview failures stay beside the image, with Retry preview.
Hide image releases the current preview. Normal text selection/copy is unchanged;
Copy source identity copies bounded provenance, never image bytes.

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

One nonqueued global permit is shared with artifact previews. The transcript
retains one current decoded raster (maximum 32 MiB), not an image LRU; a retired
raster can briefly remain until the deferred app-resource release runs. Explicit
preview avoids eagerly decoding a whole loaded history. Source strings and pixels
are Arc-backed; rendering neither clones base64 nor decodes pixels. Decoding,
orientation and BGRA conversion use the background executor. A canceled codec
retains the permit until it finishes bounded work. A busy permit produces a
retryable placeholder, not a queue. Generation/source/entry changes, Hide and
release cancel work, discard late results and retire painted pixels with
`App::drop_image`. No native GPU residency measurement is claimed.

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
