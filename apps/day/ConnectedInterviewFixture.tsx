// Test-only: one mission interview over the injected native host channel
// (bridge.ts), and the flush a close runs. The test scripts every root reply.
import { type JSX, mount, signal, View } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { ConnectedPlans } from "./bridge";
import { ScriptedChats } from "./chatDemo";
import { mirrorChats } from "./chatFeed";
import { InterviewDoc } from "./InterviewDoc";
import { flushAll } from "./planCommands";
import { mirrorPlanning } from "./planning";
import { Block, Button, Buttons, Column, GridBackdrop, Page, Panel, Section } from "./ui";

const plans = mirrorPlanning(new ConnectedPlans("fixture", null), mirrorChats(new ScriptedChats()));
const page = signal<PlanPage | null>(null);
plans.feed.onChange(() => page.set(plans.feed.page("export")));
void plans.feed.open("export");
const interview = () => page()?.interview;
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
	</FixtureWindow>
));
