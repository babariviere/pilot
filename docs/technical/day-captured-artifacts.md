# Captured result artifact reads

The native read seam inspects existing numbered artifact revisions linked to a
task's current canonical delivered result. It is not the agent-authored NSH
artifact runtime, a rendered preview, user acceptance, or new artifact storage.
There is no UI in this backend change.

## Acquisition and access

`ArtifactStore.readCapturedRevision` reuses the existing passive host reader's
committed-pointer ceiling and explicit numbered JSON file. It limits the stored
container to 1 MiB before allocation/JSON decoding, refuses final symlinks and
changed files, and checks the exact artifact/session/project/revision. The
existing review-only `readStoredRevision` still requires a supported visual
representation. The write path and revision history are unchanged.

Do not use `ArtifactStore.get` for this seam: it can rebuild image HTML. Do not
use review-vault capture/reopen: those require reviewer allocation, policy and
validator pins and do not grant user-result access. No vault, source discovery,
path search, worker startup or preview preparation runs here.

`GET /api/projects/:project/missions/:mission/tasks/:task/delivered-work/artifact`
requires the existing native capability and `Cache-Control: no-store`. Query
fields are exactly `targetId`, `deliveryId`, `ownerSessionId` (empty for null),
`sourceSessionId`, `artifactId`, and positive `revision`. Duplicate, missing or
additional query fields are refused. The shared wire contract is
`packages/protocol/src/delivered-artifact.ts`.

The daemon crosses the mission durability barrier, checks the canonical
delivery subject/target/delivery/owner, and requires an exact task artifact link
with that source and revision. The source and current owner must still belong
to that mission and project. A standalone chat or unpinned link cannot select a
revision. No latest fallback or revision catalogue exists. Current source
membership is access, not a claim that historical evidence is still current.

After source I/O, the daemon checks those pins synchronously again. Temporary
mission/session/project change listeners also reject in-flight changes,
including membership leave/rejoin ABA. They are removed before returning.
No task, delivery, review, verification or source record is written.

## Inert results only

HTML, React, SwiftUI, shader and visual revisions can return their saved source
as plain text, at most 512 KiB. The response includes the original numbered
container's SHA-256 and byte count. Those identify saved bytes, not an original
agent submission, rendering, test success or acceptance. Prepared HTML, visual
data and historical callbacks never leave acquisition. Never evaluate the
returned source or give it host capabilities.

Every reply says `rendering: "unsupported"`. Images are metadata-only with
`content: {state:"unavailable",reason:"unsupported"}`. This seam does not decode
or render image bytes, GLSL, Mermaid, native visual trees, SwiftUI or browser
documents. Oversized images also remain unavailable. No partial/truncated
source substitutes for missing or oversized bytes.

`missing`, `oversize`, `redacted`, `unsupported` and `invalid` are distinct content
states. Current access/selection failures refuse the entire read, rather than
returning formerly readable content. The existing conservative diagnostic
redactor checks source/title; changed text is withheld, not silently presented
as the saved source. The active native capability is also treated as a known
secret. This is conservative credential filtering, not proof that arbitrary
artifact prose contains no private information.

## Native bridge

`day.delivery.artifact` accepts the exact selection fields above, with `subject`
instead of route path components. Rust validates the selection, checks the
canonical delivery before the authenticated artifact read, and
projects only the inert version/reference/metadata/content/rendering fields.
The artifact endpoint is the final asynchronous disclosure barrier; its final
source-membership check cannot be replaced by a later delivery-only GET.
The selected native project/home and close/flush gates still apply. It does not
invoke the URL opener, filesystem reveal, shell, renderer or any HTTP POST.
The read is never journaled, automatically retried or replayed on cold open.

`apps/day/deliveryArtifact.ts` provides a Node-free typed call adapter for a
future viewer. The existing output capabilities stay false for artifacts:
this source-text seam alone is not a usable preview/UI capability. UI work
remains separate, using the established output-page design.

Focused tests use isolated saved revisions and synthetic sessions, with workers
disabled. They cover exact older revisions, stale delivery/source pins,
membership, ABA, missing/oversized/redacted/corrupt bytes and legacy kinds.
Native tests use the released hidden host channel. No test opens a window,
invokes historical code or reads a live source.
