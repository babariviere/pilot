// Small read-only displays: an agent's evidence and charts whose words carry every number. The types are the
// library's own, so the library needs nothing from Day's native module.
import { type JSX, signal, Text, View } from "nsh";
import { Link } from "./button";
import { TYPE } from "./text";

/** One piece of evidence: its words and how it bears on the report. */
export type EvidenceItem = { label: string; tone: "neutral" | "warn" | "bad" | (string & {}) };
/** One bar of a chart: its name and its value. */
export type BarItem = { label: string; value: number };
/** A mission's task counts. */
export type TrackCounts = { done: number; review: number; active: number; blocked: number; todo: number };

/**
 * Facts about one thing, as label and value pairs ("Where", "Link", "Asked by"; "Project", "Branch"): labels faint
 * in a fixed column, values beside them, selectable. Put `Fact`s inside.
 */
export function Facts(props: { testID?: string; children?: JSX.Element }) {
	return (
		<View testID={props.testID} selectable class="gap-1.5">
			{props.children}
		</View>
	);
}

/** One fact of `Facts`: its label and its value (two lines at most). */
export function Fact(props: { label: string; testID?: string; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class="flex-row gap-4">
			<Text class="w-20 text-faint" style={TYPE.caption}>
				{props.label}
			</Text>
			<Text class="line-clamp-2 min-w-0 flex-1 text-foreground" style={TYPE.caption}>
				{props.children}
			</Text>
		</View>
	);
}

/**
 * An agent's evidence: the sentences that back its report. Long and many, so a quiet wrapped list rather than
 * chips, with the first three shown and the rest one press away. Chips stay for short labels.
 */
export function EvidenceList(props: { items: string[]; testID?: string }) {
	const all = signal(false);
	const shown = () => (all() ? props.items : props.items.slice(0, EVIDENCE_SHOWN));
	return (
		<If when={props.items.length > 0}>
			<View testID={props.testID} selectable class="gap-1 border-l-2 border-border pl-3">
				<Each of={shown()} key={(e) => e}>
					{(e) => (
						<Text class="text-muted-foreground" style={TYPE.caption}>
							{e()}
						</Text>
					)}
				</Each>
				<If when={props.items.length > EVIDENCE_SHOWN}>
					<Link
						testID={props.testID ? `${props.testID}-more` : undefined}
						label={all() ? "Show less" : `Show ${props.items.length - EVIDENCE_SHOWN} more`}
						onPress={() => all.set(!all())}
					/>
				</If>
			</View>
		</If>
	);
}
/** Evidence lines shown before "Show more": enough to judge a report at a glance. */
const EVIDENCE_SHOWN = 3;

/** One piece of evidence, as a quiet chip whose words take the tone. */
export function EvidenceChip(props: { evidence: EvidenceItem }) {
	return (
		<View class="rounded-md bg-muted px-1.5 py-0.5">
			<Text
				class={
					props.evidence.tone === "warn"
						? "text-needs-ink"
						: props.evidence.tone === "bad"
							? "text-failed-ink"
							: "text-muted-foreground"
				}
				style={TYPE.caption}
			>
				{props.evidence.label}
			</Text>
		</View>
	);
}

/** A small horizontal bar chart: one labelled bar per count, on one scale. Words carry every number. */
export function Bars(props: { bars: BarItem[] }) {
	const most = () => Math.max(1, ...props.bars.map((b) => b.value));
	return (
		<View class="gap-2">
			<Each of={props.bars} key={(b) => b.label}>
				{(b) => (
					<View class="flex-row items-center gap-3">
						<Text class="w-28 text-muted-foreground" style={TYPE.caption}>
							{b().label}
						</Text>
						<View class="h-1.5 flex-1 flex-row overflow-hidden bg-track">
							<View class="h-full bg-progress" style={{ flexGrow: b().value, flexBasis: 0 }} />
							<View class="h-full" style={{ flexGrow: most() - b().value, flexBasis: 0 }} />
						</View>
						<Text class="w-8 text-right font-mono text-foreground" style={TYPE.number}>
							{String(b().value)}
						</Text>
					</View>
				)}
			</Each>
		</View>
	);
}

/**
 * A mission's tasks as one thin bar: done, in progress, stopped, not started.
 * @deprecated Use `Progress` (a row of squares and a count).
 */
export function Track(props: { progress: TrackCounts }) {
	return (
		<View class="h-1 w-40 flex-row overflow-hidden bg-track">
			<View class="h-full bg-muted-foreground" style={{ flexGrow: props.progress.done, flexBasis: 0 }} />
			<View
				class="h-full bg-progress"
				style={{ flexGrow: props.progress.review + props.progress.active, flexBasis: 0 }}
			/>
			<View class="h-full bg-failed" style={{ flexGrow: props.progress.blocked, flexBasis: 0 }} />
			<View class="h-full" style={{ flexGrow: props.progress.todo, flexBasis: 0 }} />
		</View>
	);
}
