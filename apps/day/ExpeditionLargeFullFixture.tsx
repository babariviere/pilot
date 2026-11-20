// Test fixture: the large mock map's chart, open full window from the start. Mock data.
import { computed, type JSX, mount, View } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { FullChart } from "./ExpeditionChart";
import { openPlanning } from "./mockFeeds";
import { largeMap } from "./mockLargeMap";
import { Caption, GridBackdrop } from "./ui";

const plans = openPlanning("wayfinder");
void plans.feed.open("linux");
const page = computed(() => {
	plans.planning();
	const p = plans.feed.page("linux");
	return p ? largeMap(p as PlanPage) : null;
});

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
		<If when={page()}>{(p) => <FullChart plans={plans} page={p()} onClose={() => {}} />}</If>
		<View class="absolute bottom-1 left-6">
			<Caption tone="faint">Mock data</Caption>
		</View>
	</FixtureWindow>
));
