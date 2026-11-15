// Test fixture: the mock Linux mission with a large map (many split research questions),
// as the still chart on the planning page shows it. Every record is invented mock data.
import { computed, mount, Scroll, Text, View } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { chartState, ExpeditionChart } from "./ExpeditionChart";
import { openPlanning } from "./mockFeeds";
import { largeMap } from "./mockLargeMap";

const plans = openPlanning("wayfinder");
void plans.feed.open("linux");
const page = computed(() => {
	plans.planning();
	const p = plans.feed.page("linux");
	return p ? largeMap(p as PlanPage) : null;
});
export const state = chartState();

mount(() => (
	<Scroll class="flex-1 bg-background">
		<View class="gap-3 p-6">
			<Text class="text-xs text-faint">Mock data</Text>
			<If when={page()}>{(p) => <ExpeditionChart plans={plans} page={p()} state={state} mode="inline" />}</If>
		</View>
	</Scroll>
));
