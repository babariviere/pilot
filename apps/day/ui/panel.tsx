// The panel: one framed container per page, split by hairlines into columns and sections, with its tabs attached
// to its top edge. A section never gets its own box; the panel is the only frame on a page.
import { type JSX, Text, View } from "nsh";
import { Tab as BaseTab, Tabs as BaseTabs } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { FOCUS_RING } from "./button";
import { narrow } from "./layout";
import { Pill } from "./state";
import { TYPE } from "./text";

/**
 * The page's one framed container: a hairline border, radius 10, on the panel surface. `tabs` attach to its top
 * edge; `notice` spans its full width at the top (a `Notice placement="panel"`); its children are `Columns` or one
 * `Column` of `Section`s. Rule: one panel per page, and nothing inside draws a box of its own.
 */
export function Panel(props: {
	testID?: string;
	/** The panel's `Tabs`, attached to its top edge. */
	tabs?: JSX.Element;
	/** One full-width `Notice` at the top: the one problem that affects the whole panel. */
	notice?: JSX.Element;
	children?: JSX.Element;
}) {
	return (
		<View testID={props.testID}>
			<View class="relative z-10 -mb-px">{props.tabs}</View>
			<View class="overflow-hidden rounded-(--radius-panel) border border-border bg-card">
				{props.notice}
				{props.children}
			</View>
		</View>
	);
}

/**
 * One column of sections. Sections inside are split by full-width hairlines; the first draws none. `centered`
 * keeps a single column at a reading width (820 points) in the middle of a wide panel, for a filtered tab.
 */
export function Column(props: { testID?: string; centered?: boolean; children?: JSX.Element }) {
	return (
		<View
			testID={props.testID}
			class={`min-w-0 overflow-hidden ${props.centered ? "w-full self-center" : ""}`}
			style={props.centered ? { maxWidth: 820 } : undefined}
		>
			<View class="-mt-px">{props.children}</View>
		</View>
	);
}

/**
 * Two columns side by side, split by a hairline: `main` takes the larger share (1.45 to 1), `side` the rest. In a
 * narrow window `side` moves under `main`, split by a hairline. Rule: put what needs the user in `main`.
 */
export function Columns(props: { main: JSX.Element; side: JSX.Element; testID?: string }) {
	return (
		<View testID={props.testID} class={narrow() ? "" : "flex-row"}>
			<View class="min-w-0" style={narrow() ? undefined : { flexGrow: 1.45, flexShrink: 1, flexBasis: 0 }}>
				<Column>{props.main}</Column>
			</View>
			<View
				class={`min-w-0 border-border ${narrow() ? "border-t" : "border-l"}`}
				style={narrow() ? undefined : { flexGrow: 1, flexShrink: 1, flexBasis: 0 }}
			>
				<Column>{props.side}</Column>
			</View>
		</View>
	);
}

/** A panel's tab list, attached to its top edge. Left and Right move between tabs; the page owns which is chosen. */
export function Tabs(props: { testID?: string; children?: JSX.Element }) {
	return (
		<BaseTabs testID={props.testID} class="flex-row gap-0.5 px-2.5">
			{props.children}
		</BaseTabs>
	);
}

/**
 * One tab of a panel: its words and an optional count pill. The selected tab joins the panel. Tabs are the page's
 * sub-pages or, on Today, its filters. Rule: a tab's count is the same number its section shows.
 */
export function Tab(props: {
	label: string;
	selected: boolean;
	count?: number | null;
	testID?: string;
	agent?: AgentMark;
	onPress: () => void;
}) {
	const agent = useAgent({
		component: "tab",
		label: () => props.label,
		id: () => props.testID,
		state: { selected: () => props.selected },
		mark: () => props.agent,
		actions: {
			select: () => {
				if (!props.selected) props.onPress();
			},
		},
	});
	return (
		<BaseTab
			ref={agent.anchor}
			testID={props.testID}
			selected={props.selected}
			onPress={props.onPress}
			class={`group h-8.5 flex-row items-center gap-2 rounded-t-lg border border-b-0 px-3 ${props.selected ? "border-border bg-card" : "border-transparent"} ${FOCUS_RING}`}
		>
			<Text
				class={props.selected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}
				style={TYPE.control}
			>
				{props.label}
			</Text>
			<If when={props.count}>
				<Pill count={props.count ?? 0} />
			</If>
		</BaseTab>
	);
}
