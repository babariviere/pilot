# Clipboard images and composer attachments

Paste a copied image into the Local composer with the normal Paste command, or
drop PNG/JPEG/GIF/TIFF files onto its editor. Selected images appear in a
horizontally scrollable strip **above** the composer, with readable contained
thumbnails and keyboard-accessible Remove actions. Ordinary text paste is still
owned by Kit. Mixed image/non-image file clipboard selections remain text.

This reuses Swift's `ImageAttachments.message(text:)` contract, not a new image
send endpoint. Off the UI thread, Next normalizes the upright first frame to an
immutable private PNG. The durable draft stores each attachment's UUID, exact
path and content hash. Parent, named subagent and new-chat drafts stay separate.
The existing immutable send operation carries read-tool file instructions. The
model can read those files, just as it does for Swift attachments. No image upload,
backend contract or new host capability is added. Sends with these attachments
require a freshly confirmed ordinary Build session (or a new Build chat).
Legacy Ask and scoped coordinators admit only Swift's separate attachment
folder, not Next's private store. Next retains the draft and refuses those
unsupported sends; it does not expand their access or share Swift-owned files.

Selected previews share the existing queued image-decoder lane, compressed input,
axis and pixel limits. Only small thumbnail rasters stay in the composer. There
is no attachment visibility cap. Files are retained after Remove or accepted
delivery because historical/queued/Unknown messages may still reference them;
this change does not introduce automatic attachment-file garbage collection.
New inputs cannot send during import, but Stop's existing ownership is unchanged.
Import and thumbnail completions retain their captured draft/source identities.
Normal draft durability, refusal, Unknown and no-replay behavior remain in place.

Displayed conversation images and raster artifacts offer **Copy image** on hover
or keyboard focus, also in their expanded reader. This writes a native PNG image
clipboard entry containing the displayed upright first frame, not source text,
a path or a screenshot. Copy source and provenance remain separate actions.

## Verification boundary

Focused unit checks decode the copied clipboard PNG and compare actual pixels,
exercise TIFF import, malformed/oversized inputs, exact durable attachment
identity and Unknown recovery. Hidden native probes cover the real Paste and
Copy image handlers, previews above the tray, Remove, image-only Send, ordinary
text paste, IME guards and parent/subagent draft separation at 680/1100 in both
themes. Their clipboard is GPUI's test-platform clipboard, not the OS service.
These checks do not qualify copying from a particular external application,
OS clipboard negotiation/Wayland asynchronous paste, or OS IME. No live app,
daemon, profile or installation is used.
