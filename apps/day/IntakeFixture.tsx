// Headless control fixture only. No daemon, worker, provider or storage.
// Today with nothing else waiting and a scripted request source
// (intakeDemo.ts): new Slack requests queue in Needs you as cards; the
// Linear request is counted on the Linear row only.
import { mount, Text, View } from "nsh";
import { intakeCounts, intakeOpened, intakeScript, scriptedIntake } from "./intakeDemo";
import { mirrorIntake } from "./intakeFeed";
import { mockRituals, openDay } from "./mockFeeds";
import { goalDraft, linkedMission, planRoute, requestDraft } from "./planView";
import { TodayScreen } from "./TodayScreen";
import { Action } from "./ui";

const day = { ...openDay("quiet"), intake: mirrorIntake(scriptedIntake) };
void scriptedIntake.read();

mount(() => (
	<View class="flex-1">
		<TodayScreen day={day} rituals={mockRituals(day)} />
		<View class="gap-1 border-t border-border px-6 py-2">
			<Text testID="counts">{`Sends: ${intakeCounts().sends} · Checks: ${intakeCounts().checks}`}</Text>
			<Text>{`Reads: ${intakeCounts().reads}`}</Text>
			<Text testID="opened">{`Opened: [${intakeOpened().join(", ")}]`}</Text>
			<Text testID="plan-draft">{`New: ${planRoute()?.kind ?? "closed"} · ${goalDraft().split("\n")[0]} · request ${requestDraft()?.itemId ?? "none"}@${requestDraft()?.revision ?? 0}`}</Text>
			<View class="flex-row flex-wrap gap-1">
				<Action label="Lose next answer" onPress={intakeScript.loseNext} />
				<Action
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
				<Action label="Hold answers" onPress={intakeScript.hold} />
				<Action label="Release answer" onPress={intakeScript.release} />
				<Action label="Change on send" onPress={intakeScript.changeOnSend} />
				<Action label="Change first request" onPress={intakeScript.changeFirst} />
				<Action label="Change project" onPress={intakeScript.changeProject} />
				<Action label="Source trouble" onPress={intakeScript.trouble} />
				<Action label="Unreadable" onPress={() => intakeScript.unreadable("offline")} />
				<Action label="Readable" onPress={intakeScript.readable} />
				<Action label="Access denied" onPress={() => intakeScript.unreadable("denied")} />
				<Action label="Service unavailable" onPress={() => intakeScript.unreadable("unavailable")} />
			</View>
		</View>
	</View>
));
