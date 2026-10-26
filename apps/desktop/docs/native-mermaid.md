# Native Mermaid subset

Pilot Next renders a **bounded flowchart subset**, not the Mermaid language.
New artifact check/publication rejects malformed syntax as **Invalid Mermaid**
and unvalidated grammar as **Unsupported Mermaid**. Over-limit input is a
separate error. Stored unsupported/invalid revisions are not deleted: the reader
shows the explicit error and exact source for inspection/copy, not a successful
source fallback. Both validators consume the shared syntax admission corpus in
`packages/protocol/fixtures/mermaid/syntax.json`; no full Mermaid validity is
claimed for unsupported grammar.
`ui.mermaid(source)` keeps its existing API-1 schema. `Scene::parse` prepares a
native plan on the existing artifact reader thread. The view only paints paths,
native selectable labels and Kit controls. No Mermaid JavaScript, HTML, SVG
interpreter, WebView, network, filesystem, process, links or tool bridge exists
in this renderer. Existing isolated visual evaluation and its admission,
deadline, cleanup, state/version and exact-revision checks remain unchanged.

## Supported syntax

- Exact `flowchart` or `graph` header with `TD`, `TB`, `BT`, `LR` or `RL`.
- ASCII IDs: letter followed by letters, digits or underscore, at most64 bytes.
- Bare IDs, `A[rectangle]`, `B(rounded)` and `C{diamond}`.
- Plain Unicode labels, optionally double quoted. No HTML/entities, Markdown,
  escapes, controls, bidi overrides, nested delimiters or embedded newlines.
- Solid directed `-->` and undirected `---` edges, optional `|label|`, chains.
- Statements separated by newline or semicolon outside labels; blank lines and
  ordinary whole-line `%%` comments.
- An explicit declaration may name a previously bare node. Conflicting explicit
  declarations, self links, parallel edges and cycles are refused, not guessed.
- DAG layout, disconnected nodes, branch/merge and long links with reserved
  empty routing slots. Directions affect layout; arrows remain at their actual
  destination. The generated layout is not mermaid.js geometry.

Every non-comment statement must be consumed completely. Unknown/partial syntax,
styles, classes, subgraphs, directives, actions, other diagram types and graph
complexity beyond limits show the exact source with a local native-only reason.
They never render a deceptively incomplete diagram or disable sibling controls.
Markdown Mermaid fences are **not integrated in this slice**. The parser/plan and
native element are reusable for a later separately scoped fence hook.

## Limits and ownership

Before graph allocation:20KiB UTF-8 source,192 statements,64-byte IDs and512-byte
labels. Before adding graph entries:48 nodes,96 edges; labels48 graphemes
(16 in diamonds), edge labels24. Before layout expansion:24 ranks,128 total
real/dummy slots. Coordinates have an8192pt side/16,777,216pt² area bound.
Iterative longest-path ranking has no recursion, regex or crossing-search loop.
The already64Ki UTF-16 aggregate scene limit remains; at most8 diagrams are
prepared per scene. Excess diagrams retain source in the existing artifact
source view. No unbounded worker queue or global source/plan cache is added.

The diagram has a natural-size, bounded480pt scrolling viewport rather than
shrinking labels into illegibility. Expand changes the viewport to600pt; both
axes retain native scrolling. Source/Diagram and Copy source are local actions;
copy uses the exact Mermaid string, not artifact JavaScript or wrapped labels.
Native labels support selection. Controls stay mounted when content switches;
the tracked local root receives focus before source/expand changes. There is
no editable field or custom Escape/Enter interceptor to consume IME composition.
State is window-keyed by owner/path and **exact source**, retired on unmount.
No source mutation, model interaction or live action occurs.

## Audit, native references and design plan

The screen's job is to make one exact diagram readable immediately while keeping
its source and limitations inspectable. The existing artifact owner retains
revision/provenance and sandbox lifetime; the native diagram owns only local
Source/Expand and selection/scroll state. Subtract browser/fallback and permanent
diagnostics; retain exact copy, local errors and siblings; reveal source and a
larger viewport using native keyboard-reachable Kit actions. Existing app theme,
fonts and neutral surfaces supply light/dark presentation, not a second palette.

Audited Swift `VisualMermaidView.swift`, `InlineDiagramView.swift`,
`NativeMermaid.swift`, `PilotCore/MermaidSource.swift` and MermaidKit2.4.0
(2389-research/MermaidKit, tag commit4ed6f8a7ede26301faacfe4313896e223040e3e9),
`MermaidParser.swift` and `DiagramLayoutFlowchart.swift`. Swift uses native
MermaidKit plus WebKit fallback. Its permissive parser skips statements (the
existing75-real-diagram audit in `docs/native-mermaid-evaluation.md` found silent
loss). That fallback/admission model cannot be reused here. Retain the useful
source-scan/typed-plan/presentation split; use a closed scanner and bounded
iterative ranks instead of importing the broad parser or claiming all its
diagram types. No Swift renderer, parser or layout implementation is copied.

Native UX inspiration: hardbeat920/monocode, **MIT**, pinned
`ea6c8219bae954a3d8a9e8c536242b9531a683f7` on
`mc/migrate-monocode-to-gpui`, not the old React main:

| Sources | Retain/adapt/avoid |
| --- | --- |
| `docs/native/visuals.md`, `crates/monocode-gpui/src/visuals.rs` | Retain immediately useful native content, concise contextual source/copy controls, host fonts/theme and local error isolation. Adapt using our existing Kit actions and reader-owned plans, not custom clickable div controls or in-UI interpreter initialization. |
| `visuals/source.rs` | Retain immutable exact source and bounded source viewport. Adapt to the existing native SelectableText, not a new source editor/highlighter. |
| `transcript/visuals.rs` | Retain lazy view lifetime and source-identity invalidation. Our artifact/revision owner remains authoritative; transcript integration belongs to the separate inline-artifact slice. |
| `visuals/scene.rs` | Retain bounded geometry and host paint separation as a pattern. Its scene projection is **not** Mermaid parsing/layout and supplies no Mermaid grammar. No3D/orbit/shaders are imported. |
| `crates/monocode-core/src/visual/{model.rs,sdk.js}` | Retain fail-closed schema/budgets/local-only interaction principles. Avoid its runtime/API/state semantics where they conflict with our offUI sandbox and exact-revision/version fences. |

These are source-backed design inspirations, not a port or copied source. No
MonoCode or MermaidKit runtime/dependency is introduced. Existing upstream MIT
notices are unchanged. Source delivery is not OS IME, performance, Linux or user
acceptance; scoped native evidence and remaining limits are recorded separately.

## Verification rationale

The focused `native_mermaid` library filter covers closed grammar, malformed and
unsupported constructs, cycles, deep/dense/48-node inputs, Unicode/grapheme and
label limits, all directions, arrowheads, reserved long-link slots, label bounds
and sibling/schema preservation. The matching `native_mermaid` native target
mounts the production artifact arm at680/1100 in both themes, exercises native
label selection, exact copy, Source/Diagram, keyboard expansion, scrolling,
replacement/revision and late-old-snapshot rejection, long Unicode labels and
honest unsupported source. A real workbench fixture verifies late/replaced plans
do not take composer focus, change drafts or clear marked text. Matching strict
Clippy compiles the selected production/native targets; compilation is included
in this scoped check, not a separate broad app/test sweep.

Actual offscreen PNGs compare the same synthetic pane/fixture with its original
placeholder arm against the native arm. They are GPUI captures, not SwiftUI mock
views, browser screenshots or proof of real OS input/performance acceptance.
The view adds no animation or timer; this does not establish visible smoothness,
GPU throughput, live streaming responsiveness or production resource usage.
The exact landed checks, counts and source receipt belong to the task evidence.
