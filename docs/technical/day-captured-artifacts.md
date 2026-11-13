# Captured result artifact reads

The native read seam inspects existing numbered artifact revisions linked to a
task's current canonical delivered result. It is not the agent-authored NSH
artifact runtime, a rendered preview, user acceptance, or new artifact storage.
The result page uses it for **Inspect source** (see [Result page](#result-page)).

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

`apps/day/deliveryArtifact.ts` provides the Node-free typed call adapter. It
checks that a reply names exactly the pin it asked for, the linked kind and
`rendering: "unsupported"`, and otherwise treats it as `invalid`. The existing
output capabilities stay false for artifacts: source text is not a rendered
artifact capability, and the agent-authored artifact runtime stays separate.

## Result page

Each artifact output on the delivered-result page shows its title, kind and
pinned revision. A task result's pinned link has **Inspect source**; an unpinned
link or a standalone chat's link has none, and nothing looks up a latest
revision. One press makes one `day.delivery.artifact` read of exactly that
pin. Opening the page, a restored window and a hot update read nothing.

Each output keeps its own view: its source or its NSH preview, labelled with
kind and revision. Previews run in the app's isolated native engine
(`pilot/artifact-preview`). When the page opens, every pinned NSH output, up
to four, opens in its preview without a press; the sandbox, not the press, is
the safety boundary. This happens once per delivery: Hide keeps one closed,
and a newer delivery opens its own previews. At most four previews stay open
on a page (native compiles at most four at once); opening another closes the
oldest. Other outputs open on a press.

A preview pauses out of view (`onScreen.ts`). The page hands its `Scroll`
to `pageScroll`; 250 ms after scrolling rests, each preview measures itself
against it and unmounts its native component when no part shows. Unmounting
stops that engine (unmodified NSH 0.5 has no way to freeze one), so a preview
that shows again starts over from the same captured revision with fresh local
state. The compile cache makes the restart cheap.
Text shows as plain monospaced text; the first 400 lines or 40,000 characters
show until the user presses Show all, and the page says how much shows. An
image shows its title and kind only. `missing`, `oversize`, `redacted`,
`unsupported` and `invalid` each have their own sentence; none shows a part of
another revision instead. A refused read shows why and no source.

Each press clears that output's view before it awaits, and a generation
number drops any answer that is not that output's newest read. A newer
delivery, a changed pin or kind or a failed result read drops the affected
views at once. Hide, Escape (the view opened last first), leaving the page,
`startFresh` and `restoreView` drop them too. The views live in
`deliveryView.ts` only; SavedView never keeps them. A stale refusal reads the
result again, like an output link's. Reading sends nothing and is never the
user's check.

## Project and mission artifacts

The header's **Artifacts** opens the window's project page: every artifact its
chats saved, newest first (at most 100, then a note). A mission's overview has
an **Artifacts** section with its `MissionArtifactLink` rows grouped by task. A
pinned link keeps its revision; an unpinned link shows the current revision,
read when the section opens. Both pages share `ArtifactShelf.tsx`, a gallery
of cards in rows of three. A card shows the kind, title and revision; no
thumbnail is drawn, since NSH 0.5 cannot render an artifact to a still image
outside tests, and image bytes never reach Day. Opening the page starts no
preview. Opening a card reads its revision once and shows it under its row:
NSH in `ArtifactPreview.tsx` (with **Inspect source** to switch), other kinds
in `SourcePanel.tsx`. One artifact is open per page; opening another closes
it, and Escape closes it before leaving. Reading, empty and refused lists
each have their own state; a refused list never looks like an empty one.
Nothing polls.

`day.artifacts.read` takes `{}` or `{missionId}`. Native chooses the project
from its root, reads `GET /api/projects/:project/artifacts`, and for a mission
`GET /api/missions/:mission`, which must belong to that project. It validates
every row (artifact UUID, session ID, known kind, revision, project) and
refuses the whole list otherwise.

`day.artifacts.source` takes `{sourceSessionId, artifactId, revision}` and
reads `GET /api/projects/:project/artifacts/:session/:artifact?revision=N`.
That route needs the native capability and `Cache-Control: no-store`. The
daemon checks that the chat belongs to the project now and has that revision,
reads the numbered container with the same reader, limits and redaction as a
delivered output, and refuses access changes during the read. It never falls
back to another revision. Native projects only the inert fields, as above.

## Compile cache

`artifact_runtime.rs` compiles the fixed artifact kit once per process. It
keeps the compiled entry module of the eight most recent sources by their
SHA-256, after `artifact_source::verify` checks the exact bytes, ids and
revision. It keeps code only, never an engine, its state or a grant, and saves
nothing to disk. Every open still reads the exact revision through the native
checks above and starts a fresh engine.

Focused tests use isolated saved revisions and synthetic sessions, with workers
disabled. They cover exact older revisions, stale delivery/source pins,
membership, ABA, missing/oversized/redacted/corrupt bytes and legacy kinds.
Native tests use the released hidden host channel. No test opens a window,
invokes historical code or reads a live source.

`native/tests/delivery_today.rs` also compiles the actual `Connected.tsx`
entry and drives `ConnectedDelivery.inspect` through the released hidden
channel. Its saved-revision fixture (`day-delivered-artifact.ts`) counts
artifact GETs and their exact query pins. The connected checks cover one
acquisition per press, plain saved text, local Show all with unchanged stored
bytes, stale access, and a cold reopen that keeps the unsent New goal, Send
back note and navigation without rereading source or changing verification.
The fixture uses real isolated daemon storage with workers disabled.

For deterministic denial and late-answer ordering, that same test target
first acquires inert envelopes through the real native handler, then scripts
only `day.delivery.artifact` replies at the released channel. Those cases
qualify the actual connected adapter and screen, not daemon denial or HTTP
timing. The native bridge/access tests remain separate. Every window closes
its engine before awaiting its native owner; saved-window/journal reads use
a fresh channel after that close. These are headless behavior checks, not
visual, live-service or full daily-driver acceptance.
