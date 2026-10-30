# Exact artifact revision selection: contract audit

The native revision picker is **not implemented**. The existing API supports exact
reads, but exposes no bounded revision catalogue. Do not turn a latest revision
number into `1..=revision`, crawl bodies, or infer complete history from loaded
transcript entries. This is the contract-limited outcome of the explicit-picker
slice, not completion of artifact revision parity.

## Existing read surface

| Surface | What it establishes | What it does not establish |
| --- | --- | --- |
| `GET /api/sessions/:owner/artifacts` and the matching WebSocket `artifacts` message | Latest summary per artifact at the read point | Per-revision metadata, historical availability, or complete revision history |
| `GET /api/artifacts/:id` | Committed latest summary and owner lookup | A revision catalogue or an exact source body |
| `GET /api/projects/:project/artifacts` | Latest summaries across owning sessions | Revision history; this is not the current-chat gallery scope |
| `GET /api/sessions/:owner/artifacts/:id?revision=N` | One requested revision, or refusal/error | Permission to enumerate, completeness of earlier revisions, or a latest fallback on failure |
| Transcript `pilot.artifact` pins | Specific published revisions present in loaded history | Every revision, especially with lazy/partial history |
| `GET /api/missions/:id` artifact links | Stored mission/task references with owner, optional exact revision and that link's kind/title | A catalogue, continuing freshness or body availability; unpinned links are not exact pins |

There is no `/api/sessions/:owner/artifacts/:id/revisions` route. The native
gallery admits the first 64 validated latest summaries and labels truncation;
that client bound does not make this a historical catalogue. `ArtifactStore.list`
reads `latest.json` only, while `get` reads a single committed revision body.
Publication increments numbers, but latest metadata neither verifies nor lists
the older bodies. A missing historical file leaves the same latest summary.
Kind and title may also change between revisions, so latest kind/title cannot
serve as historical metadata.

Sources: [server routes](../../../packages/daemon/src/server.ts),
[session reads](../../../packages/daemon/src/sessions.ts),
[store](../../../packages/artifacts/src/store.ts),
[native index](../src/artifact_gallery.rs),
[exact parsing](../src/artifact_model.rs), and
[typed Local reads](../src/local_client.rs).

## Existing reader, intentionally unchanged

`ArtifactPane::open` retains an explicit reference. Canonical metadata refreshes
do not retarget an open reader; owner/host resets cancel it. Reader generations,
exact source parsing and clipboard generations fence asynchronous results.
Source/copy actions use the loaded revision, not the gallery's latest summary.
Images and native visuals keep their existing zoom/pan/selection; unsupported
legacy kinds remain inert inspectable source.

The current **Previous revision** button subtracts one and reuses the current
reference's kind/title. It is an exact read attempt, not proof that the prior
revision is available. Missing bodies fail; a historical kind change can be
refused by the known-kind check. This audit neither expands that behavior into
a picker nor changes it. The title's `rN` identifies the selected revision; it
does not certify that it is currently latest. No new Latest claim is justified
by a stored revision or by stale/missing current metadata.

The reader and [resource-link handlers](../src/artifact_link.rs) are untouched,
including scene-lifetime identity, immutable gesture capture, generation/revision
checks and selected-text activation suppression. No source, clipboard, focus,
IME, draft, interaction or delivery path changes in this slice.

## Contract needed before a picker

The read-only [mission artifact browser](mission-artifacts.md) uses only existing
mission-level exact pins. It is not a revision picker. Its reader disables
Previous revision so it cannot step into an unlinked revision; task pins remain
independent, and no latest metadata is used to fill missing pin fields.

This is a requirement for a separately approved backend slice, not a new API:

- A read-only owner/artifact-scoped catalogue with an explicit bounded page size,
  stable ordering, opaque continuation and truthful end/partial status. It must
  not require body reads or transcript hydration to enumerate choices.
- Each choice carries its own exact owner, artifact ID, positive revision, kind,
  title and stored provenance. Do not inherit kind/title from the latest summary.
  Catalogue membership must not promise that a later exact read cannot fail.
- Define consistency across pages and concurrent publication. Report latest
  revision separately at its read point, with explicit unavailable/error state.
  A catalogue read is not continuing freshness or a latest-follow subscription.
- Distinguish a valid empty result from unknown owner/artifact, refused access,
  stale/invalid metadata and transport failure. Preserve usable exact content on
  catalogue failure. Keep the existing Local hello/daemon identity gates.
- Reuse the existing exact source read. No filesystem fallback, source execution,
  publication, deletion, sends, or automatic link/control activation.

Once authorized, a single Kit Select replaces the existing revision navigation
within the one reader toolbar. Selection captures owner/artifact/revision and
daemon identity; a reader generation rejects obsolete completions, including
A→B→A. Refreshing the catalogue must not follow latest, reset selection or
transfer an old scene gesture. Displayed preview, source and copy/export must
share the same accepted exact revision, including pending/refused/error states.
Durable reader state and automatic latest-follow remain separate residual work.

## Isolated verification

`packages/daemon/src/artifacts.test.ts` now exercises the real loopback transport
and disposable stores: latest-only summaries, unavailable historical bodies with
unchanged summaries, historical image kind/source differing from latest inert
HTML, exact-read failure without latest fallback, and absent catalogue routing
without body probes. Owners remain parked; no kernel/provider/browser is used.

Run the full affected file and scoped lint/typechecking:

```sh
node --test --test-force-exit --test-concurrency=1 packages/daemon/src/artifacts.test.ts
node_modules/.bin/biome check packages/daemon/src/artifacts.test.ts
node_modules/.bin/tsgo -p tsconfig.json
```

No picker or other native source is changed, so there is no new native UI to
qualify at 680/1100 in light/dark, no rapid-switch/keyboard acceptance claim,
and no reason to build Rust or Swift for this contract-only change. Those hidden
actual-GPUI checks remain required when the catalogue-backed picker is built.
