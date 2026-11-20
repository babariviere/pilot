// Headless control fixture only. No daemon, worker, provider or storage.
// Today with nothing else waiting and a scripted request source
// (intakeDemo.ts): new Slack requests queue in Needs you as cards; the
// Linear request is counted on the Linear row only.
import { mount, View } from "nsh";
import { intakeCounts, intakeOpened, intakeScript, scriptedIntake } from "./intakeDemo";
import { mirrorIntake } from "./intakeFeed";
import { mockRituals, openDay } from "./mockFeeds";
import { goalDraft, linkedMission, planRoute, requestDraft } from "./planView";
import { TodayScreen } from "./TodayScreen";
import { Block, Button, Buttons, Caption, WindowCanvas } from "./ui";

const day = { ...openDay("quiet"), intake: mirrorIntake(scriptedIntake) };
void scriptedIntake.read();

mount(() => (
	<WindowCanvas>
		<View class="min-h-0 flex-1">
			<TodayScreen day={day} rituals={mockRituals(day)} />
		</View>
		<Block gap={1}>
			<Caption testID="counts">{`Sends: ${intakeCounts().sends} · Checks: ${intakeCounts().checks}`}</Caption>
			<Caption>{`Reads: ${intakeCounts().reads}`}</Caption>
			<Caption testID="opened">{`Opened: [${intakeOpened().join(", ")}]`}</Caption>
			<Caption testID="plan-draft">{`New: ${planRoute()?.kind ?? "closed"} · ${goalDraft().split("\n")[0]} · request ${requestDraft()?.itemId ?? "none"}@${requestDraft()?.revision ?? 0}`}</Caption>
			<Buttons>
				<Button small label="Lose next answer" onPress={intakeScript.loseNext} />
				<Button
					small
					label="Hold a linked draft"
					onPress={() => {
						goalDraft.set("Linked words");
						linkedMission.set({
							feedbackId: "feedback-1",
							triageSessionId: "triage-1",
							proposalDigest: "d".repeat(64),
							title: "Feedback",
							projectId: "demo-pilot",
							replace: false,
							drafted: "Linked words",
							other: { goal: "Hidden words", pick: null, replaces: null, request: null, funding: null },
						});
					}}
				/>
				<Button small label="Hold answers" onPress={intakeScript.hold} />
				<Button small label="Release answer" onPress={intakeScript.release} />
				<Button small label="Change on send" onPress={intakeScript.changeOnSend} />
				<Button small label="Change first request" onPress={intakeScript.changeFirst} />
				<Button small label="Change project" onPress={intakeScript.changeProject} />
				<Button small label="Source trouble" onPress={intakeScript.trouble} />
				<Button small label="Unreadable" onPress={() => intakeScript.unreadable("offline")} />
				<Button small label="Readable" onPress={intakeScript.readable} />
				<Button small label="Access denied" onPress={() => intakeScript.unreadable("denied")} />
				<Button small label="Service unavailable" onPress={() => intakeScript.unreadable("unavailable")} />
			</Buttons>
		</Block>
	</WindowCanvas>
));
