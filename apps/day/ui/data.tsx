// Small read-only displays: key caps, an agent's evidence, and charts whose
// words carry every number.
import { signal, Text, View } from "nsh";
import type { Bar, Evidence, Progress } from "pilot-day/native";
import { Action } from "./button";

/** A key the user can press, as a small cap. `on` fills it: the choice it picks is chosen. */
export function KeyCap(props: { label: string; on?: boolean }) {
	return (
		<View
			class="h-5 min-w-5 items-center justify-center rounded-md px-1"
			classList={{ "bg-primary": props.on === true, "bg-muted": props.on !== true }}
		>
			<Text
				class="text-xs font-semibold"
				classList={{ "text-primary-foreground": props.on === true, "text-muted-foreground": props.on !== true }}
			>
				{props.label}
			</Text>
		</View>
	);
}

/** A keyboard hint: a key cap and what it does, such as "0 write". */
export function KeyHint(props: { keys: string; label: string }) {
	return (
		<View class="flex-row items-center gap-1.5">
			<KeyCap label={props.keys} />
			<Text class="text-xs text-faint">{props.label}</Text>
		</View>
	);
}

/**
 * An agent's evidence: the sentences it says back its report. Long and many, so a quiet wrapped list rather than
 * chips, with the first three shown and the rest one press away. Chips stay for short labels.
 */
export function EvidenceList(props: { items: string[]; testID?: string }) {
	const all = signal(false);
	const shown = () => (all() ? props.items : props.items.slice(0, EVIDENCE_SHOWN));
	return (
		<If when={props.items.length > 0}>
			<View testID={props.testID} selectable class="gap-1 border-l-2 border-border pl-3">
				<Each of={shown()} key={(e) => e}>
					{(e) => <Text class="text-xs leading-relaxed text-muted-foreground">{e()}</Text>}
				</Each>
				<If when={props.items.length > EVIDENCE_SHOWN}>
					<View class="-ml-3 flex-row">
						<Action
							testID={props.testID ? `${props.testID}-more` : undefined}
							label={all() ? "Show less" : `Show ${props.items.length - EVIDENCE_SHOWN} more`}
							onPress={() => all.set(!all())}
						/>
					</View>
				</If>
			</View>
		</If>
	);
}
/** Evidence lines shown before "Show more": enough to judge a report at a glance. */
const EVIDENCE_SHOWN = 3;

/** One piece of evidence, as a quiet chip. */
export function EvidenceChip(props: { evidence: Evidence }) {
	return (
		<View class="rounded-full bg-muted px-2.5 py-0.5">
			<Text
				class="text-xs"
				classList={{
					"text-muted-foreground": props.evidence.tone === "neutral",
					"text-needs-ink": props.evidence.tone === "warn",
					"text-failed-ink": props.evidence.tone === "bad",
				}}
			>
				{props.evidence.label}
			</Text>
		</View>
	);
}

/** A small horizontal bar chart: one labelled bar per count, on one scale. Words carry every number. */
export function Bars(props: { bars: Bar[] }) {
	const most = () => Math.max(1, ...props.bars.map((b) => b.value));
	return (
		<View class="gap-2">
			<Each of={props.bars} key={(b) => b.label}>
				{(b) => (
					<View class="flex-row items-center gap-3">
						<Text class="w-28 text-xs text-muted-foreground">{b().label}</Text>
						<View class="h-2 flex-1 flex-row overflow-hidden rounded-full bg-track">
							<View class="h-full rounded-full bg-progress" style={{ flexGrow: b().value, flexBasis: 0 }} />
							<View class="h-full" style={{ flexGrow: most() - b().value, flexBasis: 0 }} />
						</View>
						<Text class="w-8 text-right text-xs text-foreground">{String(b().value)}</Text>
					</View>
				)}
			</Each>
		</View>
	);
}

/** A mission's tasks as one thin bar: done, in progress, stopped, not started. */
export function Track(props: { progress: Progress }) {
	return (
		<View class="h-1 w-40 flex-row overflow-hidden rounded-full bg-track">
			<View class="h-full bg-ok" style={{ flexGrow: props.progress.done, flexBasis: 0 }} />
			<View
				class="h-full bg-progress"
				style={{ flexGrow: props.progress.review + props.progress.active, flexBasis: 0 }}
			/>
			<View class="h-full bg-failed" style={{ flexGrow: props.progress.blocked, flexBasis: 0 }} />
			<View class="h-full" style={{ flexGrow: props.progress.todo, flexBasis: 0 }} />
		</View>
	);
}
