# Native Mermaid renderer evaluation

Inline Mermaid diagrams currently render with mermaid.js in one WebKit process per diagram. This note
compares two native candidates and records the choice for replacing that renderer. The full side-by-side
renders were reviewed as images; the numbers below are what matter for implementation.

## Corpus and method

- 75 unique Mermaid diagrams found in real Pilot chats and artifacts (67 flowchart, 2 graph, 4 sequence,
  plus 2 from chat messages), and 13 common or edge-case sources: flowchart shapes and subgraphs,
  sequence, class, state, ER, gantt, pie, mindmap, markdown string labels, init directives and click,
  an unknown diagram type and an invalid source.
- Reference: mermaid.js 12.2, the library the WebView renderer bundles.
- Apple silicon, release builds. Each diagram is parsed, laid out and rasterized at 2× in-process;
  warm numbers are the median of five uncached passes.
- Correctness: word-level recall of each candidate's SVG label text against mermaid.js's SVG, plus
  visual review of the renders.

## Results

| | MermaidKit 2.4.0 | merman 0.9.0 |
| --- | --- | --- |
| Language, licence | Pure Swift, MIT | Rust with a UniFFI Swift binding, MIT or Apache-2.0 (default Apple artifact includes EPL-2.0 ELK code) |
| Accepted sources | 87 of 88 | 86 of 88 (rejects one real `graph` that mermaid.js accepts) |
| Label recall vs mermaid.js | 0.956 mean; 6 of 75 real diagrams lose content silently; 26 of 75 show literal quotes on quoted edge labels | 0.986 mean; no real diagram loses content |
| Invalid or unknown input | `MermaidParser.parse` returns nil; unparsed lines inside a known type are dropped | Typed errors with source spans |
| Warm render, p50 / p90 / max | 10.6 / 20.5 / 45 ms (layout ≈1 ms, rest is the 2× raster) | SVG 2.1 / 3.3 / 4.3 ms, but drawing it with `NSImage` takes 198 / 523 / 1286 ms and loses text and edge styling |
| Cold first render | ≈17 ms | 7 ms SVG + 266 ms `NSImage` |
| Binary size (arm64, stripped) | +2.3 MB | +20.7 MB without a raster backend |
| Build impact | SwiftPM source package (tools 6.2, macOS 14), no default dependencies | Local binary XCFramework (297 MB zip); PNG output needs a custom Rust 1.95 build with resvg |
| Theming | `DiagramTheme` takes ink, secondary and tertiary text, canvas, accent, hairline and palette, resolved per appearance | Presentation roles in options JSON; deterministic text metrics unless the host measures text |
| Output | Vector `NSImage` (size known before drawing), PNG, PDF, SVG, alt text | SVG, ASCII, JSON; raster only in custom builds |

For comparison, mermaid.js takes 26 / 37 / 58 ms per diagram inside an already running page, before
the WebKit process launch and the 3 MB library load each inline diagram pays today.

## Decision

Use MermaidKit, pinned to an exact version, and keep the WebView renderer as the fallback:

- Fall back when `MermaidParser.parse` returns nil.
- Fall back when a flowchart's parsed edges are fewer than the links in its source, so a parser gap
  never drops content silently.
- Fix quoted edge labels (`-- "x" -->`, `|"x"|`) before shipping, upstream or in a pinned fork,
  and keep the real-diagram corpus as regression fixtures.

merman is the more faithful parser and worth revisiting if its Apple package gains a raster backend
with native text measurement.
