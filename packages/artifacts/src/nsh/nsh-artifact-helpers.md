# NSH artifact helpers and examples

Status: trusted helper source, copyable examples and agent guidance. **Not a production artifact runtime or
viewer.** Even once the artifact tool can save `kind: "nsh"` source, previews stay unsupported (source text
only) until running captured code is separately qualified. Visuals and Mermaid stay the published diagram
path, and existing artifacts keep their readers and exact revisions.

## Files

`packages/kernel/skills/pilot-artifacts/nsh/` is a TSX-only NSH project:

- `kit/`: the trusted `pilot-artifact/ui` module. Layout is pure TypeScript (`flow.ts`, `sequence.ts`,
  `text.ts`, `check.ts`); views are `ui.tsx`, `charts.tsx` and `diagrams.tsx`. It imports only `nsh`,
  `nsh/base` and `pilot-day/ui`, and makes no host, storage, clipboard, file or network call. Its `Page`,
  `Section`, `Card`, `Choices` and `Stat` keep their props for saved artifacts and draw with Day's library.
- `examples/`: one complete artifact per common need (a Pilot-like page, summary/table, charts/timeline,
  interactive mockup, prototype with variants and situations, flow, sequence). Page, summary, mockup and prototype
  build with `pilot-day/ui`. Prototype chats start from `prototype.tsx`.
  [references/nsh.md](../../../kernel/skills/pilot-artifacts/references/nsh.md) is the
  agent guide; `SKILL.md` routes to it only when the tool accepts `kind: "nsh"`.
- `tests/`: layout checks. The examples run headless in `apps/day/native/tests/artifact_examples.rs`, through the
  runtime Day's preview uses: Day's library imports its fonts and icons, and NSH refuses to build an asset from
  outside the project's directory, so this project can typecheck the examples but not run them. For the same
  reason `App.tsx` is only the entry nsh needs for those checks, not a gallery.
- `nsh.json` and `tsconfig.json` map `pilot-day/ui` to `apps/day/ui/index.ts` and use `apps/day/theme.json`, for
  the checks only.

`ARTIFACT_NSH_FILES` in `packages/kernel/src/artifacts/artifact-skill.ts` lists the examples and helper sources, so
Ask can read them like the other bundled references. A kernel test keeps that list complete and checks the
import allowlist.

## Pilot's parts (`pilot-day/ui`)

Artifacts import Day's component library (`apps/day/ui`, guide `apps/day/ui/README.md`) from `pilot-day/ui`. The
artifact runtime embeds the same files as trusted chunks (`apps/day/native/src/artifacts/artifact_library.rs`); there are no
artifact-only copies. The names it exports are those of `ui/index.ts`, read from the embedded sources, without the
screen agent's registry functions (`snapshot`, `query`, `act` and the like): from `agent.ts` only `useAgent` and
`AgentScope`. Release builds give agents only `packages/`, so `references/nsh.md` carries a short table of the
parts and their key props.

## Contract proposed to the runtime

These are the helper side of the boundary. The production compiler, capture, isolation and viewer belong to
the runtime work and must qualify them; nothing here grants them.

- Two trusted specifiers, `pilot-day/ui` and `pilot-artifact/ui`. The production compiler supplies Pilot's own
  library and kit bytes as in-memory trusted chunks; it uses no filesystem resolver and never resolves from session
  scratch. The
  `resolve.alias` in this project's `nsh.json` serves only the local checks and the review gallery.
- The captured file has `export default` and no `mount` call. The trusted compiler generates the entry:
  `import A from "<captured>"; import { mountArtifact } from "pilot-artifact/ui"; mountArtifact(A);`.
- `mountArtifact` wraps the artifact in an `ErrorBoundary` that shows the thrown message, not a blank page.
- Upstream exports the kit and examples use: `nsh` (`View`, `Text`, `Scroll`, `Canvas`, `signal`, `computed`,
  `token`, `fontScale`, `reduceMotion`, `LayoutAnimation`, `ErrorBoundary`, `mount`) and `nsh/base` (`Button`).
  This is a request to the runtime, not a qualified allowlist: an export the runtime has not qualified stays
  unavailable, and the examples change to fit.

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
- `Choices` switches between options with Day's `Tabs` on a hairline; many options scroll sideways. A hand-made
  chip with both `hover:` and `selected:` lost its selected background under the pointer on macOS, which made
  the chosen variant look empty in the first planning prototype.

## Checks

From `packages/kernel/skills/pilot-artifacts/nsh`, with the installed NSH 0.6.1 CLI:

```sh
NSH_TSC=<workspace>/node_modules/.bin/tsgo nsh check
nsh test
```

`nsh test` runs the layout checks headless: it needs no Rust build, window or GPU. The kernel check is
`node --test packages/kernel/src/artifacts/artifact-skill.fast.test.ts`. The examples, the library embedding and the older kit names
run in `apps/day/native`: `../scripts/cargo test --locked --test artifact_examples --test artifact_library`.

## Not established here

- No captured-source compilation, separate-engine isolation, resource limits, cancellation or disposal of
  an artifact runtime. Those come from the runtime work and its qualification; see
  the feasibility probes.
- No native appearance check: headless tests prove structure and behavior, not drawing, fonts, focus,
  scrolling feel or IME. The width estimate is not platform text measurement.
- Only flowcharts and sequences have helpers. Gantt, class, state and entity diagrams do not.
- Mermaid and visual publication stay until the runtime, viewer and helpers are qualified together.
