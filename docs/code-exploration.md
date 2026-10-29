# First-party code exploration

Pilot registers `code_search`, `code_symbols` and `code_call_paths` as native Pi custom tools in Build and source Ask.
They are callable directly or through codemode, including the investigate/explorer read-only boundary.
Diagnostics does not gain arbitrary source access. Ordinary `read`, `grep`, `find` and `ls` stay available.

## API, version 1

```ts
code_search({query: string, path?: string, limit?: number, cursor?: string})
code_symbols({query?: string, path?: string, exact?: boolean, limit?: number, cursor?: string})
```

- `query`: case-sensitive single-line literal, at most 256 UTF-16 units. Search is not regex or
  natural-language semantic retrieval. Symbols use a name substring, or exact equality with `exact`.
  Omit the symbols query to list candidates.
- `path`: file/directory inside the host-selected source, defaults to root. Narrow it for large sources.
- `limit`: 1–50, default 25. Pages may contain fewer hits to stay under the 48 KiB JSON budget.
- `cursor`: returned `page.nextCursor`, valid only for the same query, canonical workspace/snapshot and
  observed source contents. Each page rescans. Invalid/stale cursors fail, never silently mix revisions.

Results contain source-relative `path`, `path:line:column` citation, source-byte SHA-256 `contentHash`,
matched identifier/literal `span`, clipped source `snippet` (with its own span/truncation flag), coverage
and deterministic integer ranking score. Offsets are zero-based UTF-16; lines/columns are one-based;
ends are exclusive. Original BOM, CRLF and Unicode offsets are preserved. Use `read` for more context.
Display names/containers are capped at 200 UTF-16 units, with explicit truncation flags.

Search returns the first literal match per line. Exact declaration-name hits rank above declaration-name
prefixes, enclosing-declaration matches and other text, with path/offset tie-breaks. Enclosing context is
a bounded syntax heuristic, not type information. Symbols rank exact names, prefixes, then substrings.

The pinned runtime dependency `@babel/parser` parses `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`
and `.cjs`. Named functions/classes, TypeScript interfaces/types/enums/namespaces, variable bindings
(including destructuring), and noncomputed methods/properties are candidates. Parameters, import aliases,
re-exports, computed names, anonymous definitions and semantic target resolution are not covered.
Project compiler/Babel configs, plugins, imports and source modules are never executed. Unsupported syntax
or parse failures return lexical search coverage; symbols omit those files with explicit partial status.

## Source call paths, version 1

```ts
code_call_paths({
  symbol: {path: string, line: number, column: number, contentHash?: string, frameId?: string},
  direction: "callers" | "callees",
  depth?: number, path?: string, limit?: number, cursor?: string
})
```

Select an exact callable declaration using `code_symbols` coordinates, or a returned frame's location.
Include `contentHash` to reject stale source navigation; include its `id` as `frameId` when coordinates
are ambiguous (for example, an anonymous function and module at the same position). Non-callable
symbol candidates, unsupported files, ambiguous coordinates and missing/out-of-scan frames fail rather
than guessing by name. A module frame is available at line 1, column 1. `path` bounds the **whole scan**,
not just the selected symbol: imports outside it remain unresolved. `depth` is 1–6, default 1.
`limit`/`cursor` use the same 1–50/48 KiB page contract as search. Page size is not traversal depth.

`mode: "source-inferred-not-runtime"` is always present. Each result is a directed source call edge:
`from`/optional `to` are navigable frames with stable content-qualified IDs, clipped names with
`nameTruncated`, and exact source locations/hashes/snippets. `site` identifies the callee expression.
`distance` is the shortest expansion distance from the root in the selected direction. Results are
breadth-first, ordered by callsite path/offset. They form a bounded graph, not an enumeration of all
possible paths or a runtime call stack. Shared/cyclic frames expand once. `cycle` marks edges in a
source strongly-connected component, including self-recursion; diamond convergence is not a cycle.

Resolution vocabulary:
- `resolved`: a unique same-file lexical binding directly names a function declaration, or a `const`
  initialized with an arrow/function expression. This resolves the **source binding**, not execution,
  temporal reachability, types, behavior or runtime mutations.
- `inferred`: a direct relative ESM import names an explicit local exported callable in a scanned file.
  Explicit supported extensions use that file; extensionless paths consider supported extension/index
  candidates and require a unique scanned candidate. This is not compiler/module-loader resolution.
  Even explicit cross-file imports are inferred because live files come from different read windows.
- `ambiguous`: duplicate lexical/export bindings or multiple scanned import-file candidates. No `to`
  edge is created or traversed. `provenance` explains the ambiguity without name-based guesses.
- `unresolved`: no supported binding/target, reassignment, dynamic dispatch or unsupported semantics.
  No `to` edge is created. Unknown calls appear in callee exploration; they cannot be attributed to a
  particular symbol during caller exploration. Scan-wide unknown/ambiguous counts remain visible.

Actual language coverage is `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs` with the existing Babel payload.
Lexical scopes include functions, blocks, parameters/destructuring, catch, loops, classes and `var`
hoisting. Mutable function-valued `let`/`var`, assignments to a binding, duplicate declarations,
`eval`/`with`, TypeScript namespaces and sloppy-script block functions are conservative unknowns.
Named/anonymous functions, arrow callbacks and methods have separate frames, but passing a callback is
not an invocation edge. Member/optional/constructor/tagged calls, aliases, interface dispatch, namespace
imports, re-exports, package/tsconfig aliases, CommonJS and TS-to-JS extension substitution are not
resolved. Class initializers/computed keys retain their enclosing lexical context, not an invented
constructor/runtime order. No new languages, typechecker or persistent graph service are included.

One query reuses the source scanner, AST parser and disposable worker once for all traversed frames.
It retains at most 20,000 graph records (scopes/bindings/frames/calls/exports/writes); a file exceeding the
budget is omitted as a whole and the scan stops with explicit partial status. At most 1,000 traversed
edges are retained. `page.matchesObserved` is the traversal prefix observed before stopping, not the
total graph size. `traversal.depthLimited`/`resultLimited` and `partialReasons` describe the truncation;
use a narrower scan/depth to continue. Normal scan/exclusion/read/worker bounds below also apply.
`coverage.parsed` counts syntax-parsed files, not necessarily graph-retained files at a graph limit.
An empty callers result is **never proof of no impact**, even without detected partial coverage.

## Source and trust

Shared Ask `SourceReader` supplies path/traversal/symlink checks and regular-file bounded reads. A source
is host-selected, never a tool argument. Workspace queries read current files, not HEAD; independent
workspaces do not share an index. Host-pinned Ask uses only its validated full commit and Git object
store. Pinned results cannot promise uncommitted edits and say so. No repository or cache files are written.
No network, model calls, per-project activation, grammar download or runtime install occurs.

Pi project trust still controls executable resource loading, not permission to read ordinary source.
Untrusted project configuration is inert data, never a parser plugin or alternate executable. These tools
do not widen Ask into arbitrary files, shell access or Build, and do not alter existing OS sandbox rules.

`freshness` gives the scan start/end and a query/coverage-content fingerprint, not a repository revision or
atomic tree snapshot. Each live file is stat-checked around its read; detected concurrent edits are reported
as failures. A file can change after it was scanned. Hashes/spans identify the bytes observed during that
window, not a guarantee they still exist at response time. Re-query after edits. A cursor revalidates the
observed query input; it is not a durable review snapshot or evidence of accepted work.

## Bounds and incomplete coverage

Each query uses a disposable worker, joined on success/failure/Stop. At most two run per kernel process,
with eight cancellable queued calls. Each worker has a 128 MiB V8 old-generation limit and a 15-second
deadline (not a total process RSS guarantee). Cancellation aborts source I/O, with termination after a
250ms grace for synchronous parsing. There are no idle index workers/watchers/caches.

Scans visit at most 10,000 entries, read at most 32 MiB of accepted file contents and allow files up to
512 KiB. They retain the best 1,000 hits; `matchesObserved`, `retained`, `partial` and `partialReasons`
distinguish a bounded observed set from exhaustive coverage. Deadline/resource exhaustion is an error,
not an empty successful result. Narrow the path/query to continue.

Explicit exclusions are `.git`, `.jj`, `node_modules`, `target`, `dist`, `.next`, `.cache`, symlinks,
submodules, binary/non-UTF8 files and oversized files. They apply even to explicit excluded paths.
These rules do **not** interpret `.gitignore`. `exclusions` counts skipped entries/files, not unknown
descendants. `coverage` counts parsed, lexical-only and unsupported symbol files. Parse/read failures
are counted, with up to eight bounded examples. Size/scan/result limits and unsupported symbol languages
set partial status. No matches in partial coverage must not be read as proof of absence.

## Verification and observations

`exploration.test.ts` exercises project-shaped TS/TSX packages, dirty changes, independent workspaces,
pinned snapshots, precise Unicode citations, pagination, parser/unsupported/read failures, bounds,
cancellation and path denials. `exploration.integration.test.ts` exercises real Pi/codemode registration,
Ask/investigate access, and a relocated parser/worker payload with no filesystem write permission.
Production runtime smoke checks also execute the shipped parser/worker, not only an import.

`call-path.test.ts` additionally covers directional/nested paths, lexical collisions and body/default
scopes, relative import ambiguity, callbacks/dynamic dispatch, recursive SCCs, unsupported languages,
dirty/pinned/independent sources, mixed read windows, stale navigation, read denials, queued/running
cancellation and bounded graph/pages. The SDK fixture calls `code_call_paths` through Ask/investigate
codemode and the relocated permission-limited worker; the explorer integration calls it without Build.

Run `node packages/kernel/src/exploration.bench.ts` for a temporary, offline 132-file multi-package fixture.
It reports five fresh-worker timings, process CPU, sampled RSS increase, parent-loop heartbeat gaps and
output sizes. Sampling can miss peaks and includes the surrounding process. This is not a token-savings,
GUI responsiveness, disk-cold performance or upstream comparative claim.

On 2026-10-29, macOS arm64/Node 24.21.0, the 407,424-byte fixture gave five no-preload fresh-worker
samples of 295–438ms wall (median 364ms), 444–493ms process CPU, 10.4–50.4 MiB sampled RSS increase
and 7.3–8.8ms maximum parent heartbeat gaps. Each returned 12 hits in 8,704 JSON bytes. With the host's
inherited credential SDK preload, a separate run observed 683–2,273ms wall, 998–1,578ms CPU,
14.1–118.1 MiB sampled RSS increase and 6.9–30.7ms heartbeat gaps. Other focused checks were running;
these are noisy local observations, not controlled comparisons. Preload startup and transient memory
are material costs. Workers are joined, but process RSS need not immediately return to baseline.

For call paths, `node packages/kernel/src/exploration.bench.ts --calls` uses the same 132-file layout
with 12 linked functions/file (122,064 scanned bytes). A 2026-10-29 no-preload macOS arm64/Node 24.21.0
run observed 139–157ms wall (median 142ms), 267–305ms CPU, 10.2–58.3 MiB sampled RSS increase and
6.3–6.7ms parent heartbeat gaps, returning six depth-bounded edges in 15,642 JSON bytes. A separate
five-sample search comparison against the pre-call-path source (`196a47ef`) on the original 407,424-byte
fixture observed baseline/current medians of 154/148ms wall, 287/250ms CPU, and maximum sampled RSS
increases of 50.5/56.5 MiB, with heartbeat gaps at most 6.8ms in both. Runs were sequential batches,
not randomized/cold measurements; small differences are not a speedup claim. Inherited credential
preload was absent, so the larger production-preload costs above still apply once per query, not once
per frame. These synthetic resource observations do not certify live-session/GUI responsiveness.
