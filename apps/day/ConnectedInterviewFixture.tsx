// Test-only: one mission interview over the injected native host channel
// (bridge.ts), and the flush a close runs. The test scripts every root reply.
import { mount, signal } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { InterviewDoc } from "./missions/interviews/InterviewDoc";
import { flushAll } from "./missions/planning/planCommands";
import { ConnectedPlans } from "./missions/planning/planFeed";
import { mirrorPlanning } from "./missions/planning/planning";
import { ScriptedChats } from "./sessions/chatDemo";
import { mirrorChats } from "./sessions/chatFeed";
import { Block, Button, Buttons, Column, Page, Panel, Section, WindowCanvas } from "./ui";

const plans = mirrorPlanning(new ConnectedPlans("fixture", null), mirrorChats(new ScriptedChats()));
const page = signal<PlanPage | null>(null);
plans.feed.onChange(() => page.set(plans.feed.page("export")));
void plans.feed.open("export");
const interview = () => page()?.interview;
mount(() => (
	<WindowCanvas>
		<Block>
			<Buttons>
				<Button label="Close window" onPress={() => void flushAll(plans)} />
			</Buttons>
		</Block>
		<If when={interview()}>
			<Page>
				<Panel>
					<Column>
						<Section title="Questions">
							<Each
								of={interview() ? [interview() as NonNullable<PlanPage["interview"]>] : []}
								key={(iv) => iv.id}
							>
								{(iv) => <InterviewDoc plans={plans} page={page() as PlanPage} interview={iv()} />}
							</Each>
						</Section>
					</Column>
				</Panel>
			</Page>
		</If>
	</WindowCanvas>
));
