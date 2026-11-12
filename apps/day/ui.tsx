// The Day screen's styled controls, drawn from nsh/base behavior and the
// theme's tokens. Pages compose these; they do not restyle base controls.
import { type JSX, Text, View, type ViewRef } from "nsh";
import {
	Button,
	type DiffFile,
	DiffView,
	type DiffViewClasses,
	type DiffViewRef,
	Radio,
	Select,
	type SelectItem,
	Tab,
	Tabs,
	Toggle,
} from "nsh/base";
import type { Bar, Evidence, Progress } from "pilot-day/native";

/** A still state mark. Words beside it carry the meaning. */
export type MarkKind =
	| "needs"
	| "failed"
	| "ready"
	| "unknown"
	| "moving"
	| "still"
	| "paused"
	| "unreported"
	| "done"
	| "new";

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
	// A request that came in and nobody started: present, not urgent.
	new: "bg-muted-foreground",
};

/** A small round mark for a state. */
export function Mark(props: { kind: MarkKind }) {
	return <View class={`size-2 rounded-full transition-colors duration-200 ${MARKS[props.kind]}`} />;
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
					? "min-h-8 flex-row items-center rounded-lg bg-primary px-3.5 py-1 transition duration-150 active:opacity-90 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/40"
					: "min-h-8 flex-row items-center rounded-lg px-3 py-1 transition duration-150 hover:bg-accent active:bg-accent disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/40"
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
	/** Hears the row's view, to give it the keyboard focus. */
	anchor?: (node: ViewRef) => void;
	onPress: () => void;
	children?: JSX.Element;
}) {
	return (
		<Button
			ref={props.anchor}
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

/**
 * One value chosen from a list, such as a project: a quiet trigger naming
 * the choice, and a popup list with a second line per item (`detail`).
 * `searchable` adds a filter field for long lists. Choosing only reports
 * the value; the caller decides what that does.
 */
export function Picker(props: {
	testID?: string;
	/** What the choice is about, for screen readers. */
	label: string;
	items: SelectItem[];
	value: string | null;
	/** What the trigger says while nothing listed is chosen. */
	placeholder: string;
	disabled?: boolean;
	searchable?: boolean;
	searchPlaceholder?: string;
	/** A quiet second line for an item, by value. */
	detail?: (value: string) => string;
	onChange: (value: string) => void;
	onOpenChange?: (open: boolean) => void;
}) {
	const title = () => props.items.find((i) => i.value === props.value)?.title ?? props.placeholder;
	return (
		<Select
			testID={props.testID}
			items={props.items}
			value={props.value}
			disabled={props.disabled}
			searchable={props.searchable}
			searchPlaceholder={props.searchPlaceholder ?? null}
			searchAccessibilityLabel={props.searchPlaceholder ?? null}
			accessibilityLabel={props.label}
			offset={4}
			onChange={({ value }) => {
				if (value !== null) props.onChange(value);
			}}
			onOpenChange={({ open }) => props.onOpenChange?.(open)}
			class="rounded-lg focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
			popupClass="min-w-56 rounded-xl border border-border bg-popover p-1 shadow-md"
			listClass="max-h-72"
			itemClass="group rounded-lg px-2.5 py-1.5 focus:bg-accent selected:bg-selection disabled:opacity-50"
			searchClass="mb-1 rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm text-foreground"
			renderItem={(item) => (
				<View class="gap-0.5">
					<Text class="text-sm text-popover-foreground group-selected:font-medium">{item.title}</Text>
					<If when={props.detail?.(item.value)}>
						<Text class="text-xs text-faint">{props.detail?.(item.value) ?? ""}</Text>
					</If>
				</View>
			)}
			trigger={
				<View class="min-h-8 flex-row items-center gap-2 rounded-lg border border-input px-3 py-1 hover:bg-accent">
					<Text class="text-sm text-foreground">{title()}</Text>
					<Text class="text-xs text-faint">▾</Text>
				</View>
			}
		/>
	);
}

/** One choice of a `RadioGroup`: a ring, then its words. */
export function RadioRow(props: {
	testID?: string;
	label: string;
	checked: boolean;
	disabled?: boolean;
	onChange: () => void;
}) {
	return (
		<Radio
			testID={props.testID}
			checked={props.checked}
			disabled={props.disabled}
			onChange={props.onChange}
			class="group flex-row items-center gap-2.5 rounded-lg px-2 py-1.5 checked:bg-selection hover:bg-accent checked:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
		>
			<View class="size-3.5 items-center justify-center rounded-full border border-input group-checked:border-primary">
				<View class="size-1.5 rounded-full group-checked:bg-primary" />
			</View>
			<Text class="text-sm text-foreground">{props.label}</Text>
		</Radio>
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
 * The diff's parts. `lineSelected` is drawn over the selected rows' code,
 * so it must stay see-through: the theme's `selection` is an opaque fill
 * (made for chips and options) and would hide the code under it.
 */
export const DIFF_CLASSES: DiffViewClasses = {
	gutter: "bg-background",
	lineNumber: "text-faint",
	content: "text-foreground",
	lineAdded: "bg-added",
	lineDeleted: "bg-removed",
	wordAdded: "bg-added-strong",
	wordDeleted: "bg-removed-strong",
	indicatorAdded: "text-ok-ink",
	indicatorDeleted: "text-failed-ink",
	separator: "bg-muted text-faint",
	filler: "bg-muted",
	lineSelected: "bg-primary/15",
};

/** A file's header in the diff: its path and counts. A press folds its lines away or back. */
function FileHeader(props: { file: DiffFile; onToggle: () => void }) {
	const path = () => (props.file.oldPath ? `${props.file.oldPath} → ${props.file.path}` : props.file.path);
	return (
		<Button
			accessibilityLabel={`${path()}. ${props.file.collapsed ? "Show its lines" : "Hide its lines"}.`}
			onPress={props.onToggle}
			class="flex-1 flex-row items-center gap-2 border-y border-border bg-muted px-3 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
		>
			<Text class="w-3 text-xs text-faint">{props.file.collapsed ? "▸" : "▾"}</Text>
			<Text class="flex-1 truncate font-mono text-xs text-foreground">{path()}</Text>
			<Text class="text-xs text-faint">
				{props.file.binary ? "binary" : `+${props.file.added} −${props.file.deleted}`}
			</Text>
		</Button>
	);
}

/**
 * A read-only diff of one exact patch: one column, changed words marked,
 * long lines wrapped, each file under its header. Only the rows in view are
 * made, so a long patch stays light. It fills the room its page gives it,
 * with no frame of its own: the page is the review. It offers no hunk
 * actions: nothing here edits, reverts or keeps a change.
 */
export function PatchDiff(props: { patch: string; testID?: string }) {
	let diff: DiffViewRef | undefined;
	return (
		<DiffView
			ref={(r) => {
				diff = r;
			}}
			testID={props.testID}
			patch={props.patch}
			layout="unified"
			inline="word"
			indicators="classic"
			softWrap
			class="min-h-0 flex-1"
			classes={DIFF_CLASSES}
			renderFileHeader={(file) => <FileHeader file={file} onToggle={() => diff?.toggleFile(file.path)} />}
		/>
	);
}
