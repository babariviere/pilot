// The Day screen's styled controls, drawn from nsh/base behavior and the
// theme's tokens. Pages compose these; they do not restyle base controls.
import { type JSX, Text, View } from "nsh";
import { Button, Toggle } from "nsh/base";
import type { Evidence, Progress } from "pilot-day/native";

/** A still state mark. Words beside it carry the meaning. */
export type MarkKind = "needs" | "failed" | "ready" | "unknown" | "moving" | "still" | "paused" | "unreported" | "done";

const MARKS: Record<MarkKind, string> = {
	needs: "bg-needs",
	failed: "bg-failed",
	ready: "bg-ok",
	done: "bg-faint",
	unknown: "border-2 border-needs",
	moving: "border-2 border-faint",
	still: "bg-faint",
	paused: "bg-faint",
	unreported: "border border-dashed border-faint",
};

/** A small round mark for a state. */
export function Mark(props: { kind: MarkKind }) {
	return <View class={`size-2 rounded-full ${MARKS[props.kind]}`} />;
}

/** A command. `primary` marks the decision's one default commit. */
export function Action(props: {
	label: string;
	primary?: boolean;
	disabled?: boolean;
	accessibilityLabel?: string;
	onPress: () => void;
}) {
	return (
		<Button
			disabled={props.disabled}
			accessibilityLabel={props.accessibilityLabel ?? null}
			onPress={props.onPress}
			class={
				props.primary
					? "min-h-8 flex-row items-center rounded-lg bg-primary px-3.5 py-1 active:opacity-90 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/40"
					: "min-h-8 flex-row items-center rounded-lg px-3 py-1 hover:bg-accent active:bg-accent disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/40"
			}
		>
			<Text class={props.primary ? "text-sm font-medium text-primary-foreground" : "text-sm text-muted-foreground"}>
				{props.label}
			</Text>
		</Button>
	);
}

/** A row that opens what it names: its title, then trailing content. */
export function RowLink(props: {
	testID: string;
	title: string;
	accessibilityLabel: string;
	onPress: () => void;
	children?: JSX.Element;
}) {
	return (
		<Button
			testID={props.testID}
			accessibilityLabel={props.accessibilityLabel}
			onPress={props.onPress}
			class="group flex-row items-baseline gap-3 rounded-md focus-visible:ring-2 focus-visible:ring-ring/40"
		>
			<Text class="flex-1 text-sm font-medium text-foreground group-hover:underline">{props.title}</Text>
			{props.children}
		</Button>
	);
}

/** An inline text command inside a sentence. */
export function InlineAction(props: { label: string; onPress: () => void }) {
	return (
		<Button onPress={props.onPress} class="rounded-sm focus-visible:ring-2 focus-visible:ring-ring/40">
			<Text class="text-sm text-needs-ink underline">{props.label}</Text>
		</Button>
	);
}

/** A help toggle on a decision card. */
export function HelpChip(props: { label: string; pressed: boolean; onChange: (pressed: boolean) => void }) {
	return (
		<Toggle
			pressed={props.pressed}
			onChange={({ pressed }) => props.onChange(pressed)}
			class="group rounded-full border border-border-strong px-3 py-1 hover:bg-accent aria-pressed:border-primary/40 aria-pressed:bg-selection focus-visible:ring-2 focus-visible:ring-ring/40"
		>
			<Text class="text-xs text-muted-foreground group-aria-pressed:text-foreground">{props.label}</Text>
		</Toggle>
	);
}

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

/** A section's title with an optional count and trailing content. */
export function SectionTitle(props: { title: string; count?: number | null; children?: JSX.Element }) {
	return (
		<View class="flex-row items-baseline gap-2">
			<Text role="header" class="text-sm font-semibold text-muted-foreground">
				{props.title}
			</Text>
			<If when={props.count != null && props.count > 0}>
				<Text class="text-sm text-faint">{String(props.count)}</Text>
			</If>
			<View class="flex-1" />
			{props.children}
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
