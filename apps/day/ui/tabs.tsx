// Older in-place tabs: a segmented row that switches one pane. Kept while screens move.
import { type JSX, Text } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { FOCUS_RING } from "./button";
import { TYPE } from "./text";

/**
 * A row of tabs. The page shows the selected tab's content below it.
 * @deprecated Use `Tabs` and `Tab` attached to the page's `Panel` (its `tabs` prop).
 */
export function TabRow(props: { children?: JSX.Element }) {
	return (
		<Tabs
			class="flex-row gap-0.5 self-start rounded-(--radius-panel) bg-soft p-0.5"
			indicatorClass="inset-y-0.5 rounded-lg bg-card"
		>
			{props.children}
		</Tabs>
	);
}

/**
 * One tab of a `TabRow`.
 * @deprecated Use `Tab`.
 */
export function TabItem(props: {
	label: string;
	selected: boolean;
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
		<Tab
			ref={agent.anchor}
			testID={props.testID}
			selected={props.selected}
			onPress={props.onPress}
			class={`group h-5.5 justify-center rounded-lg px-3 ${FOCUS_RING}`}
		>
			<Text class="text-muted-foreground group-selected:text-foreground" style={TYPE.control}>
				{props.label}
			</Text>
		</Tab>
	);
}
