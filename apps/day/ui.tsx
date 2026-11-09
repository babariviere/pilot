// The Day screen's styled controls, drawn from nsh/base behavior and the
// theme's tokens. Pages compose these; they do not restyle base controls.
import { type JSX, Text, View, type ViewRef } from "nsh";
import { Button, DiffView, Tab, Tabs, Toggle } from "nsh/base";
import type { Bar, Evidence, Progress } from "pilot-day/native";

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

/** A command. `primary` marks the decision's one default commit. */
export function Action(props: {
	label: string;
	primary?: boolean;
	disabled?: boolean;
	accessibilityLabel?: string;
	/** The keyboard shortcut, shown as a tooltip, such as "⌘↩". */
	shortcut?: string;
	testID?: string;
	/** Hears the button's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	onPress: () => void;
}) {
	return (
		<Button
			ref={props.anchor}
			testID={props.testID}
			disabled={props.disabled}
			accessibilityLabel={props.accessibilityLabel ?? null}
			tooltip={props.shortcut ? `${props.label}  ${props.shortcut}` : undefined}
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
export function InlineAction(props: { label: string; testID?: string; onPress: () => void }) {
	return (
		<Button
			testID={props.testID}
			onPress={props.onPress}
			class="rounded-sm focus-visible:ring-2 focus-visible:ring-ring/40"
		>
			<Text class="text-sm text-needs-ink underline">{props.label}</Text>
		</Button>
	);
}

/** A help toggle on a decision card. */
export function HelpChip(props: {
	label: string;
	pressed: boolean;
	/** The key that toggles it, shown as a tooltip. */
	shortcut?: string;
	/** Hears the chip's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	onChange: (pressed: boolean) => void;
}) {
	return (
		<Toggle
			ref={props.anchor}
			pressed={props.pressed}
			tooltip={props.shortcut ? `${props.label}  ${props.shortcut}` : undefined}
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

/** A row of tabs. The page shows the selected tab's content below it. */
export function TabRow(props: { children?: JSX.Element }) {
	return (
		<Tabs class="flex-row gap-0.5 rounded-lg bg-muted p-0.5" indicatorClass="inset-y-0.5 rounded-md bg-background">
			{props.children}
		</Tabs>
	);
}

/** One tab of a `TabRow`. */
export function TabItem(props: { label: string; selected: boolean; testID?: string; onPress: () => void }) {
	return (
		<Tab
			testID={props.testID}
			selected={props.selected}
			onPress={props.onPress}
			class="group rounded-md px-3 py-1 focus-visible:ring-2 focus-visible:ring-ring/40"
		>
			<Text class="text-sm text-muted-foreground group-selected:text-foreground">{props.label}</Text>
		</Tab>
	);
}

/**
 * A read-only diff of one exact patch: one column, changed words marked,
 * only the rows in view made. It offers no hunk actions: nothing here edits,
 * reverts or keeps a change.
 */
export function PatchDiff(props: { patch: string; testID?: string }) {
	return (
		<DiffView
			testID={props.testID}
			patch={props.patch}
			layout="unified"
			inline="word"
			indicators="classic"
			class="min-h-48 flex-1 overflow-hidden rounded-lg border border-border"
			classes={{
				gutter: "bg-muted",
				lineNumber: "text-faint",
				content: "text-foreground",
				lineAdded: "bg-added",
				lineDeleted: "bg-removed",
				wordAdded: "bg-added-strong",
				wordDeleted: "bg-removed-strong",
				indicatorAdded: "text-ok-ink",
				indicatorDeleted: "text-failed-ink",
				separator: "bg-muted text-faint",
				fileHeader: "bg-secondary text-foreground",
				filler: "bg-muted",
			}}
		/>
	);
}
