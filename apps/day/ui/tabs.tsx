// Tabs that switch one pane in place.
import { type JSX, Text } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { type AgentMark, useAgent } from "./agent";
import { FOCUS_RING } from "./button";

/** A row of tabs. The page shows the selected tab's content below it. */
export function TabRow(props: { children?: JSX.Element }) {
	return (
		<Tabs class="flex-row gap-0.5 rounded-lg bg-muted p-0.5" indicatorClass="inset-y-0.5 rounded-md bg-background">
			{props.children}
		</Tabs>
	);
}

/** One tab of a `TabRow`. */
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
			class={`group rounded-md px-3 py-1 ${FOCUS_RING}`}
		>
			<Text class="text-sm text-muted-foreground group-selected:text-foreground">{props.label}</Text>
		</Tab>
	);
}
