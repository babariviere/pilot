# First-party code exploration

Pilot registers `code_search` and `code_symbols` as native Pi custom tools in Build and source Ask.
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
