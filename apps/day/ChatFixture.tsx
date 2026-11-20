// Headless control fixture only. No daemon, worker, provider or storage.
// New with a scripted chat source that follows the connected rules
// (chatDemo.ts): two invented projects, passive selection, one send per
// creation, Unknown until Check, and a save-and-reopen that restores only
// the words and the user's own choice.
import { mount, Scroll, View } from "nsh";
import { PlanFeed } from "pilot-day/native";
import { captureView, restoreView, startFresh } from "./app/windowState";
import { NewScreen } from "./missions/intake/NewScreen";
import { mirrorPlanning } from "./missions/planning/planning";
import { planRoute } from "./missions/planning/planView";
import { DEMO_PROJECTS, ScriptedChats } from "./sessions/chatDemo";
import { mirrorChats } from "./sessions/chatFeed";
import { Block, Button, Buttons, Caption, WindowCanvas } from "./ui";

const chats = new ScriptedChats(DEMO_PROJECTS, DEMO_PROJECTS[0].projectId);
const plans = mirrorPlanning(new PlanFeed("fresh"), mirrorChats(chats));
planRoute.set({ kind: "new" });

function changeSetup(projectId: string) {
	const project = chats.projects.find((p) => p.projectId === projectId);
	if (project) project.contextDigest = project.contextDigest.startsWith("c") ? "d".repeat(64) : "c".repeat(64);
	chats.publish();
}

function startedLine(): string {
	return [...chats.started.values()].map((c) => `${c.projectId} ${c.mode} [${c.message}]`).join(" | ");
}

mount(() => (
	<WindowCanvas>
		<If when={planRoute()?.kind === "new"}>
			<View class="flex-1">
				<NewScreen plans={plans} />
			</View>
		</If>
		<Scroll class="max-h-56">
			<Block gap={1}>
				<Caption testID="counts">
					{`Selects: ${chats.counts().selects} · Sends: ${chats.counts().sends} · Checks: ${chats.counts().checks} · Chats: ${chats.counts().chats}`}
				</Caption>
				<Caption testID="started">{`Started: ${chats.counts().chats >= 0 ? startedLine() : ""}`}</Caption>
				<Caption>{`Allowances: ${chats.counts().chats >= 0 ? [...chats.started.values()].map((c) => c.allowanceMicros).join(",") : ""}`}</Caption>
				<Buttons>
					<Button
						label="Profile-only window"
						onPress={() => {
							chats.current = null;
							chats.publish();
						}}
					/>
					<Button label="Lose next answer" onPress={() => (chats.script.loseNext = true)} />
					<Button label="Require allowance" onPress={() => (chats.script.fundingDefault = 5_000_000)} />
					<Button label="Hold selections" onPress={() => (chats.script.holdSelects = true)} />
					<Button
						label="Release newer selection"
						onPress={() => {
							chats.script.holdSelects = false;
							chats.releaseSelect(true);
						}}
					/>
					<Button label="Release older selection" onPress={() => chats.releaseSelect(false)} />
					<Button label="Change website setup" onPress={() => changeSetup("demo-website")} />
					<Button
						label="Remove website"
						onPress={() => {
							chats.projects = chats.projects.filter((p) => p.projectId !== "demo-website");
							chats.publish();
						}}
					/>
					<Button
						label="Go offline"
						onPress={() => {
							chats.script.offline = true;
							chats.publish();
						}}
					/>
					<Button
						label="Save and reopen"
						onPress={() => {
							const view = captureView();
							startFresh();
							restoreView(view);
						}}
					/>
					<Button
						label="Reopen as an older save"
						onPress={() => {
							// A view saved before New recorded whether the user chose its project.
							const { chatChosen: _, ...view } = captureView();
							startFresh();
							restoreView(view);
						}}
					/>
					<Button label="Open New" onPress={() => planRoute.set({ kind: "new" })} />
				</Buttons>
			</Block>
		</Scroll>
	</WindowCanvas>
));
