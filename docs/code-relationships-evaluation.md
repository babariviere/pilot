# Code relationships and retained comparison evaluation

## Recommendation and evidence boundary

**Next, qualify exact retained input, then a bounded TS/JS body/static-edge comparison using the
existing graph. Defer general references, type resolution, new languages and persistent indexing.**
These are separately scoped proposals for coordinator validation, not approved APIs or implementation.
Review navigation is not runtime tracing, complete impact, behavioral equivalence or acceptance evidence.

Source inspected on 2026-10-30 at Pilot `7222fe3e398855b34a43f17837d4c6d94a12009e` (all
source references below). This includes caller-impact delivery `3540a30473b08fa0b2327992c4114711f1a7ef09`
and the Empryo study `f17eea3d8fb5e5250b49a99af793d38abcf0b7a2`. “Delivered” means repository
code, not qualification of the running app. Source/assertions were read; no engine, external code,
provider or benchmark was executed for this evaluation. Cost numbers are explicitly attributed below.

The [Empryo study](empryo-code-exploration-evaluation.md) keeps its original Pilot
`fa9662723f3aaf2d57aefabab4c5c7cdec6f8726` and public-core
`c27dac116d2ee1637abfc6634bebf08b5c379454` pins distinct from its refreshed Pilot
`6149d396c0211eb16541c425cea869df7c2192ff` comparison. Its historical single-root gap is not
current. Its public SoulForge v2 findings do not evaluate private Empryo v3 or license code reuse.
[diffmap](https://github.com/tanishqkancharla/diffmap) is a user-supplied inspiration for authored,
source-linked navigation, **not verified call-graph evidence here**. Placement remains separate work.

## Capability / gap matrix

| Question | Delivered evidence | Remaining gap / smallest justified direction |
| --- | --- | --- |
| Who may call several exact functions? | `code_impact`: 1–8 roots, one shared `scanCallGraph`, lexical direct calls and relative ESM [G], [I]. | One shortest witness per non-root caller to a nearest root, not all roots/paths. Canonical root/callsite ties; roots excluded from counts. `assignedWitnesses` counts chosen witnesses; `exhaustive:false`. Keep this contract, not a second resolver. |
| What is unknown? | Unknown/ambiguous calls have source sites but no target. Callee exploration exposes them; impact reports scan-wide unassigned totals [G], [I]. | They cannot be attributed to roots or reverse-traversed. An empty result, full parser coverage or `partial:false` never proves no impact. Keep missing/unsupported capabilities explicit. |
| Compare exact retained before/after calls? | Retained store has immutable pair, complete/partial inventories, raw patch and exact side/path/SHA-256 reads [R]. | Exploration workers accept filesystem/Git `AskContext`, construct `SourceReader` and realpath its root [S], [W]. No retained analysis provider or comparison operation exists. Native retained reads are not that integration [N]. Qualify input first. |
| Which function body or relationship changed? | Babel nodes have extents; declaration extractor keeps `extentStart/End`. Graph frames keep navigable declaration-name locations and file-content-qualified IDs [P], [F]. | No entity correspondence, body digest or edge-delta API. File hashes/frame IDs change for unrelated edits and cannot join sides. Start with unique same-path top-level named callables; distinguish own bytes from outgoing relations. |
| General value references? | Literal search finds text; symbols identify declarations; graph records invocation sites/bindings [P], [F]. | Neither is find-references. Reads, writes, aliases, imports, shadowing and non-reference property keys need distinct records. Later candidate: source-backed same-file lexical value uses via the shared scope machinery, not name matching or inferred calls. Not in the next slice. |
| Types / type relationships? | TS interfaces, aliases and other declarations are symbol candidates [P]. Type-only imports deliberately do not become callable bindings [F]. | No type-use, extends/implements, assignability, generic substitution or virtual dispatch resolution. A later AST-only `declared-extends/implements/type-use` relation must say syntactic, retain operand spans and keep unresolved targets; semantic typing needs separate evaluation. |
| Rust / additional languages? | Parser gate supports only `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs` [P]. Other text can be searched lexically; symbol/graph scans report unsupported [S]. | Rust, Go, Swift, Python and others have no parsed symbols/call graph here. No lexical `fn`, `impl` or identifier match may be sold as resolved Rust relationships. Rust macros, cfg, modules/use, traits and dispatch require separately scoped parser/resolver qualification. No parser install, rust-analyzer or broad rollout proposed. |
| General structural named-entity diffs? | TS/JS declaration candidates include classes, members, types, enums and bindings [P]. | Names/containers are navigation hints, not stable identities. Overloads, nested/anonymous/computed entities, moves/renames and split/merge matching stay ambiguous or unsupported. Exact source changes do not establish semantic equivalence. Expand only after callable comparison fixtures justify it. |

The planned Changed paths section in [native Review](mission-native-review.md#changed-call-paths-d29)
is direction, not evidence that its historically referenced snapshot analysis shipped with caller impact.

## Two small contracts, in dependency order (proposed only)

### A. Retained graph input qualification, no new resolver or Review transport

An internal host-admitted operation selects **one existing snapshot**, never a caller-supplied host
path/commit or live workspace. Its input envelope must bind retained store/repository identity,
`snapshotId`, exact request operation/change and full base/head change+commit IDs, `scope:layer|stack`,
and a deterministic scan-path scope. Layer means the retained direct parent; stack means that exact
retained ancestor pair, not a guessed parent, merge base or current stack tip [R].

- Enumerate only each side's manifest inventory; fetch text using
  `{snapshotId, side:"before"|"after", path, sha256}`. Verify manifest/byte hashes. Before imports
  resolve only against the before inventory, after imports only against after. Keep rename paths
  and modes from the manifest; rename detection is heuristic, not entity identity.
- Missing provider/binding, unretained bytes, binary, symlink/submodule, corruption, unsupported
  syntax and budget omissions stay unavailable/unsupported/failed/partial as appropriate. Absence
  can be established only by a complete relevant inventory, not a failed read. Never fetch, capture,
  initialize enrollment, use live files/HEAD, or substitute a newer saved comparison on failure.
- Reuse `scanCallGraph`, parser, lexical binding rules and SCC logic. A top-level `read` override is
  insufficient: scanner construction and worker serialization currently hardwire `AskContext` [S], [W].
  Qualify a narrow host-owned inventory/byte-reader boundary in a separate code slice before B;
  do not extract a parallel engine or pretend the boundary is already injectable. Native `source()`
  returns decoded text with default BOM handling [N], not a byte-preserving analysis input; use the
  retained byte-read boundary, not a re-encoded display string, for hashes and offsets.
- Admission must revalidate current project/mission/member custody and read permission, not just
  frozen creator provenance. Native reads already recheck scope/ownership around byte reads [N].
  Recheck before each new stage/read and before returning derived results; revoke further reads
  and reject publication on changed custody. Do not cache grants or promise retroactive cancellation
  of an already admitted finite read. Worker ownership does not prove original task attribution;
  retain Unknown, enrollment-only task IDs and D31's separate later allocation semantics.
- Analysis identity binds the full pair, side, store, scan scope, parser/resolver/exclusion versions
  and observed coverage. Existing opaque live receipts bind per-file observations, not atomic trees,
  retained bytes, freshness leases or permission [S], [T]. Retained pair identity is additional, not
  an upgrade of a live receipt. Identical bytes in another store/pair are not interchangeable grants.

Acceptance: both sides traverse the existing resolver using only retained bytes, after source
rewrite/removal and store reopen, or fail explicitly. No endpoints, agent exposure, capture writes,
UI integration or production adoption is implied by this prerequisite.

### B. Pure retained callable/body/edge delta projection

Only after A passes, evaluate a bounded internal projection of that exact pair. No proposed public
tool name or wire schema is adopted here. Keep side graph identities, coverage and failures separate;
do not compare two nearest-root impact pages as if they were whole graphs.

1. **Entity correspondence:** initially only same-path, unique top-level function declarations and
   `const` arrow/function bindings, paired by exact full name and declaration kind. This is syntactic
   correspondence within a pair, not persistent entity identity. No clipped display-name keys,
   file hash/frame-ID equality, offset equality, fuzzy matching or cross-file rename inference.
   Duplicates/overloads and unsupported entities stay unpaired with reasons. Add/remove labels need
   complete relevant inventory and successful supported parsing on the opposite side; otherwise Unknown.
2. **Own source changes:** return exact declaration/header/body extents and hashes of their raw
   bytes. `bodyChanged`, `headerChanged` and `outgoingRelationshipChanged` are independent facts;
   unavailable body means Unknown, not false. Hash block/expression bodies without whitespace/comment
   normalization. Header includes parameters/defaults and type annotations; no body for declarations
   without implementations. Nested edits alter the enclosing raw body, but callers are never marked
   modified merely because their callee changed. Unchanged caller context stays unchanged.
3. **Relationships:** compare bounded outgoing edge multisets for matched callers and matched
   targets, using the shared resolver's existing `resolved`/`inferred` vocabulary/provenance. Match
   endpoint correspondences and count repeated sites; include all retained before/after site refs.
   Moving a site without changing endpoints/count is not an added/removed relationship. Do not invent
   one-to-one site matches across edits. A changed target or multiplicity is a source relationship
   delta only where both relevant resolutions/coverage permit it. Reassigned imports can change a
   relationship with identical caller body bytes. A missing/unresolved target is **lost resolution**,
   not proof a call was removed. Unmatched target identity is Unknown, not an inferred retarget.
4. **Navigation provenance:** every entity/site carries snapshot, side, exact logical path and full
   blob SHA-256 plus source spans. Existing offsets are zero-based UTF-16, one-based line/column,
   exclusive end [S]; they are not byte offsets. Add explicitly labeled UTF-8 byte ranges derived
   from the validated original text when hashing spans. Preserve BOM/CRLF/non-BMP characters and
   full original bytes. Never use clipped snippets as body evidence or interpolate absent spans.
5. **Honest output:** label source-inferred-not-runtime. Unresolved/ambiguous sites and their
   unassigned totals remain visible; partial comparison cannot imply unchanged/safe/complete impact.
   Existing optional caller context may use at most eight exact roots and the existing nearest-root,
   depth/tie/count semantics [I], independently per side. It cannot enumerate all relationships.
   Module/anonymous context stays context, not a falsely named modified function. Missing analysis
   must not block the independently available raw retained diff. No acceptance/review authority follows.

## Required fixtures and budgets before approving code

Existing assertions are evidence for the baseline, not tests of these proposals: connected witnesses,
one read/file, nearest-root ties, unknowns, receipts and mixed live windows [T]; retained lower layers,
source removal/reopen, rename/binary/partial and no-live-fallback [U]; current custody/revocation [V].

| Bounded offline fixture | Required comparison outcome |
| --- | --- |
| Hand-labeled 12-file TS/JS pair: body-only, import-target-only, header-only, site move, repeated call count, added/deleted callable | Independent byte/header/edge facts; unchanged callers unchanged; exact side hashes/spans. Same target multiplicity survives site movement. |
| Duplicate names/overloads, same spelling in different containers, nested callbacks, anonymous/computed method, rename/move, delete+re-add | Unsupported/ambiguous correspondence explicit; no global name/offset join, rename identity or persistent identity claim. |
| Shadowing, reassignment, dynamic/optional/member calls, ambiguous extension import, type-only import, diamond/cycle | No guessed target; lost resolution distinct from removal; inherited SCC and nearest-root semantics unchanged. Type/value uses never become invocation edges. |
| Lower layer versus dirty tip; missing before blob/provider, failed parse, partial inventory, oversized file, pair/store substitution, revoked membership | Exact retained pair only; absent capability stays unavailable. No synthetic empty success, cross-pair data or task-attribution backfill. |
| BOM/CRLF/Unicode, unrelated edit shifting offsets; 132/396-file pair; queue/run cancellation and failure on second side | Raw body bytes and UTF-16/UTF-8 spans agree; no hash/offset identity join. Bounded work, explicit omissions and all started readers/workers joined. |

Proposed aggregate comparison ceilings, **not implemented limits or performance promises**: 15 seconds
including both sides and reads; 10,000 visited entries, 32 MiB bytes read total, 512 KiB/file,
20,000 graph records total and 1,000 examined comparison/context edges total across sides. Retain
at most 1,000 delta records; pages at most 50 rows and 48 KiB JSON including metadata. Stop with
explicit partial coverage where useful results fit; deadline/OOM/cancellation is an error, never an
empty success. A missing retained side remains unavailable. Do not multiply current limits per side,
page or context root. A retained text blob may be valid up to 2 MiB yet exceed the 512 KiB graph cap [R].

Keep work off daemon/UI threads, no retained idle worker. Preserve inherited permission flags,
cancellable admission (two workers/eight queued per kernel), 128 MiB worker old-generation limit,
250 ms synchronous-parser cancellation grace and join-before-slot-release [W]. These are not process
RSS/CPU caps. Pair evaluation should serialize sides and release ASTs rather than retain two full
graphs without measurement. For fixture qualification, stop/cancel/join above five aggregate CPU
seconds or sampled 256 MiB RSS increase; sampling is only an evaluation stop rule, not a peak guarantee.
Measure parent+worker wall/CPU/RSS, reads/parses, output bytes and parent-loop gaps over five alternating
samples; preserve answers/unknowns and report misses. No live/GUI responsiveness qualification implied.

## Cache/index decision: decline for this next slice

The existing harness repeats warm-filesystem investigations with fresh workers, not cached queries [B].
Delivered results at the inspected pin [C], also attributed in the Empryo study:

| Files / scanned bytes per scan | Three caller scans: median wall / CPU | One impact scan: median wall / CPU | Maximum sampled RSS increase, three / one |
| --- | --- | --- | --- |
| 132 / 41,620 | 428 / 647 ms | 152 / 222 ms | 18.8 / 41.8 MiB |
| 396 / 123,508 | 725 / 1,155 ms | 231 / 372 ms | 19.6 / 53.2 MiB |

Reported macOS arm64/Node 24.21.0, five samples/variant, alternating pair order, clean preload
environment. Same four hand-labeled non-root callers; nine baseline edge rows versus four impact
caller records, with explicit depth limits. Output 28,744/24,319 bytes (132), 28,747/24,320 (396).
**Batching reduced repeated scans; sampled RSS increased.** Process-wide sampling/GC carry-over can
miss peaks; these are synthetic observations, not cache speedups or production-preload measurements.

Evidence justifies shared per-investigation parsing, already delivered. It does not establish
retained-pair query frequency, cross-query reuse, cache hit rate or cold/warm/edit/idle total cost.
Therefore no persistent service, watcher, index or cache prototype is justified here. Before/after
comparison still requires two distinct source graphs; multiplying the above medians is not a measured
pair latency. Later, only if repeated **identical retained-pair** work is material, evaluate bounded
content-addressed parse/result reuse against uncached answers, counting lookup/hash/serialization,
RSS, eviction and cancellation costs. Key by store/pair/side/scope, exact bytes, engine/policy and
coverage; reauthorize every lookup. Live incremental indexing additionally needs add/delete and
same-size/same-mtime invalidation, not a timestamp-only shortcut. No speedup is asserted or required.

## Verification and non-adoption

Docs-only verification: pinned source ranges and local links, numeric attribution, matrix/fixture
coverage, Markdown structure/whitespace and one-file diff scope. No production code, new engine,
parser rollout/install, external execution/copying, cache prototype, UI, Review transport, telemetry,
provider, runtime attachment, gate activation, migration, cleanup or release/restart. Further code
slices require coordinator validation. Preparation does not authorize publication or API adoption.

## Pinned evidence

All implementation/assertion/cost links below target the inspected Pilot pin, not moving main.

[G]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/packages/kernel/src/call-graph.ts#L8-L206
[I]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/packages/kernel/src/impact-scan.ts#L17-L129
[P]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/packages/kernel/src/exploration-parser.ts#L5-L117
[F]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/packages/kernel/src/call-path-syntax.ts#L62-L262
[S]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/packages/kernel/src/exploration-scan.ts#L16-L324
[W]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/packages/kernel/src/exploration-runner.ts#L9-L139
[R]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/docs/review-snapshots.md#L64-L153
[N]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/packages/daemon/src/native-review.ts#L26-L123
[T]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/packages/kernel/src/impact.test.ts#L68-L340
[U]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/packages/daemon/src/review-snapshots.integration.test.ts#L91-L422
[V]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/packages/daemon/src/native-review.test.ts#L77-L222
[B]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/packages/kernel/src/exploration.bench.ts#L14-L168
[C]: https://github.com/babariviere/pilot/blob/7222fe3e398855b34a43f17837d4c6d94a12009e/docs/code-exploration.md#L249-L278
