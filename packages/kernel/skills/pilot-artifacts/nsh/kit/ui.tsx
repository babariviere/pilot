// Page structure for artifacts: a scrolling page, sections, cards, stats and a
// comparison table. They draw with the theme's semantic tokens only, so an
// artifact follows the app's light and dark appearance.
import { type Component, computed, ErrorBoundary, fontScale, type JSX, mount, Scroll, Text, View } from "nsh";
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

/** A scrolling page with a title. Most artifacts start here. */
export function Page(props: { title: string; subtitle?: string; children?: JSX.Element }) {
	return (
		<Scroll class="flex-1">
			<View class="gap-6 p-6">
				<View class="gap-1">
					<Text role="header" class="text-xl font-semibold text-foreground">
						{props.title}
					</Text>
					<If when={props.subtitle}>
						<Text class="text-sm text-muted-foreground">{props.subtitle}</Text>
					</If>
				</View>
				{props.children}
			</View>
		</Scroll>
	);
}

/** A titled region of a page. */
export function Section(props: { title: string; children?: JSX.Element }) {
	return (
		<View class="gap-3">
			<Text role="header" class="text-base font-semibold text-foreground">
				{props.title}
			</Text>
			{props.children}
		</View>
	);
}

/** A surface for one group of content. Avoid cards inside cards. */
export function Card(props: { title?: string; children?: JSX.Element; class?: string }) {
	return (
		<View class={`gap-3 rounded-xl border border-border bg-card p-4 ${props.class ?? ""}`}>
			<If when={props.title}>
				<Text role="header" class="text-sm font-semibold text-card-foreground">
					{props.title}
				</Text>
			</If>
			{props.children}
		</View>
	);
}

/** One figure with its label. Put several in a `View class="flex-row flex-wrap gap-3"`. */
export function Stat(props: { label: string; value: string; note?: string }) {
	return (
		<View class="min-w-40 flex-1 gap-1 rounded-xl border border-border bg-card p-4">
			<Text class="text-xs text-muted-foreground">{props.label}</Text>
			<Text class="text-2xl font-semibold tabular-nums text-card-foreground">{props.value}</Text>
			<If when={props.note}>
				<Text class="text-xs text-muted-foreground">{props.note}</Text>
			</If>
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
