// Test fixture: the mock Linux mission with a large map (many split research questions),
// as the still chart on the planning page shows it. Every record is invented mock data.
import { computed, type JSX, mount, Scroll, View } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { chartState, ExpeditionChart } from "./ExpeditionChart";
import { openPlanning } from "./mockFeeds";
import { largeMap } from "./mockLargeMap";
import { Block, Caption, GridBackdrop } from "./ui";

const plans = openPlanning("wayfinder");
void plans.feed.open("linux");
const page = computed(() => {
	plans.planning();
	const p = plans.feed.page("linux");
	return p ? largeMap(p as PlanPage) : null;
});
export const state = chartState();

// LIBRARY GAP: no part paints a window's canvas (the background colour and GridBackdrop) for a fixture that mounts
// a screen or a control without DayScreen. This local root does what DayScreen's root does.
function FixtureWindow(props: { children?: JSX.Element }) {
	return (
		<View class="flex-1 bg-background">
			<GridBackdrop />
			{props.children}
		</View>
	);
}

mount(() => (
	<FixtureWindow>
		<Scroll class="flex-1">
			<Block gap={3}>
				<Caption tone="faint">Mock data</Caption>
				<If when={page()}>{(p) => <ExpeditionChart plans={plans} page={p()} state={state} mode="inline" />}</If>
			</Block>
		</Scroll>
	</FixtureWindow>
));
