# NSH artifact helpers and examples

Status: trusted helper source, copyable examples and agent guidance. **Not a production artifact runtime or
viewer.** The artifact tool does not accept NSH TSX yet. Visuals and Mermaid stay the published diagram
path, and existing artifacts keep their readers and exact revisions.

## Files

`packages/kernel/skills/pilot-artifacts/nsh/› is a TSX-only NSH project:

- `kit/›: the trusted `pilot-artifact/ui› module. Layout is pure TypeScript (`flow.ts›, `sequence.ts›,
  `text.ts›, `check.ts›); views are `ui.tsx›, `charts.tsx› and `diagrams.tsx›. It imports only `nsh› and
  `nsh/base›, and makes no host, storage, clipboard, file or network call.
- `examples/›: one complete artifact per common need (summary/table, charts/timeline, interactive mockup,
  flow, sequence). [references/nsh.md](../../packages/kernel/skills/pilot-artifacts/references/nsh.md) is the
  agent guide; `SKILL.md› routes to it only when the tool accepts `kind: "nsh"›.
- `tests/›: layout checks and headless example checks. `tests/entries/› hold the entry shape below.
- `App.tsx›: a gallery for people reviewing the helpers with `nsh run›. Pilot never loads it.

`ARTIFACT_NSH_FILES› in `packages/kernel/src/artifact-skill.ts› lists the examples and helper sources, so
Ask can read them like the other bundled references. A kernel test keeps that list complete and checks the
import allowlist.

## Contract proposed to the runtime

These are the helper side of the boundary. The production compiler, capture, isolation and viewer belong to
the runtime work and must qualify them; nothing here grants them.

- One trusted specifier, `pilot-artifact/ui›, resolved to Pilot's own kit bytes at compile time (the
  project's `nsh.json› uses NSH 0.5.0 `resolve.alias›). It is never resolved from session scratch.
- The captured file has `export default› and no `mount› call. The trusted compiler generates the entry:
  `import A from "<captured>"; import { mountArtifact } from "pilot-artifact/ui"; mountArtifact(A);›.
- `mountArtifact› wraps the artifact in an `ErrorBoundary› that shows the thrown message, not a blank page.
- Imports the examples need: `nsh› (`View›, `Text›, `Scroll›, `Canvas›, `signal›, `computed›, `token›,
  `fontScale›, `reduceMotion›, `LayoutAnimation›, `ErrorBoundary›, `mount›) and `nsh/base› (`Button›).

## Helper behavior

- Each helper validates its declarative data and limits (for example 40 steps and 80 links per flow,
  10 participants and 80 steps per sequence). Malformed or oversized data shows the reason in place of the
  drawing; it never draws part of it.
- Layout is a pure function of data and text scale, so the same data gives the same geometry. Steps rank
  along the flow; loops route below the steps; a link that skips ranks past steps in its way routes above.
- Box sizes come from a text width estimate that leans wide. Native text draws the label; text beyond the
  box's lines ends with an ellipsis. Boxes grow with the reader's text size up to 1.6×.
- Boxes, labels and notes are native text views; lines and arrows are drawn on a canvas beneath. Diagrams
  carry a spoken summary, and charts write every value as text.
- Wide diagrams scroll sideways. Colors come from semantic theme tokens, so light and dark both follow
  the host theme. The mockup example skips its layout animation with reduced motion.

## Checks

From `packages/kernel/skills/pilot-artifacts/nsh›, with the installed NSH 0.5.0 CLI:

```sh
NSH_TSC=<workspace>/node_modules/.bin/tsgo nsh check
nsh test
```

`nsh test› runs headless: it needs no Rust build, window or GPU. The kernel check is
`node --test packages/kernel/src/artifact-skill.test.ts›.

## Not established here

- No captured-source compilation, separate-engine isolation, resource limits, cancellation or disposal of
  an artifact runtime. Those come from the runtime work and its qualification; see
  [the feasibility probes](nsh-artifact-feasibility.md).
- No native appearance check: headless tests prove structure and behavior, not drawing, fonts, focus,
  scrolling feel or IME. The width estimate is not platform text measurement.
- Only flowcharts and sequences have helpers. Gantt, class, state and entity diagrams do not.
- Mermaid and visual publication stay until the runtime, viewer and helpers are qualified together.
