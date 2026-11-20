# Pilot parts (`apps/day/ui`)

The component library every Pilot Day screen is built from. Its look is "Forge": one centred panel per page,
split by hairlines into columns and sections, with tabs attached to its top edge; a canvas with a faint grid; one
violet accent; numbers in Geist Mono; state marks built from squares; progress as a row of squares; compact
density. Today (`TodayScreen.tsx`) is the reference screen: read it next to this guide.

## Rules

- A screen imports parts from `./ui` only. It never imports `nsh/base` and never writes a class string for look:
  no colour, size, weight, font, border, radius, fill or padding. If a part is missing, add it to `ui/` (with a doc
  comment that states its rule) and to this guide. Screen code may still use `View` with plain layout classes
  (`flex-row`, `gap-2`, `flex-1`, `min-w-0`) where no part fits, but prefer `Rows`, `Chips`, `Buttons`,
  `Spacer` and `Block`.
- Text always goes through a text role. A screen picks a role and a tone; it never sets a size, weight or family.
- Every colour comes from a theme token (`theme.json`). Amber, red and green mean only Needs you, Failed and Ready.
- The library is embeddable: the artifact runtime will load it as it is. Files in `ui/` import only `nsh`,
  `nsh/base`, other files in `ui/` and assets (`../icons`, `../fonts`). They must not import Day's feeds,
  navigation, views or `pilot-day/native` (give the library its own structural types), and they make no host,
  storage, file or network calls.
- Every interactive part registers with the screen agent (`useAgent`). Pass `testID` for a stable name and
  `agent={{ confirm: "…" }}` on a commit only the person may press.
- JSX props are read once. Do not write `detail={cond() ? <A/> : undefined}`; write
  `detail={<If when={cond()}><A/></If>}` (the same for `trailing`, `action`, `meta`, `foot`, `actions`, `notice`).

## Tokens

Defined in `theme.json` for light and dark. Classes name them (`bg-card`, `text-faint`); `token("grid")` reads one
in a drawing. Screens never use them directly; parts do.

| Token                                          | Light / dark                       | Use                                                                                  |
| ---------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `background`                                   | #f7f7f8 / #0a0a0b                  | The canvas behind the panel, under the grid                                          |
| `card`                                         | #ffffff / #131315                  | The panel, fields, menus                                                             |
| `popover`                                      | #ffffff / #131315                  | Menus and the palette                                                                |
| `foreground`                                   | #18181b / #ededf0                  | Titles and body                                                                      |
| `muted-foreground`                             | #52525b / #a1a1aa                  | Meta and captions                                                                    |
| `faint`                                        | #8e8e98 / #6c6c75                  | Times, counts, quiet notes                                                           |
| `muted`                                        | #f1f1f3 / #1d1d20                  | Bubbles, pills, key caps, quotes                                                     |
| `accent`                                       | #f4f4f5 / #1a1a1c                  | Hover fill                                                                           |
| `selection`                                    | #ececef / #232327                  | The chosen row or option                                                             |
| `border`                                       | #e4e4e7 / #242428                  | Hairlines in and around the panel                                                    |
| `input`, `border-strong`                       | #d4d4d8 / #323237                  | Control frames, empty progress squares                                               |
| `primary`                                      | #6a5cf0 / #8677f7                  | The one commit, links, the selected ring                                             |
| `primary-foreground`                           | #ffffff / #13202f                  | Words on primary                                                                     |
| `needs`, `needs-ink`, `needs-soft`             | amber                              | Needs you: mark, words, soft fill                                                    |
| `failed`, `failed-ink`, `failed-soft`          | red                                | Failed: mark, words, soft fill (`failed-soft` is new: a failed notice or state pill) |
| `ok`, `ok-ink`, `ok-soft`                      | green                              | Ready to merge                                                                       |
| `progress`                                     | = primary                          | The dither sky's ink, a chart's bar                                                  |
| `soft`                                         | foreground at 7%                   | New: a chip's fill, the composer, a hovered path segment                             |
| `grid`                                         | foreground at 4.5% / white at 3.5% | New: the canvas grid lines (GridBackdrop only)                                       |
| `added`, `added-ink`, `removed`, `removed-ink` | green, red                         | Diff lines and their words (`-ink` forms are new)                                    |
| `added-strong`, `removed-strong`               |                                    | A diff's changed words                                                               |
| `track`                                        |                                    | A chart's empty track                                                                |
| `map-*`                                        |                                    | The Wayfinder chart's own paper only                                                 |

Theme values: `radius` 8 px (controls, tabs), `radius-panel` 10 px (the panel, the composer, menus),
`font-sans` Geist, `font-mono` Geist Mono. `ui/fonts.ts` registers the font files.

## Sizes

Compact is the only density. Control 26 points high (small 20), 10 points at the sides. Row: 6 points above and
below (30 with one line, 47 with meta). Panel: 16 points at the sides, 14 above a section heading. Radius 8 for
controls and tabs, 10 for the panel. Spacing 4, 8, 12, 16, 24, 32. Page: one panel at most 1088 points wide
(1040 inside the page padding), centred; 840 for forms. Type: display 22/28 bold, title 16/21 semibold,
heading 13/18 semibold, body 13/18, caption 11.5/17, numbers 11 in Geist Mono. The scale lives in `TYPE`
(`ui/text.tsx`); only library parts read it. Narrow (window under 880 points): the page pads 12, the head stacks,
the panel's columns stack.

## Parts

### Text roles (`text.tsx`)

`Display`, `Title`, `Heading`, `Body`, `BodyStrong`, `Caption` and `Num` (the Number role; named so it does not
hide JavaScript's `Number`). Rule: a screen picks a role and never sets size, weight or family.

- Display: the page's one headline (PageHead uses it). Title: the thing that asks (a Question's title, the Quiet
  line). Heading: a section's name (Section uses it). Body: rows' titles and sentences. BodyStrong: body one step
  heavier (a row title, an option). Caption: meta and help. Num: times, counts, ids, in mono.
- Props: `tone` (`default`, `muted`, `faint`, `needs`, `failed`, `ok`, `accent`, `onAccent`; each role has its own
  default: Caption is muted, Num faint), `role` (`header`, `alert`), `truncate` (one line), `grow` (take the rest of
  a row and shrink), `measure` (about 64 characters wide), `testID`, `accessibilityLabel`.

```tsx
<Num>{today().dateLine}</Num>
<Body tone="muted" measure>{a().why}</Body>
<Caption tone="faint">Opening the link does not count.</Caption>
```

### Mark, State, Progress, Pill (`state.tsx`)

- `Mark kind`: a still 14-point mark built from squares. Seven states: `needs` (filled amber square), `failed`
  (broken red square), `ready` (green square with a tick), `working` (hollow square), `paused` (two bars), `new`
  (small square), `done` (a tick). Older kinds still draw while screens move: `unknown` (hollow amber, "not
  confirmed"), `moving` (= working), `still` (small faint square: waiting, quiet), `unreported` (thin hollow
  square), `oldReport` (a document icon). Rule: words beside it carry the meaning; `label` names it when no words
  stand beside it. Marks never animate.
- `State kind label? plain?`: the mark and its word in a soft pill (amber, red, green fills only for those
  states). `label` replaces the default word ("Needs you", "Failed", "Ready to merge", "Working", "Paused", "New",
  "Done") with the screen's exact word ("Did not confirm"). `plain` drops the pill, for a meta line.
- `Progress counts`: a row of squares and a mono count ("■■■□□ 2/5"): done dark, stopped red, the rest faint;
  `counts` is `{ done, review, active, blocked, todo }`. Past 12 tasks each square is a share. Put it in a Row's
  trailing slot.
- `Pill count tone?`: a small mono count, beside a heading, a tab or a button. `tone="needs"` tints it amber.
- Helpers: `STATE_WORDS`, `markTone(kind)`.

```tsx
<State kind="paused" label="Pausing" />
<Row … trailing={<Progress counts={row.progress} />} />
```

### Button, Link, Chip and key hints (`button.tsx`, `keys.tsx`)

- `Button label kind? small? icon? iconOnly? count? disabled? shortcut? accessibilityLabel? testID? anchor? agent?
  onPress`. Kinds: `primary` (the screen's one commit), `secondary` (default: every other command), `quiet` (only
  the top bar and a composer's bar), `destructive` (removes or stops for good; put one line beside it that says
  what stays). 26 points high, 20 with `small` (a row's trailing slot, a row detail). Rule: one primary per screen.
- `Link label size? tone? icon? disabled? testID? anchor? onPress`: accent words without a frame, for a command in a
  section head, a notice, a section foot or a sentence. `size` `caption` (default) or `body`; `tone="faint"` for a
  quiet disclosure. Rule: never the screen's commit.
- `Chip label pressed onChange shortcut? disabled?`: turns a help on and off ("Say it simpler"); dark while pressed.
  Rule: chips only show help; they never pick, send or approve. Wrap several in `Chips`.
- `Chips`, `Buttons`: wrapping rows of chips (6 apart) or buttons (8 apart).
- `KeyCap label on?`, `KeyHint keys label` ("J K" makes two caps), `KeyHints hints` (`[["⌘↩", "Decide"], ["J K",
  "next"]]`): the keys that work here, at the end of a Question's foot.

```tsx
<Button kind="primary" label="Decide" shortcut={COMMIT_KEY} onPress={decide} />
<Button label="Later" shortcut="L" onPress={later} />
<Section title="New" action={<Link label="Open Linear" onPress={openLinear} />}>…</Section>
```

### Fields (`field.tsx`, `choice.tsx`, `picker.tsx`)

- `TextField`: every base `Input` prop, plus `variant` (`field` default, `composer` for inside a Composer, `title`),
  `rows` (1, 2, 3, 4, 5, 8), `invalid` (red frame), `class` (layout only, such as `flex-1`), `agent`. 26 high.
- `Field label value onChange help? error? masked? placeholder? rows? testID`: the label above, the help below; an
  error takes the help's place. Rule: a label sits above a field or leads its row.
- `ReadField label value evidence?`: a read-only fact.
- `Picker` is the select: `label items value placeholder onChange detail? searchable? disabled? testID`. 26 high,
  framed like a field, with a chevron. In a Row, put it in the trailing slot.
- `Switch checked accessibilityLabel onChange disabled? testID?`: for a setting that takes effect at once, in a Row's
  trailing slot; the row's title is its label.
- `Checkbox label checked onChange`: a box and its words, for a pick outside a Question.
- `Options multiple?` and `Option title tag? hint? checked onChange multiple? compact? disabled? testID? anchor?`:
  a Question's answers. A ring (or a box with `multiple`), the title, a tag ("Recommended", "Suggested") and a
  hint; the chosen option is filled. `compact` is a one-line option for short lists. `Options` reaches 12 points
  past the Question's text so the rings line up with it.
- `Menu open onOpenChange trigger align? agentLabel?` with `MenuTitle label` and `MenuItem label hint? onSelect`;
  `MenuTrigger icon accessibilityLabel tooltip` is an icon trigger.

```tsx
<Row title="Retry failed work once" meta="A failed task restarts once before it asks you"
	trailing={<Switch checked={retry()} accessibilityLabel="Retry failed work once" onChange={setRetry} />} />
<Options>
	<Each of={d().options} key={(o) => o.id}>
		{(o) => <Option title={o().label} tag={o().recommended ? "Recommended" : undefined} hint={o().detail}
			checked={chosen(d()) === o().id} onChange={() => choose(o().id)} />}
	</Each>
</Options>
```

### Row (`section.tsx`)

The one row of every list, settings included. Five slots, each filled or empty, never restyled:
`mark` (a MarkKind), `title` (one line, cut off when long; `wrap` lets a sentence wrap), `meta` (one caption line),
`state` (a word in a soft pill; `stateTone` `needs`, `failed`, `ok` or `quiet`) and `trailing` (a `Num` time, a
`Progress`, a small `Button`, a `Link`, a `Switch` or a `Picker`). Other props: `onPress` (the whole row opens what
it names; then its trailing slot holds no button), `accessibilityLabel` (what a pressable row says: title, state,
what pressing does), `anchor` (for `placeRow` focus restore), `selected`, `selectable`, `testID` (on the press
target when pressable, else on the whole row), `detail`.

- `detail` is for the rare row that must show more under its meta: its own Continue and Dismiss, a quote, a
  "Decide" link, its report's source. Wrap it in `RowDetail`. It sits outside the press target.
- `Rows` holds rows and draws the hairlines between them (from the text's start to the right edge; none above the
  first). Always put rows in `Rows`.
- `RowGroup label` splits one section's rows into groups ("Moving · 1"), or names a project above its rows.
- Rule: at most five rows in a section, then a "Show all N" link (Section `more`) or a tab.

```tsx
<Rows>
	<Row
		testID={`mission-${m.id}`}
		mark={stateMark(m)}
		title={m.title}
		meta={rowLine(m)}
		state={stateWord(m)}
		stateTone={stateTone(m)}
		trailing={<Progress counts={m.progress} />}
		accessibilityLabel={`${m.title}, ${stateWord(m)}. Open the mission.`}
		anchor={place.anchor}
		onPress={place.press}
	/>
</Rows>;
```

### Section, Block, EmptyLine (`section.tsx`)

- `Section title count? note? action? more? footnote? testID`: a heading, a count pill (hidden at 0), a quiet mono
  note, at most one action (a `Link`) at the right; its body; a foot with the `more` link (`{ label, onPress,
  testID? }`) and a `footnote`. Sections in a column are split by hairlines. Rule: a section never gets its own box.
- `Block gap?`: padded content that is not rows (sentences, a form, a report), lined up with the heading.
- `EmptyLine text`: the one quiet line of an empty section, or a read note ("Working chats could not be read.").
  An empty list that could not be read says so; it never shows as empty.

```tsx
<Section title="Missions" count={n} more={n > 5 ? { label: `Show all ${n}`, onPress: showAll } : undefined}>
	<If when={n === 0}>
		<EmptyLine text="No active missions." />
	</If>
	<Rows>…</Rows>
</Section>;
```

### Panel, Columns, Column, Tabs, Tab (`panel.tsx`)

- `Panel tabs? notice? testID`: the page's one framed container (hairline border, radius 10, panel surface). Its
  children are `Columns` or one `Column`. Rule: one panel per page; nothing inside draws a box.
- `Columns main side`: two columns split by a hairline (1.45 to 1); in a narrow window `side` moves under `main`.
  Put what needs the user in `main`.
- `Column centered?`: sections stacked with hairlines; `centered` keeps a single column at 820 points in the middle
  (a filtered tab).
- `Tabs` and `Tab label selected onPress count? testID`: attached to the panel's top edge (the Panel's `tabs`). They
  are the page's sub-pages or, on Today, its filters. Left and Right move between them. A tab's count is the same
  number its section shows.

```tsx
<Panel
	tabs={
		<Tabs>
			<Tab label="Overview" selected={tab() === "overview"} onPress={() => tab.set("overview")} />…
		</Tabs>
	}
	notice={<FreshnessNote day={day} placement="panel" />}
>
	<Columns
		main={
			<>
				<NeedsYou />
				<New />
			</>
		}
		side={
			<>
				<WorkingNow />
				<Missions />
			</>
		}
	/>
</Panel>;
```

### Notice (`notice.tsx`)

`Notice text kind? detail? action? placement? role? testID`: one problem, one way out. A mark, the words, a quieter
detail and at most one `action` (a `Link` or a small `Button`). `kind` `needs` (default, amber: the user can act) or
`failed` (red: something failed). `placement`: `panel` (full width at the top of the panel, via Panel's `notice`),
`section` (inset among a section's rows), `flow` (default, for screens not yet on a Panel). Rule: one problem per
notice, beside what it affects; it never hides what is shown. `children` and `class` are deprecated.

### Question (`question.tsx`)

`Question title position? meta? foot? testID? titleTestID? anchor? children`: the one thing that waits for an
answer. Title role, its place ("1 of 3") in mono, a meta line (a plain `State` with the reason, then `Caption`s),
the body (sentences, `Chips`, `Options`, fields, `Quote`s for opened help, `Facts`) and a foot (one primary
Button, secondary Buttons, `Spacer`, `KeyHints`). It has no frame: put it first in a Section; the panel frames it.
Rule: one question shows at a time; the others queue under it as `Row`s.

```tsx
<Section title="Needs you" count={n}>
	<Question
		title={d.title}
		position="1 of 3"
		meta={
			<>
				<State kind="needs" label={d.reason} plain />
				<Caption>· {d.missionTitle}</Caption>
			</>
		}
		foot={
			<>
				<Button kind="primary" label="Decide" onPress={decide} />
				<Button label="Later" onPress={later} />
				<Spacer />
				<KeyHints
					hints={[
						["⌘↩", "Decide"],
						["J K", "next"],
					]}
				/>
			</>
		}
	>
		<Body measure>{d.context}</Body>
		<Options>…</Options>
	</Question>
	<Rows>{/* the rest, as rows */}</Rows>
</Section>;
```

### Chat pieces (`chat.tsx`, `disclosure.tsx`)

- `Bubble text? scheduled?`: the user's message, muted, at the right, at most 80% wide. `scheduled` draws a dashed
  outline for a message that waits to send.
- `Reply`: the agent's answer at a reading width (put Markdown, `Quote` or code inside).
- A folded turn is a `Disclosure label open onToggle` ("Worked for 3 min · read 3 files") with `Steps steps` inside
  (`{ id, text, running? }`; the running step is darker).
- `Event text failed?`: an automatic item on one quiet line; only a real failure gets a red mark.
- `Tray summary open? onToggle?`: the composer's tray of tasks and subagents.
- `WorkingLine text background?`: live work, directly above the composer.
- `Composer field bar?`: a soft frame; `field` is a `TextField variant="composer"`, `bar` holds a quiet Button or
  Picker, a `Spacer`, `KeyHints` and Send.
- `Quote text? code?`: quoted words or code on a muted block (a planner's last message, opened help).

### Quiet and the canvas (`quiet.tsx`)

- `Quiet title text? height?`: when nothing needs the user, the section says so under Pilot's dithered sky (ordered
  Bayer dither, 3-point square pixels, accent ink and an amber sun at 60%). 300 high, full section width. It is the
  only decoration in the app. It draws once per size and appearance.
- `GridBackdrop`: the canvas's 32-point grid. The window root (`DayScreen`) draws it once; screens keep their
  `Scroll` transparent so it shows.

### Page and PageHead (`layout.tsx`)

- `Page width? gap? testID`: the centred column inside the screen's `Scroll`: 1088 wide (`width="form"`: 840), 24
  at the sides (12 narrow), 30 above. New pages leave `gap` at 0. It holds a PageHead, a Panel and a PageFoot.
- `PageHead title pre? state? text? actions? titleTestID? testID? children?`: a quiet line above the title (`Num`
  date, project), the Display title with the page's `State` beside it, one or two sentences, more lines as children
  (a `Caption`, a `Notice`), and Secondary buttons or a Picker at the right (`actions`). Rule: one title line that
  says what matters now.
- `PageFoot text`: one quiet closing line under the panel.
- `Spacer`: pushes what follows to the end of a row. `narrow()`: whether the window is under 880.

### Facts, evidence and charts (`data.tsx`)

`Facts` with `Fact label` (label and value pairs, selectable), `EvidenceList items`, `EvidenceChip evidence`,
`Bars bars`. Types are the library's own (`EvidenceItem`, `BarItem`), shaped like the native ones.

### Top bar (`path.tsx`) — the shell only

`PathBar trailing` with `Logo`, `PathSegment label onPress` (Pilot, or Back to the parent), `PathSlash`, `PathMenu
label open onOpenChange` (where you are; its `MenuItem`s are the places beside it), `PathNote text dashed?` (the
window's project, "Mock data") and `SearchButton keys compact? onPress`. `Chrome.tsx` uses them; screens do not.

### Other parts

- `Disclosure`, `DividedRow`, `ExpandableRow`: content shown on request; opening only shows.
- `Icon name tint?`: one 16-point line icon family (`check`, `chevron`, `right` are new).
- `Arrive`, `FadeIn`, `createPanelMotion`, `glide`: the one quiet motion treatment.
- `PatchDiff`, `ReviewDiff`, `MarkdownPreview`.
- `Pressable`: a bare press target for library parts and the single-use overlays. Screens use Row, Button or Link.
- `useAgent`, `AgentScope`: the screen agent's registry.

## Moving a screen

Checklist:

1. Wrap the screen in `<Scroll class="flex-1">` (transparent: no `bg-background`) and `<Page>` (`width="form"` for
   Settings-like pages).
2. Replace the title block with `PageHead`: date or project in `pre`, the title, the page's `State`, the summary in
   `text`, its commands as Secondary Buttons in `actions`.
3. Put everything else in one `Panel`. Sub-pages become `Tabs`/`Tab` on the Panel. A problem that affects the whole
   page becomes the Panel's `notice` (`Notice placement="panel"`).
4. Split the content into `Section`s, in `Columns` (what needs the user in `main`) or one `Column`.
5. Make every list `Rows` of `Row`: map each hand-built row onto mark, title, meta, state and trailing. A row that
   opens something gets `onPress` and an `accessibilityLabel`; keep its `testID` and `placeRow` anchor.
6. The thing that waits for an answer becomes a `Question` first in its section; the rest queue as rows.
7. Replace every `Text class="text-…"` with a text role and a tone.
8. Remove look classes from the screen. Keep only layout (`flex-row`, `gap-*`, `flex-1`, `min-w-0`), and prefer the
   layout parts. Run `nsh build` and look for "unknown classes" in test logs.
9. Keep behaviour, wording (DESIGN.md "State vocabulary" and "Attention budget"), keyboard access and test IDs.
   Update a test only where the structure changed (a new group label, a moved section), and say why in it.
10. Capture the screen in light and dark at 1100 and 480 (see `TodayVisual.test.tsx`) and compare it with Today.

Old to new:

| Old                                                                 | New                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `PAGE_COLUMN`, `Page gap={…}`                                       | `Page` (gap 0) holding `PageHead`, `Panel`, `PageFoot`                 |
| `PageTitle`                                                         | `PageHead title`                                                       |
| `SectionTitle`                                                      | `Section` (heading, `count` pill, `note`, one `action`)                |
| Hand-built rows (`View … border-t py-3`, `RowLink`, `MarkLine`)     | `Rows` of `Row`                                                        |
| `RowLink` + state words                                             | `Row onPress state stateTone`                                          |
| Group captions ("Moving  2")                                        | `RowGroup label="Moving · 2"`                                          |
| `Action variant="primary"`                                          | `Button kind="primary"`                                                |
| `Action variant="outline"`                                          | `Button` (secondary)                                                   |
| `Action` plain in page flow ("Show all", "Read again")              | `Link`, or Section `more`                                              |
| `Action` plain in a row                                             | `Button small` in the trailing slot                                    |
| `Action iconOnly` in the top bar                                    | `Button kind="quiet" iconOnly`                                         |
| `InlineAction`, `LinkAction`                                        | `Link`                                                                 |
| `ToggleChip`                                                        | `Chip` inside `Chips`                                                  |
| `Badge`                                                             | `Pill` (or Button `count`)                                             |
| `Track`                                                             | `Progress`                                                             |
| `Panel` (old, now `QuietPanel`) for a problem                       | `Notice`                                                               |
| `QuietPanel` / a card that asks (`rounded-2xl border bg-card px-6`) | `Question`                                                             |
| `QuietPanel` for a quote, opened help or code                       | `Quote`                                                                |
| `QuietPanel` of label/value lines                                   | `Facts` / `Fact`                                                       |
| `Notice` with `children` or `class`                                 | `Notice` with `detail`, one `action` and a `placement`                 |
| `RadioList` / `RadioRow size="lg"`                                  | `Options` / `Option`                                                   |
| `RadioRow` (md)                                                     | `Option compact`                                                       |
| `CheckboxRow`                                                       | `Option multiple` (Question) or `Checkbox`                             |
| `ToggleRow` + `PickMark`                                            | `Option`                                                               |
| `TabRow` / `TabItem`                                                | `Tabs` / `Tab` on the Panel                                            |
| `TextField compact` / `large`                                       | `TextField` (one size)                                                 |
| `Text class="text-xs text-faint"` and friends                       | `Caption tone="faint"`, `Body`, `Num`…                                 |
| `View class="flex-1"` in a row of buttons                           | `Spacer`                                                               |
| Mark kinds `moving`, `still`, `unreported`, `unknown`               | `working`, `new`/`paused`, `working`, `needs` where the meaning allows |

Deprecated (kept, restyled, while screens move; each says so in its doc comment): `PAGE_COLUMN`, `PageTitle`,
`SectionTitle`, `QuietPanel`, `Action`, `ActionVariant`, `Badge`, `InlineAction`, `RowLink`, `ToggleChip`,
`LinkAction`, `MarkLine`, `Track`, `RadioList`, `RadioRow`, `CheckboxRow`, `ToggleRow`, `PickMark`, `ChoiceSize`,
`TabRow`, `TabItem`, `TextField`'s `compact` and `large`, `Notice`'s `children` and `class`, and the older Mark
kinds. Remove each once no screen uses it.
