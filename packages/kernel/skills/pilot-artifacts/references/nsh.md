# NSH TSX artifacts

Use this page when the artifact tool accepts `kind: "nsh"`.

The native Day app can open a saved NSH revision with Preview. Other clients may show source only; say so when the
user's client cannot preview NSH. Preview interactions change only local state, which resets when closed; opening a
preview does not accept the agent's work.

An NSH artifact is one TSX file that Pilot draws with native views, in its own sandbox. It gets local state
(signals, presses, text input) and nothing else: no files, network, storage, clipboard, processes, credentials
or Pilot actions. Calls that need them fail. Pressing things in an artifact changes only the artifact.

## Write, publish, clean up

1. Write the file in the session's `scratch/artifacts/` folder, for example `scratch/artifacts/release-plan.tsx`.
   It is session scratch, not repository source. In Ask, which has no write tool, pass the file's text as `source`
   with `sourcePath: "release-plan.tsx"` on every create and update; the artifact tool writes the file, then
   publishes it.
2. Publish it with the artifact tool. The tool compiles the captured bytes first. Fix reported compile errors
   and retry; failed compilation saves nothing. Success saves those exact bytes as a new revision. Every reader,
   and any later preview, uses that saved revision, never the file. Editing the file changes nothing until you
   publish an update. Compilation does not run the preview or fully typecheck TypeScript.
3. Workspace cleanup deletes the scratch folder, unpublished files included. Published revisions stay.

## The file

```tsx
import { View } from "nsh";
import { Page, Stat } from "pilot-artifact/ui";

export default function Artifact() {
	return (
		<Page title="Release plan">
			<View class="flex-row flex-wrap gap-3">
				<Stat label="Open issues" value="12" />
				<Stat label="Ready to ship" value="3" note="Checked on 12 November" />
			</View>
		</Page>
	);
}
```

- Export one component as `default`. Do not call `mount`: Pilot mounts the published component.
- Import only from `"nsh"` (views, text, canvas, signals, `token`, `reduceMotion`), `"nsh/base"`
  (behavior such as `Button`) and `"pilot-artifact/ui"` (the helpers below). Other imports, relative files and
  assets do not load.
- Put the data in the file. The artifact cannot fetch it later.
- Style with the theme's semantic classes (`bg-card`, `text-foreground`, `text-muted-foreground`,
  `border-border`, `bg-primary`) and the spacing scale (`gap-3`, `p-4`). The artifact then follows light and dark.
- Write every number as text. Say states in words; color only supports them.
- Keep motion short and skip it when `reduceMotion()` is true. Never imitate loading, progress or success: Pilot's
  viewer reports the artifact's real state itself.
- A mockup says it is a preview. It changes nothing outside itself.

## Helpers (`pilot-artifact/ui`)

Each helper takes declarative data and does the layout, sizing, arrows and labels. Data it cannot draw
faithfully (an unknown id, a negative bar, over a limit) shows the reason in place of the drawing. It never draws
part of it. Fix the data and publish again. The exact types are in [nsh/kit/index.ts](../nsh/kit/index.ts).

| Helper | Data | Limits |
| --- | --- | --- |
| `Page`, `Section`, `Card` | `title`, children | |
| `Stat` | `label`, `value`, optional `note` | |
| `ComparisonTable` | `spec: { columns, rows: [{ label, cells }], recommended? }` | 6 columns, 40 rows |
| `BarChart` | `spec: { bars: [{ label, value }], unit? }`, values from 0 | 50 bars |
| `TrendChart` | `spec: { points: [{ label, value }], unit? }`, `height?` | 2–400 points |
| `Timeline` | `spec: { events: [{ when, title, detail?, state? }] }`, state `done`, `now`, `next` | 50 events |
| `FlowDiagram` | `spec: { direction?, nodes: [{ id, label, detail?, tone? }], edges: [{ from, to, label?, dashed? }] }` | 40 steps, 80 links |
| `SequenceDiagram` | `spec: { participants: [{ id, label }], steps: [{ from, to, label, reply? } or { note, over }] }` | 10 participants, 80 steps |

- `FlowDiagram` reads `"right"` (default) or `"down"`. Loops (links back against the flow) are routed below the
  steps, and links that skip ranks go around the steps in their way. Tones are `default`, `accent`, `muted` and
  `danger`. Labels: 80 characters, details 160, link labels 40.
- `SequenceDiagram` draws a reply dashed. A message to the same participant loops. `over` takes one id or two.
- Wide diagrams scroll sideways. Boxes grow with the reader's text size.
- They cover flowcharts and sequences. For other diagram kinds (Gantt, class, state, entity), draw with
  `Canvas` and views.

## Mockups

- Fixed-size views are artboards: a phone (390 x 844), a tablet or a desktop window. Put alternatives side by side in
  a wrapping row (`flex-row flex-wrap`), and switch screen, width or theme from local state.
- Use mock data that looks real: names, dates and counts the product would show.
- Images, photos and other assets do not load inside NSH. Publish an image artifact beside the mockup instead.

## Examples

Copy one and change its data. Each is a complete artifact file.

- Summary cards and a comparison table: [nsh/examples/summary.tsx](../nsh/examples/summary.tsx)
- Bar chart, trend and timeline: [nsh/examples/charts.tsx](../nsh/examples/charts.tsx)
- Interactive mockup with local state: [nsh/examples/mockup.tsx](../nsh/examples/mockup.tsx)
- Architecture or process flow: [nsh/examples/flow.tsx](../nsh/examples/flow.tsx)
- Sequence diagram: [nsh/examples/sequence.tsx](../nsh/examples/sequence.tsx)
