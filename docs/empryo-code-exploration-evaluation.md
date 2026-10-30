# Empryo exploration patterns for Pilot

## Decision and evidence boundary

**Keep codemode composition; adapt bounded discovery and on-demand context; defer a persistent index.**
File imports and historical co-change can help investigation, but must never masquerade as callable
caller witnesses or acceptance evidence. This is an independent, docs-only source study for the
remaining-relationships evaluation (#32), not implementation approval or a substitute for its work.

Inspected 2026-10-30:

- External source: [`proxysoul/Empryo` at `c27dac116d2ee1637abfc6634bebf08b5c379454`][E-root].
  The repository identifies itself as the public **SoulForge v2 core**, not full Empryo v3;
  package metadata says `@proxysoul/soulforge` 2.20.25 [E-scope], [E-package]. No private v3
  implementation, marketing benchmark, or README performance claim is evaluated here.
- Original Pilot study baseline: [`fa9662723f3aaf2d57aefabab4c5c7cdec6f8726`][P-root], the remote `main`
  HEAD observed before editing. “Shipped” below means landed code at this baseline, not proof
  of the currently running app/runtime version. Historical `P-*` references remain pinned there;
  the delivered update below uses separate current `N-*` references rather than moving old anchors.
- **Observed** means implementation or assertion read, not tests executed. **Inference** means a
  consequence/gap inferred from that code. **Proposed** means a contract needing separate validation.
  No external code was installed, imported, executed, or copied into Pilot. No tool-performance,
  retrieval-quality, token-savings, or native-responsiveness qualification was performed.
- Multi-root caller impact (#21) was **prepared/unlanded at the original study baseline**. It has
  since landed; the next section refreshes that capability/cost comparison without rewriting the
  historical matrix. Broader languages/types/value references, structural comparison and before/after
  edge analysis remain #32's separate work.

### Delivered update at publication

Reconciled source: [`6149d396c0211eb16541c425cea869df7c2192ff`][N-root], including delivered
`code_impact` commit `3540a30473b08fa0b2327992c4114711f1a7ef09`. Inspected the current implementation,
assertions and documented observations; this study did **not** rerun its tests or benchmarks.
This update supersedes the original baseline's single-root-only and query-specific freshness gaps;
the proposals remain unevaluated.

- **Now landed:** `code_impact` accepts 1–8 exact TS/JS callable roots in one host-selected bounded
  scan. `scanCallGraph` shares the existing lexical/relative-ESM resolver and graph with call paths;
  `scanImpact` performs multi-source BFS, excluding selected roots from caller results. Each caller
  gets **one deterministic shortest source-edge witness to a nearest root**, not every affected
  root or every path. Unknown/ambiguous calls remain unassigned; counts are explicitly non-exhaustive.
  No runtime, type/value-reference, other-language, complete-impact or retained comparison capability
  is added [N-graph], [N-impact], [N-contract].
- **Now landed receipts:** all exploration responses add opaque source/observed-revision IDs.
  Call-path and impact queries share the same graph strategy; `code_impact.expectedRevision` rejects
  a changed observation before root selection/traversal. Scope/strategy and observed bytes/coverage
  matter: receipt equality is not guaranteed across text-search, symbol and graph strategies. Live
  receipts still describe **per-file non-atomic observations**, not atomic trees, retained snapshots,
  freshness leases or current authorization. Missing/unread files have no content-freshness guarantee
  [N-receipt-source], [N-receipt-final], [N-impact-doc].
- **Source/assertion checks:** shared graph construction/resolution/SCC code moved from historical
  `call-path-scan.ts` to current `call-graph.ts`; directional traversal remains in `call-path-scan.ts`
  [N-graph], [N-paths]. Current tests assert one read per fixture file, connected hash/span-backed
  witnesses, nearest-root ties, nonlinks/unknowns, non-root/coverage/workspace invalidation, pinned
  lower-layer isolation, mixed live windows and cancellation/bounds [N-tests]. The original pinned
  `P-*` anchors still resolve to their historical implementation; `N-*` anchors identify the moved
  code and additive receipt/impact behavior, rather than assuming old line numbers still apply.

The landed delivery documents these **Pilot-only synthetic observations**, not measurements against
the external core [N-cost], [N-benchmark].

| Files | Three caller scans: median wall / CPU | One impact scan: median wall / CPU | Peak sampled RSS increase, three / one | JSON bytes, three / one |
| --- | ---: | ---: | ---: | ---: |
| 132 | 428 / 647 ms | 152 / 222 ms | 18.8 / 41.8 MiB | 28,744 / 24,319 |
| 396 | 725 / 1,155 ms | 231 / 372 ms | 19.6 / 53.2 MiB | 28,747 / 24,320 |

Reported conditions: macOS arm64, Node 24.21.0, five samples per variant, alternating pair order,
warm filesystem, fresh workers, clean `PILOT_*`/`NODE_OPTIONS`. Both variants assert the same four
distinct non-root callers with full file coverage and no graph-record truncation; explicit depth
limits still apply. Three caller queries emit nine edge rows requiring deduplication; impact emits
four callers with connected witnesses. Largest reported heartbeat gaps were 8.6/8.4 ms (132 files,
three/one scan) and 6.4/6.0 ms (396). Process-wide RSS sampling can miss transient peaks and reflects
allocator/GC carry-over; sampled RSS was **higher**, not lower, for batching. These are documented
bounded observations, not general speedups, token savings, external comparative measurements or
production-preload/live-session/GUI responsiveness qualification.

**Recommendation after delivery:** use codemode for search/filter/outline/read orchestration and
the landed `code_impact` for bounded overlapping-root caller questions. This addresses repeated scans
without a new pipeline DSL or persistent cache. It does not fill the fuzzy-discovery, separate
file-import/history, context-packing or #32 comparison gaps. Do not build a second resolver or
relabel nearest-root witnesses as complete root attribution.

### License boundary

The inspected core uses Business Source License 1.1. Its Additional Use Grant excludes offering it
to third parties on a paid, hosted, embedded or commercial basis; internal/non-commercial research
is permitted. The stated change date is March 15, 2030, with Apache 2.0 as change license [E-license].
The commercial guide explicitly lists embedding and commercial distribution as requiring a separate
license [E-commercial]. Empryo License 1.0 applies only to copies supplied under its v3 terms and
expressly preserves earlier SoulForge licensing; it also restricts commercial embedding/wrapping
[E-v3-license]. Public availability is not permission to embed this engine. These are independently
described patterns, not a port or legal clearance. Any future reuse of code/assets/libraries requires
separate license review and applicable permission; renaming a wrapper does not resolve it.

## Capability and gap matrix

| Pattern | Observed public core | Original Pilot baseline | Recommendation / inferred gap |
| --- | --- | --- | --- |
| Search → filter → expand → outline/read | `soul_query`: path working set, up to 12 stages/200 files; dependency stages replace the set; outline emits up to 40 files/60 symbols each; read up to 10 files [E-query]. | Codemode can chain tools, filter locally and batch independent calls. SDK fixture chains symbols → exact call paths → search [P-compose]. One call-path query shares one scan/parser/graph across traversal, **not across separate tool calls** [P-calls]. | **Adopt composition practice, defer pipeline API.** Codemode already removes intervening model turns and can suppress intermediate output. New syntax does not itself save parsing/I/O or establish snapshot consistency. Shared multi-root reuse belongs to #21, not this study. |
| Fuzzy file/symbol discovery and importance | `soul_find` combines case-insensitive exact/substring symbols, path matches, subsequence path scoring, PageRank, co-change boosts and file-type penalties [E-find], [E-fuzzy]. It is not an edit-distance symbol resolver. | Literal search; case-sensitive symbol substring/exact, deterministic exact/prefix/substring ranking. Existing `find`/`ls` discover files. No fuzzy symbol mode, graph-centrality ranking, or unified scored file/symbol discovery in these tools [P-tools], [P-rank]. | **Adapt optional fuzzy discovery**, only if labeled fixtures beat substring/path composition. Preserve exact mode and deterministic ties. **Defer PageRank**: useful overview hypothesis, not relevance or semantic proof; may demote the tests/docs needed for a question. |
| Token-budgeted, on-demand context | Repo-map render ranks files/signatures, estimates tokens, fits blocks and adds directory coverage. Context manager can freeze rendered bytes with idle TTL and separate updates [E-render], [E-estimate], [E-freeze]. | Paged spans/snippets and explicit coverage; agents choose when to read more. 48 KiB JSON response budget is **not** a model token budget [P-page], [P-tools]. No repository-map injector in this exploration API. | **Adopt on-demand outline-before-read**, first as a codemode recipe. **Adapt explicit estimated-token packing** only after measuring usefulness; retain byte limits and omissions. **Reject mandatory broad prompt injection** or a frozen prompt being treated as current source. |
| File dependencies/dependents and history | SQL file graph contains import, identifier-inferred, co-change and barrel-expanded edges; dependency query hides their confidence/type. Historical pairs also have a separate query [E-edges], [E-relations]. | Direct callable lexical binding / relative ESM edges with callsite witnesses and explicit unknowns. No agent-facing general file-import or history co-change API in the shipped trio [P-calls], [P-tools]. | **Adapt separate import relations** as a small future candidate. **Defer historical correlation** pending a concrete investigation benefit. **Reject mixed “affected files”/safety semantics**, name-only call linkage, and automatic editing of correlated files. |

### Implementation findings that change the recommendation

1. **Candidate discovery is not literal search.** `soul_query`'s search stage calls
   `searchTrigramCandidates`, then directly uses returned paths. It does not verify the literal.
   That helper describes a possible-match set and returns `null` when unsuitable/unpopulated;
   the pipeline turns `null` into `[]` [E-query], [E-trigram-query]. Short queries can therefore
   become “no files matched”; matching trigram sets need not establish the ordered substring.
   The posting writer stops adding files after 512 postings per trigram, while intersection has
   no saturation fallback [E-trigram-write], [E-trigrams]. **Inference:** saturation can omit real matches.
   The read tests use small fixtures, not this saturation case [E-trigram-tests]. Do not adopt
   “index candidates = hits” or “index unavailable = empty.” This is source reasoning, not an
   executed reproduction or a claim about private v3.
2. **A pipeline is not a read transaction.** Stage failures from awaited map operations can be
   swallowed by `safe` into empty/null; readiness failure is success text. Outline/read append
   output immediately, so a later `limit` does not bound blocks already emitted [E-query].
   The four pipeline tests cover search/filter, outline, limit and empty input, not dependency
   correctness, stale reads, permissions changing mid-chain or aggregate byte/token limits
   [E-query-tests]. Pilot composition must preserve errors/partial metadata, apply limits
   **before** expensive reads, and distinguish a stage's observed set from exhaustive coverage.
   Its `find` stage calls `findSymbols` (case-insensitive exact names), not the standalone fuzzy
   file/symbol aggregator, despite the pipeline description [E-query], [E-symbol-query].
3. **Importance is deliberately heuristic.** PageRank runs over weighted file edges, downweights
   type-heavy targets and personalizes toward mentioned/edited/editor/entry files [E-pagerank],
   [E-personalize]. `soul_find` boosts co-change neighbors and penalizes tests/docs/config
   [E-find]. Its inspected ranking tests check penalty classification, not top-k task success
   [E-ranking-tests]. Treat centrality as an optional explained secondary signal, never authority,
   confidence in a call edge, or permission to hide lower-ranked evidence.
4. **“Dependency” in this core is broader than import.** `buildEdges` merges import confidence 3,
   identifier inference confidence 1, and co-change confidence 2 (count ≥3), then propagates
   through barrels. `queryEdges` returns only path/weight, up to 30 rows [E-edges], [E-relations].
   `soul_impact` labels these rows as importing files and combines them into “affected files”
   [E-impact]. Pilot should not reproduce that conflation. The inspected core's call builder
   regex-matches imported/resolved names within function line ranges, rather than requiring
   an invocation AST node; tests intentionally allow unique-export reference linkage without
   an import [E-core-calls], [E-ref-tests]. That is not Pilot's exact callable witness contract.
5. **Budgeted rendering is a soft estimate.** Tokens are `ceil(text.length / 3.5)`. Render permits
   a 5% extra block, 10% directory reserve, initializes selection to one block, and adds headers
   outside block accounting [E-estimate], [E-render]. **Inference:** tiny budgets/large first blocks
   can exceed the request. Frozen bytes/TTL support stable prompt prefixes, not source freshness;
   tests assert idle expiry/hash behavior, not live-source identity [E-freeze], [E-freeze-tests].

## Concrete investigations: composition first

These are recipes, not executed investigations or new tool contracts. Examples require the relevant
tools to be available to the caller and a host-authorized source. Ordinary tool calls do not grant
access to another workspace or retained comparison.

### A. Known declaration: who directly calls it?

Use the existing tools. No pipeline, fuzzy ranker or index is justified for this question:

```js
const declarations = await tools.code_symbols({
  path: "packages/kernel/src", query: "scanSource", exact: true,
});
const matches = declarations.results.filter(h => h.path.endsWith("/exploration-scan.ts"));
if (matches.length !== 1) throw new Error("Select one exact declaration; inspect coverage/pages");
const hit = matches[0];
const callers = await tools.code_call_paths({
  path: "packages/kernel/src", direction: "callers", depth: 1,
  symbol: { path: hit.path, line: hit.span.start.line,
    column: hit.span.start.column, contentHash: hit.contentHash },
});
text({ discovery: { partial: declarations.partial, reasons: declarations.partialReasons,
  page: declarations.page }, callers });
```

The hash fences the selected file, not all intermediate source between calls. Query fingerprints
include query identity and cannot be compared across symbols/search/call-path operations as a common
revision. Relative ESM resolution does not substitute `.js` imports with `.ts` source; unresolved
edges are expected in this tree. Empty callers never proves no impact [P-calls], [P-freshness-tests].
At the reconciled source, use `code_impact` for multiple roots and a preceding graph receipt as
`expectedRevision` when applicable; that rescan fence still does not make live observations atomic.

### B. “Where is source traversal handled?” without an exact name

In one codemode call, batch independent `code_search({query:"SourceReader",path:"packages/kernel/src"})`
and `code_symbols({query:"source",path:"packages/kernel/src"})` with `Promise.allSettled`. Handle
rejections explicitly. Deduplicate returned file paths, retain both pages' partial/failure/nextCursor
metadata, narrow to a few files, then read only the required ranges. Local filtering only filters
the observed pages; it cannot establish “no other files.” A short known substring is already enough.
Try optional fuzzy discovery later for an abbreviation such as `srcRdr`; do not invent references
from similar names. Separate calls still rescan; batching saves model round trips, not shared AST work.

### C. “What else should I inspect before changing this module?”

Today, search import spellings with literal search/grep and inspect candidates manually, then use
exact callable queries where available. Say **candidate import text**, not resolved dependents:
aliases, re-exports, side-effect/type imports and dynamic loading complicate that answer.
A separately proposed import relation could include a file that imports a type but never calls a
function. A history query could identify a migration/documentation companion that imports nothing.
Neither belongs in a callable shortest-path witness. “Historically changed together” is a reason
to inspect, never an instruction to edit, nor proof the current change needs it.

### D. “Compare the submitted layer with its exact parent”

Do not join current dirty search results to an old graph. The host must select the retained **exact
base and head**, repository/store and workspace/owner identity. Build each side independently and
label missing/unsupported sides. No mutable `HEAD`, guessed parent, top-of-stack file, or current
workspace substitution for a missing retained blob. Existing host-pinned reads support a single
full commit; they do not constitute an agent-selectable retained comparison transport [P-reader].
Designing entity/edge comparison remains #32, not this study or a waiver of its prerequisites.

## Smallest next contracts, proposed only

**First step: no new API.** Evaluate the recipes above and bounded outline/read packing in codemode.
Keep omitted output explicit, preserve citations/hashes/coverage, and print only necessary context.
Prefer a tool change only when measured failure is missing capability or repeated scans, not because
five operations can be written as one DSL. Do not implement a second graph resolver alongside #21.

If discovery fixtures justify it, the smallest symbol extension is an opt-in
`code_symbols({query, match:"subsequence", ...existingArgs})`, mutually exclusive with `exact:true`.
Default behavior stays unchanged. Return `matchKind`, matched-name positions and deterministic
score/ties; retain source hash/span, coverage and cursor binding. Start with simple discovery ranking,
not PageRank, type resolution or typo correction claims. File-path fuzzy discovery is a separate
capability decision; existing `find` plus bounded local scoring may suffice without a new endpoint.

If file relations show unique value, evaluate one separately authorized read-only contract:

```ts
code_file_relations({
  path: "src/a.ts", relation: "imports" | "imported_by",
  within?: string, limit?: number, cursor?: string,
})
```

Here `path` selects a file and `within` bounds traversal inside **one host-selected source**.
Each edge must carry `kind:"file-import"`, source import span/hash, specifier, type/side-effect
classification where known, optional target path/hash, and resolution/provenance. Keep unresolved
specifiers visible and report scan-wide unknowns for reverse lookup. No callable target or invocation
is implied. Reuse accepted scanner/parser infrastructure, not the external engine; no config/code
execution or arbitrary alias/plugin resolution. Validate any needed parser expansion separately.

Historical `cochanged` is **deferred**, not another enum on this import API. A future distinct query
needs an exact history endpoint/range, repository identity, commit/file/pair limits, merge/rename/
bulk-commit policy, counted observations/denominator and exclusions. The public builder samples a
configured recent commit count, ignores too-small/large file sets, retains pairs seen ≥2 times and
skips rebuilding when HEAD matches and rows exist [E-history]. Counts are correlation, not causality,
current imports, or complete history. History access requires its own authorization, not merely source
read permission; unavailable Git/shallow history must be represented rather than silently empty.

An eventual on-demand context pack should initially be a projection of existing bounded results,
not a provider call or automatic repository injection. Start evaluation with 2,000 estimated tokens,
48 KiB total JSON and at most eight selected files per pack, not a whole-repository default.
Request estimated tokens **and** max bytes; return estimate method/version,
observed/returned/omitted counts, truncation and continuation.
Account for metadata/headers, stop before overflow, and keep the caller's original coverage even
when packing discards rows. Exact model-token guarantees require a qualified tokenizer; character
estimates must say “estimated.” No summary generation, memory write or telemetry is proposed.

### Constraints before any implementation

- **Authorization/revocation:** source selection stays host-owned. Recheck current project/member
  ownership and configured read policy on every native call, including nested calls and cached
  lookups. Never cache grants. Current coordinator tests permit an admitted finite read to drain
  after revocation but deny the next call [P-access], [P-revoke]. A future multi-stage server operation
  must define/recheck authorization before each new stage/read, with no post-revocation expansion;
  do not promise retroactive cancellation that current admission does not provide.
- **Identity and freshness:** identify canonical workspace/repository/store, host-selected commit
  or retained snapshot ID, engine/parser/exclusion version, scan scope and observed bytes/coverage.
  Content equality in two workspaces is not source identity. Scope changes, edits/additions/deletions,
  coverage changes and policy changes invalidate affected results/cursors. Pinned and live sources
  never share entries by path alone. The delivered opaque receipt avoids exposing private canonical
  paths in its IDs; older tools retain their pre-existing source fields [N-impact-doc].
  Current live scans are per-file windows, not atomic; cross-file edges may combine times. Hashes
  identify observed bytes, not current bytes. Even a shared scan or hash match is not a transaction
  or runtime proof [P-scan], [P-window-test].
- **Filesystem boundary:** preserve no-traversal, no-symlink/submodule, bounded regular-file reads,
  coordinator metadata/hardlink/configured-denial guards and inherited worker permissions. Current
  path preflight/final-open checks do **not** eliminate transient ancestor swaps [P-reader].
  Descriptor anchoring (#25) is separate; no index or pipeline may claim to repair that limitation.
- **Failure/coverage:** use explicit `unavailable`, `stale`, `unsupported`, `failed`, `partial` and
  observed-success states (or equivalent errors), not one empty list. A valid empty observation
  still names its bounded source/coverage and never asserts safety. Distinguish unsupported parser,
  unreadable file, excluded subtree, scan limit, unresolved edge and intentionally omitted response.
  Candidate indexes require verification; incomplete/saturated indexes must fall back within budget
  or return incomplete status. A fallback must preserve semantics, not become a broader grant.
- **Cancellation/join:** preserve signal propagation, cancellable queue, two workers/eight queued
  calls per kernel, 15-second worker deadline, 250ms parsing-cancel grace and awaited termination
  before releasing a slot [P-runner]. Composition must join child calls, including after stage failure;
  no detached readers/watchers or background reindex after cancellation. A future pipeline needs one
  aggregate operation deadline/work budget, not a fresh allowance per stage.
- **Resource budgets:** retain 10,000 visited entries, 32 MiB accepted bytes, 512 KiB/file, top-1,000
  hits; call graph 20,000 records/1,000 traversal edges; pages ≤50 results and 48 KiB JSON [P-scan],
  [P-calls], [P-page]. Impact additionally caps **examined** incoming edges at 1,000 [N-impact].
  These are not token or total-process RSS bounds. 128 MiB worker old-generation
  limit excludes other heaps/native allocations/preloads. Measure parent+worker CPU/RSS/loop gaps;
  bounded concurrency is not a fleet-wide memory guarantee. There is no hard process CPU/RSS cap in
  this API. For the proposed fixture comparison, use a five CPU-second aggregate ceiling and stop
  admission/cancel and join at a sampled 256 MiB RSS increase over the settled parent baseline;
  sampling is an evaluation stop rule, not an enforced peak-memory guarantee or production SLA.
  New aggregate composition/context budgets must not multiply these limits silently or truncate
  witnesses into apparently complete evidence.

## Index/cache tradeoff, not a prerequisite

Observed external incremental work: SQLite file/symbol/ref/trigram graph; scan gates by mtime+size;
edit notifications debounce reindex; dirty graph rebuilding can run asynchronously while render
continues [E-incremental], [E-refresh]. Queries skip some entries using a 1-second mtime tolerance
[E-symbol-query]. **Inference:** same-size/same-mtime replacement and interleaved rebuild/read are
freshness hazards unless stronger content/generation validation exists. This study does not establish
a consistent generation across those methods. Persistent state has schema, disk, shutdown and failed-
rebuild costs; low repeated-query latency alone would not establish total session savings.

Pilot deliberately starts a disposable worker per call; scanner/parser reuse within a call is already
present. Defer a persistent service/watchers until actual repeated-investigation cost justifies it.
The lower-risk experiment, after authorization, is bounded per-operation reuse or content-addressed
immutable parse artifacts. Keys need source identity, byte hash, engine/options and coverage policy;
authorization remains a fresh admission check. Global ranks/import graphs must invalidate when any
relevant node/edge or scan boundary changes, not only the selected file. Live caches must detect adds,
deletes and scope changes and validate bytes, not rely solely on mtimes. Compare uncached correctness
and total cold/warm/edit/idle costs before considering disk persistence, TTL or background indexing.

## Bounded fixtures and evaluation plan

Future evaluation uses independent offline Pilot fixtures, never external code execution or providers.
Retain existing source/call-path regressions [P-search-tests], [P-call-tests] and measure against current
codemode composition before approving API work:

| Fixture / bound | Required observation |
| --- | --- |
| 12-file hand-labeled TS/JS package, duplicate names, local shadows, unused/type/side-effect imports, callback and dynamic dispatch | Exact calls keep invocation witnesses; import edges and candidate text remain distinct; unknowns cannot become a safe/empty answer. |
| 40-file discovery set: abbreviations, casing, typo, two-word paths, equally named symbols, relevant tests/docs and a disconnected module | Compare exact/substring + find against optional fuzzy top-5/top-20 success, false candidates, deterministic ties and inspected bytes. Centrality must not suppress the only relevant low-degree file. No language rollout implied. |
| 600-file small-text set sharing common trigrams; short/non-ASCII patterns; unavailable/corrupt/saturated index, parse/read failures | Candidate retrieval must not lose verified literals; unavailable ≠ zero hits. This is a proposed independent regression, not an executed external bug reproduction. |
| Two byte-identical workspaces, dirty non-root edits, add/delete, same-size/same-mtime rewrite, mixed read windows; two retained commits with different bodies and a missing blob | Reject cross-source/stale cursors; preserve exact base/head and byte provenance, never substitute current live files. Retained comparison semantics stay with #32. |
| Current authorization revoked between stages, hostile path aliases, queued/running cancellation, failed sibling call | No new revoked reads; explicit finite-drain policy; all started operations joined and slots reusable. Do not claim transient-ancestor isolation. |
| Temporary 12-commit history with unrelated co-change pairs, bulk/merge commit, rename, shallow/unavailable history | Deterministic bounded counts with explicit policy/exclusions; no inferred import/call or automatic edit. Deferred history query only if separately authorized. |
| 1-byte/tiny/full context budgets, huge signature, Unicode, >50 hits, >1,000 hits, graph/file/byte limits | Total JSON bytes and estimated tokens include metadata; explicit omitted/truncated counts; inability to fit metadata is an error, not malformed success. |

For cost, use Pilot's existing offline 132-file benchmark shape and a bounded 1,000-file fixture below
the scan-byte cap. Compare (a) current sequential codemode, (b) independent batching with identical
queries/output projection, and (c) the now-landed shared multi-root work for the same roots, using
the delivered observations above as a starting point, not a substitute for new fixture results.
Distinguish model turns, worker starts, file reads/parses, useful witnesses, output bytes and
estimated tokens. Fewer model turns alone does not prove less CPU; comparing unlike outputs is invalid.
For any authorized cache prototype add cold/warm, non-root edit, failed rebuild and idle/close cases.

Alternate before/after order, record Node/platform/preload state, run at least five samples, and report
wall/process CPU, sampled parent+worker RSS/peak-sampling limits and parent-loop heartbeat gaps. Keep
the same scopes, coverage and failure cases. Existing documented synthetic timings are historical,
not rerun evidence; the delivered #21 observations above are also reported, not reproduced here
[P-bench], [N-cost].
Stop on resource/deadline breach, preserve substantive coverage, and investigate rather than relaxing
limits. An index should advance only with improved investigation success/cost **without** changed
answers, hidden stale/unknown data, idle work or unacceptable memory. No universal speedup threshold,
live responsiveness claim or cache requirement is established by this study.

### Verification for this document

Docs-only checks: pinned source paths/line ranges, referenced assertions and claim attribution;
local relative links and external commit permalinks; balanced Markdown fences/tables, trailing
whitespace and diff scope. Source/tests were read, not run. No external installation/execution,
production implementation, runtime attachment, UI, index/cache activation, provider/telemetry work,
review transport/gates or changes to #21. No execution/performance qualification is claimed.

## Pinned source references

`E-*` links target the inspected public core; `P-*` links target the original Pilot baseline;
`N-*` links target the reconciled delivered source. All stay pinned if main later advances.
Line ranges below are evidence locations, not claims that entire files were
audited for security or correctness.

[E-root]: https://github.com/proxysoul/Empryo/tree/c27dac116d2ee1637abfc6634bebf08b5c379454
[E-scope]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/README.md#L85-L93
[E-package]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/package.json#L1-L15
[E-license]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/LICENSE#L1-L55
[E-commercial]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/COMMERCIAL_LICENSE.md#L3-L27
[E-v3-license]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/EMPRYO_V3_LICENSE.md#L8-L106
[E-query]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/tools/soul-query.ts#L20-L245
[E-query-tests]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/tests/soul-query.test.ts#L14-L80
[E-trigram-query]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L5342-L5368
[E-trigram-write]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L5322-L5340
[E-trigrams]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/trigram.ts#L1-L24
[E-trigram-tests]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/tests/trigram.test.ts#L12-L102
[E-find]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/tools/soul-find.ts#L69-L184
[E-fuzzy]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/tools/soul-find.ts#L328-L446
[E-ranking-tests]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/tests/soul-find-ranking.test.ts#L4-L15
[E-pagerank]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L1934-L2054
[E-personalize]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L3411-L3457
[E-render]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L3087-L3409
[E-estimate]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map-utils.ts#L107-L109
[E-freeze]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/context/manager.ts#L1394-L1457
[E-freeze-tests]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/tests/soul-map-snapshot-stability.test.ts#L6-L40
[E-edges]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L1492-L1741
[E-relations]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L3867-L3915
[E-impact]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/tools/soul-impact.ts#L69-L170
[E-core-calls]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L2944-L3057
[E-ref-tests]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/tests/repo-map-refs.test.ts#L115-L181
[E-history]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L2184-L2274
[E-incremental]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L529-L679
[E-refresh]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L2870-L3087
[E-symbol-query]: https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/core/intelligence/repo-map.ts#L3563-L3602
[P-root]: https://github.com/babariviere/pilot/tree/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726
[P-tools]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/exploration-tools.ts#L8-L97
[P-compose]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/exploration.integration.test.ts#L27-L102
[P-calls]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/call-path-scan.ts#L11-L209
[P-rank]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/exploration-scan.ts#L265-L298
[P-page]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/exploration-page.ts#L4-L45
[P-scan]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/exploration-scan.ts#L16-L226
[P-reader]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/source-reader.ts#L19-L211
[P-access]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/coordinator-source-tools.ts#L47-L130
[P-revoke]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/coordinator-sources.integration.test.ts#L379-L405
[P-runner]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/exploration-runner.ts#L9-L129
[P-search-tests]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/exploration.test.ts#L59-L281
[P-call-tests]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/call-path.test.ts#L37-L417
[P-freshness-tests]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/call-path.test.ts#L193-L247
[P-window-test]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/packages/kernel/src/call-path.test.ts#L383-L403
[P-bench]: https://github.com/babariviere/pilot/blob/fa9662723f3aaf2d57aefabab4c5c7cdec6f8726/docs/code-exploration.md#L143-L171
[N-root]: https://github.com/babariviere/pilot/tree/6149d396c0211eb16541c425cea869df7c2192ff
[N-graph]: https://github.com/babariviere/pilot/blob/6149d396c0211eb16541c425cea869df7c2192ff/packages/kernel/src/call-graph.ts#L8-L206
[N-impact]: https://github.com/babariviere/pilot/blob/6149d396c0211eb16541c425cea869df7c2192ff/packages/kernel/src/impact-scan.ts#L17-L129
[N-contract]: https://github.com/babariviere/pilot/blob/6149d396c0211eb16541c425cea869df7c2192ff/packages/kernel/src/impact-contract.ts#L5-L43
[N-receipt-source]: https://github.com/babariviere/pilot/blob/6149d396c0211eb16541c425cea869df7c2192ff/packages/kernel/src/exploration-scan.ts#L48-L85
[N-receipt-final]: https://github.com/babariviere/pilot/blob/6149d396c0211eb16541c425cea869df7c2192ff/packages/kernel/src/exploration-scan.ts#L316-L324
[N-impact-doc]: https://github.com/babariviere/pilot/blob/6149d396c0211eb16541c425cea869df7c2192ff/docs/code-exploration.md#L98-L163
[N-paths]: https://github.com/babariviere/pilot/blob/6149d396c0211eb16541c425cea869df7c2192ff/packages/kernel/src/call-path-scan.ts#L10-L87
[N-tests]: https://github.com/babariviere/pilot/blob/6149d396c0211eb16541c425cea869df7c2192ff/packages/kernel/src/impact.test.ts#L40-L340
[N-cost]: https://github.com/babariviere/pilot/blob/6149d396c0211eb16541c425cea869df7c2192ff/docs/code-exploration.md#L249-L278
[N-benchmark]: https://github.com/babariviere/pilot/blob/6149d396c0211eb16541c425cea869df7c2192ff/packages/kernel/src/exploration.bench.ts#L14-L168
