// Test-only: one mission interview over the injected native host channel
// (bridge.ts), and the flush a close runs. The test scripts every root reply.
import { mount, signal, View } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { ConnectedPlans } from "./bridge";
import { ScriptedChats } from "./chatDemo";
import { mirrorChats } from "./chatFeed";
import { InterviewDoc } from "./InterviewDoc";
import { flushAll } from "./planCommands";
import { mirrorPlanning } from "./planning";
import { Action } from "./ui";

const plans = mirrorPlanning(new ConnectedPlans("fixture", null), mirrorChats(new ScriptedChats()));
const page = signal<PlanPage | null>(null);
plans.feed.onChange(() => page.set(plans.feed.page("export")));
void plans.feed.open("export");
const interview = () => page()?.interview;
mount(() => (
	<View class="gap-2 p-4">
		<Action label="Close window" onPress={() => void flushAll(plans)} />
		<If when={interview()}>
			<Each of={interview() ? [interview() as NonNullable<PlanPage["interview"]>] : []} key={(iv) => iv.id}>
				{(iv) => <InterviewDoc plans={plans} page={page() as PlanPage} interview={iv()} />}
			</Each>
		</If>
	</View>
));
