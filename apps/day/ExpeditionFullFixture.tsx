// Test fixture: the mock mission "Pilot on Linux desktops", its chart open
// full window from the start. Every record is invented mock data.
import { computed, mount, View } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { FullChart } from "./ExpeditionChart";
import { openPlanning } from "./mockFeeds";
import { Caption, WindowCanvas } from "./ui";

const plans = openPlanning("wayfinder");
void plans.feed.open("linux");
const page = computed(() => {
	plans.planning();
	return plans.feed.page("linux") ?? null;
});

mount(() => (
	<WindowCanvas>
		<If when={page()}>{(p) => <FullChart plans={plans} page={p() as PlanPage} onClose={() => {}} />}</If>
		<View class="absolute bottom-1 left-6">
			<Caption tone="faint">Mock data</Caption>
		</View>
	</WindowCanvas>
));
