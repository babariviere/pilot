// Test fixture: the large mock map's chart, open full window from the start. Mock data.
import { computed, mount, Text, View } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { FullChart } from "./ExpeditionChart";
import { openPlanning } from "./mockFeeds";
import { largeMap } from "./mockLargeMap";

const plans = openPlanning("wayfinder");
void plans.feed.open("linux");
const page = computed(() => {
	plans.planning();
	const p = plans.feed.page("linux");
	return p ? largeMap(p as PlanPage) : null;
});

mount(() => (
	<View class="flex-1 bg-background">
		<If when={page()}>{(p) => <FullChart plans={plans} page={p()} onClose={() => {}} />}</If>
		<View class="absolute bottom-1 left-6">
			<Text class="text-xs text-faint">Mock data</Text>
		</View>
	</View>
));
