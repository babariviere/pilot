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
2. Publish it with the artifact tool. The tool compiles the captured bytes, then runs them once like Day's
   preview: headless, 900 x 650, with the same helpers, sandbox and limits. A compile error, a thrown error or a
   stopped preview saves nothing; fix the file and publish again. Success saves those exact bytes as a new
   revision. Every reader and preview uses that saved revision, never the file. Editing the file changes nothing
   until you publish an update.
3. Read the result. `preview` lists the texts the first screen shows. The run also presses each tab and
   `Choices` option once and refuses errors in those variants. Other buttons are not pressed. A warning about text
   with no room means part of a screen is blank in Day: fix it and update. The run checks errors and layout, not
   looks or fonts. It is not a full TypeScript typecheck.
4. Workspace cleanup deletes the scratch folder, unpublished files included. Published revisions stay.

## The file

```tsx
import { Scroll } from "nsh";
import { Column, Num, Page, PageHead, Panel, Row, Rows, Section } from "pilot-day/ui";

export default function Artifact() {
	return (
		<Scroll class="flex-1">
			<Page>
				<PageHead title="Release plan" text="Checked on 12 November." />
				<Panel>
					<Column>
						<Section title="Issues">
							<Rows>
								<Row title="Open issues" trailing={<Num>12</Num>} />
								<Row title="Ready to ship" mark="ready" trailing={<Num>3</Num>} />
							</Rows>
						</Section>
					</Column>
				</Panel>
			</Page>
		</Scroll>
	);
}
```

- Export one component as `default`. Do not call `mount` or `mountArtifact`: Pilot mounts the published component.
- Import anything from `"nsh"`, `"nsh/base"`, `"nsh/base/plot"`, `"pilot-day/ui"` and `"pilot-artifact/ui"`:
  views, animation, gestures, keymap, editors, charts, Pilot's parts. Refused, with the reason in the error: what
  reaches outside the preview (`host`, `Clipboard`, `Storage`, `openUrl`, `Picker`, `WebView`, `Notifications`,
  sound and speech, `nsh/base`'s `Link`, `Terminal`, `AlertDialog`), shaders, `mount`, other modules and
  relative files.
- `If` and `Each` are built into the JSX and need no import: `<If when={…} else={…}>`, `<Each of={rows} key={(r) => r.id}>{(r) => …r()…}</Each>`.
- Read a signal by calling it, `count()`, and change it with `count.set(next)`. There is no `.get()` or `.value`:
  they stop the preview with "not a function".
- Wrap `pilot-day/ui`'s `Page` in one `<Scroll class="flex-1">`, as above. (`pilot-artifact/ui`'s `Page` scrolls
  already.) Do not put another `Scroll`, `flex-1` or `h-full` view inside: it gets no height and what it holds does
  not show. Only a wide row may scroll sideways with `<Scroll horizontal>`.
- Put the data in the file. The artifact cannot fetch it later.
- Build with `pilot-day/ui`; do not hand-style. Its parts carry Pilot's type, colours, spacing and states in light and
  dark. Plain `View`s take layout classes only (`flex-row`, `gap-2`, `flex-1`, `min-w-0`). Only a mock of something
  that is not Pilot (a phone, another app) uses the theme's classes (`bg-card`, `text-foreground`, `border-border`).
- Write every number as text. Say states in words; color only supports them.
- Never imitate loading, progress or success: Pilot's viewer reports the artifact's real state itself.
- A mockup says it is a preview. It changes nothing outside itself.

## Pilot's parts (`pilot-day/ui`)

The same parts Pilot's own screens use. A page is `Page` > `PageHead` + one `Panel` of `Section`s.

| Parts                                                   | For                                   | Key props                                                                                           |
| ------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Page`, `PageHead`, `PageFoot`                          | The page column, its head and a foot  | PageHead `title`, `pre`, `state`, `text`, `actions`                                                 |
| `Panel`, `Columns`, `Column`                            | The page's one frame, in 2 or 1 cols  | Panel `tabs`, `notice`; Columns `main`, `side`; Column `centered`                                   |
| `Tabs`, `Tab`                                           | Sub-pages, filters, variant switches  | Tab `label`, `selected`, `onPress`, `count`                                                         |
| `Section`, `Block`, `EmptyLine`                         | A panel's parts; text; an empty list  | Section `title`, `count`, `note`, `action` (a `Link`), `more`, `footnote`                           |
| `Rows`, `Row`, `RowDetail`, `RowGroup`                  | Every list                            | Row `title`, `mark`, `meta`, `state`, `stateTone`, `trailing`, `detail`, `onPress`                  |
| `Question`, `Options`, `Option`                         | The one thing that waits for answer   | Question `title`, `position`, `meta`, `foot`; Option `title`, `tag`, `hint`, `checked`, `onChange`  |
| `Button`, `Link`, `Buttons`, `Spacer`, `KeyHints`       | Commands                              | Button `label`, `kind` (`primary`, `secondary`, `quiet`, `destructive`), `small`, `icon`, `onPress` |
| `Notice`                                                | One problem and one way out           | `text`, `kind` (`needs`, `failed`), `detail`, `action`, `placement` (`panel`, `section`)            |
| `State`, `Mark`, `Progress`, `Pill`                     | States and counts                     | `kind`: `needs`, `failed`, `ready`, `working`, `paused`, `new`, `done`; Progress `counts`           |
| `Display`, `Title`, `Heading`, `Body`, `Caption`, `Num` | Every text, by role                   | `tone` (`muted`, `faint`, `needs`, `failed`, `ok`, `accent`), `truncate`, `measure`                 |
| `Field`, `TextField`, `Switch`, `Checkbox`, `Picker`    | Inputs                                | Field `label`, `value`, `onChange`; Switch `checked`, `accessibilityLabel`, `onChange`              |
| `Facts`, `Fact`, `Quote`, `Chips`, `Chip`, `Icon`       | Label/value pairs, quotes, help, icon | Fact `label`; Chip `label`, `pressed`, `onChange`; Icon `name` (`check`, `share`, `plus`, `search`) |
| `Bubble`, `Reply`, `Steps`, `Composer`, `Disclosure`    | A chat and folded detail              | Bubble `text`; Disclosure `label`, `open`, `onToggle`                                               |

- One `Panel` and one `primary` Button per page. Lists are `Rows` of `Row`. A `Question` comes first in its
  `Section`. Amber, red and green mean only Needs you, Failed and Ready.
- Props that take JSX are read once: write `detail={<If when={open()}>…</If>}`, not `open() ? <A/> : undefined`.
- Icons are `Icon` names only. Images and other assets do not load.

## Helpers (`pilot-artifact/ui`)

Each helper takes declarative data and does the layout, sizing, arrows and labels. Data it cannot draw
faithfully (an unknown id, a negative bar, over a limit) shows the reason in place of the drawing. It never draws
part of it. Fix the data and publish again. The exact types are in [nsh/kit/index.ts](../nsh/kit/index.ts).

| Helper            | Data                                                                                                   | Limits                    |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------- |
| `Choices`         | `label`, `options: [{ id, label }]`, `value`, `onChange`: tabs to switch variants above a panel        |                           |
| `ComparisonTable` | `spec: { columns, rows: [{ label, cells }], recommended? }`                                            | 6 columns, 40 rows        |
| `BarChart`        | `spec: { bars: [{ label, value }], unit? }`, values from 0                                             | 50 bars                   |
| `TrendChart`      | `spec: { points: [{ label, value }], unit? }`, `height?`                                               | 2–400 points              |
| `Timeline`        | `spec: { events: [{ when, title, detail?, state? }] }`, state `done`, `now`, `next`                    | 50 events                 |
| `FlowDiagram`     | `spec: { direction?, nodes: [{ id, label, detail?, tone? }], edges: [{ from, to, label?, dashed? }] }` | 40 steps, 80 links        |
| `SequenceDiagram` | `spec: { participants: [{ id, label }], steps: [{ from, to, label, reply? } or { note, over }] }`      | 10 participants, 80 steps |

- `FlowDiagram` reads `"right"` (default) or `"down"`. Loops (links back against the flow) are routed below the
  steps, and links that skip ranks go around the steps in their way. Tones are `default`, `accent`, `muted` and
  `danger`. Labels: 80 characters, details 160, link labels 40.
- `SequenceDiagram` draws a reply dashed. A message to the same participant loops. `over` takes one id or two.
- Wide diagrams scroll sideways. Boxes grow with the reader's text size.
- `Page`, `Section`, `Card` and `Stat` still work for older artifacts and draw with Pilot's parts. New ones use
  `pilot-day/ui`.
- They cover flowcharts and sequences. For other diagram kinds (Gantt, class, state, entity), draw with
  `Canvas` and views.

## Mockups

- Fixed-size views are artboards: a phone (390 x 844), a tablet or a desktop window. Put alternatives side by side in
  a wrapping row (`flex-row flex-wrap`), and switch screen, width or theme from local state.
- Use mock data that looks real: names, dates and counts the product would show.
- Every variant, situation or setting switch must be a `Tab` or `Choices`: publishing presses only those, so errors
  behind your own chips or buttons go unchecked. Hand-made chips also look empty on macOS when hovered.
- A prototype starts from [nsh/examples/prototype.tsx](../nsh/examples/prototype.tsx): variants of one screen inside
  a realistic copy of the screen around it, tried in a few situations. It draws only the shown variant.
- Images, photos and other assets do not load inside NSH. Publish an image artifact beside the mockup instead.

## Examples

Copy one and change its data. Each is a complete artifact file.

- A page that looks like Pilot (head, panel with tabs, rows, a question): [nsh/examples/page.tsx](../nsh/examples/page.tsx)
- Key figures and a comparison table: [nsh/examples/summary.tsx](../nsh/examples/summary.tsx)
- Bar chart, trend and timeline: [nsh/examples/charts.tsx](../nsh/examples/charts.tsx)
- Interactive mockup with local state: [nsh/examples/mockup.tsx](../nsh/examples/mockup.tsx)
- Prototype with variants and situations: [nsh/examples/prototype.tsx](../nsh/examples/prototype.tsx)
- Architecture or process flow: [nsh/examples/flow.tsx](../nsh/examples/flow.tsx)
- Sequence diagram: [nsh/examples/sequence.tsx](../nsh/examples/sequence.tsx)
