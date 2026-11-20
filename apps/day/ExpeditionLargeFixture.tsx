// Test fixture: the mock Linux mission with a large map (many split research questions),
// as the still chart on the planning page shows it. Every record is invented mock data.
import { computed, mount, Scroll } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { openPlanning } from "./app/testing/mockFeeds";
import { largeMap } from "./app/testing/mockLargeMap";
import { chartState, ExpeditionChart } from "./missions/planning/ExpeditionChart";
import { Block, Caption, WindowCanvas } from "./ui";

const plans = openPlanning("wayfinder");
void plans.feed.open("linux");
const page = computed(() => {
	plans.planning();
	const p = plans.feed.page("linux");
	return p ? largeMap(p as PlanPage) : null;
});
export const state = chartState();

mount(() => (
	<WindowCanvas>
		<Scroll class="flex-1">
			<Block gap={3}>
				<Caption tone="faint">Mock data</Caption>
				<If when={page()}>{(p) => <ExpeditionChart plans={plans} page={p()} state={state} mode="inline" />}</If>
			</Block>
		</Scroll>
	</WindowCanvas>
));
