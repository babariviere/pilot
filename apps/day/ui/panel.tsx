// The panel: one framed container per page, split by hairlines into columns and sections, with its tabs attached
// to its top edge. A section never gets its own box; the panel is the only frame on a page.
import { type JSX, Scroll, Text, View } from "nsh";
import { Tab as BaseTab, Tabs as BaseTabs } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { FOCUS_RING } from "./button";
import { narrow } from "./layout";
import { Pill } from "./state";
import { Caption, TYPE } from "./text";

/**
 * The page's one framed container: a hairline border, radius 10, on the panel surface. `tabs` attach to its top
 * edge; `notice` spans its full width at the top (a `Notice placement="panel"`); its children are `Columns` or one
 * `Column` of `Section`s. `fill` makes it take the rest of a `Page fill`'s height, for content that scrolls on
 * its own (a diff), so what sits above it stays put. Rule: one panel per page, and nothing inside draws a box of its
 * own.
 */
export function Panel(props: {
	testID?: string;
	/** The panel's `Tabs`, attached to its top edge. */
	tabs?: JSX.Element;
	/** One full-width `Notice` at the top: the one problem that affects the whole panel. */
	notice?: JSX.Element;
	/** Takes the rest of the page's height (inside a `Page fill`). */
	fill?: boolean;
	children?: JSX.Element;
}) {
	return (
		<View testID={props.testID} class={props.fill ? "min-h-0 flex-1" : ""}>
			<View class="relative z-10 -mb-px">{props.tabs}</View>
			<View
				class={`overflow-hidden rounded-(--radius-panel) border border-border bg-card ${props.fill ? "min-h-0 flex-1" : ""}`}
			>
				{props.notice}
				{props.children}
			</View>
		</View>
	);
}

/**
 * One column of sections. Sections inside are split by full-width hairlines; the first draws none. `centered`
 * keeps a single column at a reading width (820 points) in the middle of a wide panel, for a filtered tab. `under`
 * is a full-width column under `Columns` (a chart that needs the panel's whole width): its first section keeps the
 * hairline that splits it from the columns.
 */
export function Column(props: { testID?: string; centered?: boolean; under?: boolean; children?: JSX.Element }) {
	return (
		<View
			testID={props.testID}
			class={`min-w-0 overflow-hidden ${props.centered ? "w-full self-center" : ""}`}
			style={props.centered ? { maxWidth: 820 } : undefined}
		>
			<View class={props.under ? "" : "-mt-px"}>{props.children}</View>
		</View>
	);
}

/** Which slice of a panel cut for a virtualized List. */
export type PanelSlicePart = "head" | "top" | "item" | "foot";

/**
 * A page whose panel holds a virtualized `List` (a page of 100 reports draws only the rows on screen): the List
 * scrolls the whole page, so the page and its panel are cut into slices, each at the page's width. `head` holds the
 * `PageHead` (the List's header, placed as `Page` places it); `top` is the panel's top edge with its notices and
 * filters; each `item` is one list item between the panel's sides; `foot` closes the panel and keeps the page's
 * bottom space (the List's footer). Rule: only for a list that can grow past a screen; a short list is a `Panel`.
 */
export function PanelSlice(props: { part: PanelSlicePart; testID?: string; children?: JSX.Element }) {
	const frame = () =>
		({
			head: "",
			top: "overflow-hidden rounded-t-(--radius-panel) border-x border-t border-border bg-card",
			item: "overflow-hidden border-x border-border bg-card",
			foot: "h-2.5 rounded-b-(--radius-panel) border-x border-b border-border bg-card",
		})[props.part];
	return (
		<View
			testID={props.testID}
			class={`w-full self-center ${narrow() ? "px-3" : "px-6"} ${props.part === "head" ? "pt-7.5" : props.part === "foot" ? "pb-24" : ""}`}
			style={{ maxWidth: 1088 }}
		>
			<View class={frame()}>{props.children}</View>
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

/**
 * A tab list: on a panel's top edge (the Panel's `tabs`) or in a `TabBar`. Left and Right move between tabs; the
 * page owns which is chosen. Tabs that do not fit the width scroll sideways (no bar shows), so none hides from the
 * pointer in a narrow window.
 */
export function Tabs(props: { testID?: string; children?: JSX.Element }) {
	return (
		<Scroll horizontal scrollbar={false}>
			<BaseTabs testID={props.testID} class="flex-row gap-0.5 px-2.5">
				{props.children}
			</BaseTabs>
		</Scroll>
	);
}

/**
 * Tabs for a view inside a section (Before and After of one output, a mockup's variants): an optional `label` at
 * the left, the `Tabs`, an `aside` at the right (the view's own tools) and a hairline under them that the selected
 * tab joins, as a Panel's tabs join its edge. The chosen view follows under it. Rule: the page's own sub-pages are
 * the Panel's tabs; a TabBar switches only one view inside a section.
 */
export function TabBar(props: { label?: string; aside?: JSX.Element; testID?: string; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class="flex-row flex-wrap items-end gap-x-3 border-b border-border">
			<If when={props.label}>
				<View class="pb-2">
					<Caption>{props.label ?? ""}</Caption>
				</View>
			</If>
			<View class="-mb-px min-w-0 shrink">
				<Tabs>{props.children}</Tabs>
			</View>
			<View class="flex-1" />
			<View class="flex-row items-center gap-2 pb-1">{props.aside}</View>
		</View>
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
