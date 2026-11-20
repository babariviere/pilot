// Page structure for artifacts: a scrolling page, sections, cards, stats and a
// comparison table. Page, Section, Card, Choices and Stat keep their props for
// saved artifacts and draw with Pilot's own parts (`pilot-day/ui`, Day's
// component library). Everything draws with the theme's semantic tokens, so an
// artifact follows the app's light and dark appearance.
import { type Component, computed, ErrorBoundary, fontScale, type JSX, mount, Scroll, Text, View } from "nsh";
import { Block, Page as DayPage, Figure, Heading, PageHead, Panel, Tab, TabBar } from "pilot-day/ui";
import { attempt, type Laid, list, Problem, record, text } from "./check";

/** Text grows with the reader's text size up to this factor; diagram boxes grow with it. */
export const MAX_TEXT_SCALE = 1.6;

/** The reader's text size as a factor, kept between 0.85 and MAX_TEXT_SCALE. */
export function textScale(): number {
	return Math.min(Math.max(fontScale(), 0.85), MAX_TEXT_SCALE);
}

/** Follows a layout that may be refused: `value` while it can be drawn, `problem` otherwise. */
export function outcome<T>(build: () => Laid<T>): { value: () => T | undefined; problem: () => string } {
	const laid = computed(build);
	return {
		value: () => {
			const l = laid();
			return l.ok ? l.layout : undefined;
		},
		problem: () => {
			const l = laid();
			return l.ok ? "" : l.problem;
		},
	};
}

/**
 * Mounts an artifact's default export. Pilot's viewer calls this with the
 * published component; an artifact never calls it itself. An error thrown
 * while the artifact renders replaces it with what went wrong.
 */
export function mountArtifact(Artifact: Component): () => void {
	return mount(() => (
		<View class="flex-1 bg-background">
			<ErrorBoundary fallback={(error) => <Stopped error={error} />}>
				<Artifact />
			</ErrorBoundary>
		</View>
	));
}

function Stopped(props: { error: unknown }) {
	const message = () => (props.error instanceof Error ? props.error.message : String(props.error));
	return (
		<View role="alert" selectable class="m-6 gap-1 rounded-lg border border-destructive bg-card p-4">
			<Text class="text-sm font-medium text-card-foreground">This artifact stopped with an error.</Text>
			<Text class="text-sm text-muted-foreground">{message()}</Text>
		</View>
	);
}

/** Says plainly why data cannot be drawn, in place of a partial drawing. */
export function DataProblem(props: { what: string; problem: string }) {
	return (
		<View role="alert" selectable class="gap-1 rounded-lg border border-border bg-muted p-3">
			<Text class="text-sm font-medium text-foreground">{`This ${props.what} can't be drawn.`}</Text>
			<Text class="text-sm text-muted-foreground">{props.problem}</Text>
		</View>
	);
}

/** A scrolling page with a title: Pilot's page head (`pilot-day/ui` `Page` and `PageHead`), then the children. */
export function Page(props: { title: string; subtitle?: string; children?: JSX.Element }) {
	return (
		<Scroll class="flex-1">
			<DayPage>
				<PageHead title={props.title} text={props.subtitle} />
				<View class="gap-6">{props.children}</View>
			</DayPage>
		</Scroll>
	);
}

/** A titled region of a page: Pilot's section heading, then the children. */
export function Section(props: { title: string; children?: JSX.Element }) {
	return (
		<View class="gap-3">
			<Heading role="header">{props.title}</Heading>
			{props.children}
		</View>
	);
}

/** A surface for one group of content: a Pilot `Panel`. `class` places it (`w-64`, `m-3`). Avoid cards inside cards. */
export function Card(props: { title?: string; children?: JSX.Element; class?: string }) {
	return (
		<View class={props.class}>
			<Panel>
				<View class="gap-3 p-4">
					<If when={props.title}>
						<Heading role="header">{props.title ?? ""}</Heading>
					</If>
					{props.children}
				</View>
			</Panel>
		</View>
	);
}

/** One option of a choice: its id and the words on it. */
export interface ChoiceOption<T extends string> {
	id: T;
	label: string;
}

/**
 * A labelled row of options with one chosen, to switch variants, situations or settings in a mockup: Pilot's
 * `TabBar` (its tabs on a hairline). Many options scroll sideways. Publishing presses each one once.
 */
export function Choices<T extends string>(props: {
	label: string;
	options: readonly ChoiceOption<T>[];
	value: T;
	onChange: (id: T) => void;
}) {
	return (
		<TabBar label={props.label}>
			<Each of={props.options} key={(o) => o.id}>
				{(o) => <Tab label={o().label} selected={props.value === o().id} onPress={() => props.onChange(o().id)} />}
			</Each>
		</TabBar>
	);
}

/** One figure with its label, on a Pilot `Panel` (Day's `Figure`). Put several in a `View class="flex-row flex-wrap gap-3"`. */
export function Stat(props: { label: string; value: string; note?: string }) {
	return (
		<View class="min-w-40 flex-1">
			<Panel>
				<Block>
					<Figure label={props.label} value={props.value} note={props.note} />
				</Block>
			</Panel>
		</View>
	);
}

export interface ComparisonRow {
	label: string;
	cells: readonly string[];
}

export interface ComparisonSpec {
	columns: readonly string[];
	rows: readonly ComparisonRow[];
	/** The index of a column to mark as recommended. The word "Recommended" shows in its header. */
	recommended?: number;
}

export const TABLE_LIMITS = { columns: 6, rows: 40, header: 40, cell: 160 } as const;

function readTable(spec: unknown): ComparisonSpec {
	const data = record(spec, "The table");
	const columns = list(data.columns, "columns", 1, TABLE_LIMITS.columns).map((c, i) =>
		text(c, `columns[${i}]`, TABLE_LIMITS.header),
	);
	const rows = list(data.rows, "rows", 1, TABLE_LIMITS.rows).map((value, i) => {
		const row = record(value, `rows[${i}]`);
		const label = text(row.label, `rows[${i}].label`, TABLE_LIMITS.header);
		const cells = list(row.cells, `Row "${label}" cells`, columns.length, columns.length).map((c, j) =>
			text(c, `Row "${label}" cell ${j + 1}`, TABLE_LIMITS.cell),
		);
		return { label, cells };
	});
	const recommended = data.recommended;
	if (
		recommended !== undefined &&
		(!Number.isInteger(recommended) || (recommended as number) < 0 || (recommended as number) >= columns.length)
	)
		throw new Problem("recommended must be the index of a column.");
	return { columns, rows, recommended: recommended as number | undefined };
}

/** Options side by side: one column per option, one row per question. */
export function ComparisonTable(props: { spec: ComparisonSpec }) {
	const table = outcome(() => attempt(() => readTable(props.spec)));
	return (
		<If when={table.value()} else={<DataProblem what="table" problem={table.problem()} />}>
			{(t) => (
				<View selectable class="overflow-hidden rounded-xl border border-border bg-card">
					<View class="flex-row border-b border-border bg-muted px-4 py-2.5">
						<View class="w-40" />
						<Each of={t().columns} key="index">
							{(column, i) => (
								<View class="flex-1 gap-0.5 px-2">
									<Text class="text-sm font-semibold text-foreground">{column()}</Text>
									<If when={t().recommended === i()}>
										<Text class="text-xs text-primary">Recommended</Text>
									</If>
								</View>
							)}
						</Each>
					</View>
					<Each of={t().rows} key="index">
						{(row, r) => (
							<View class={`flex-row px-4 py-2.5 ${r() > 0 ? "border-t border-border" : ""}`}>
								<Text class="w-40 pr-2 text-sm text-muted-foreground">{row().label}</Text>
								<Each of={row().cells} key="index">
									{(cell) => <Text class="flex-1 px-2 text-sm text-card-foreground">{cell()}</Text>}
								</Each>
							</View>
						)}
					</Each>
				</View>
			)}
		</If>
	);
}
