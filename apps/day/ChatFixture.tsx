// Headless control fixture only. No daemon, worker, provider or storage.
// New with a scripted chat source that follows the connected rules
// (chatDemo.ts): two invented projects, passive selection, one send per
// creation, Unknown until Check, and a save-and-reopen that restores only
// the words and the user's own choice.
import { mount, Scroll, Text, View } from "nsh";
import { PlanFeed } from "pilot-day/native";
import { DEMO_PROJECTS, ScriptedChats } from "./chatDemo";
import { mirrorChats } from "./chatFeed";
import { NewScreen } from "./NewScreen";
import { mirrorPlanning } from "./planning";
import { planRoute } from "./planView";
import { Action } from "./ui";
import { captureView, restoreView, startFresh } from "./updateView";

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
	<View class="flex-1 bg-background">
		<If when={planRoute()?.kind === "new"}>
			<View class="flex-1">
				<NewScreen plans={plans} />
			</View>
		</If>
		<Scroll class="max-h-56 border-t border-border">
			<View class="gap-1 px-6 py-3">
				<Text testID="counts">
					{`Selects: ${chats.counts().selects} · Sends: ${chats.counts().sends} · Checks: ${chats.counts().checks} · Chats: ${chats.counts().chats}`}
				</Text>
				<Text testID="started">{`Started: ${chats.counts().chats >= 0 ? startedLine() : ""}`}</Text>
				<View class="flex-row flex-wrap gap-1">
					<Action
						label="Profile-only window"
						onPress={() => {
							chats.current = null;
							chats.publish();
						}}
					/>
					<Action label="Lose next answer" onPress={() => (chats.script.loseNext = true)} />
					<Action label="Hold selections" onPress={() => (chats.script.holdSelects = true)} />
					<Action
						label="Release newer selection"
						onPress={() => {
							chats.script.holdSelects = false;
							chats.releaseSelect(true);
						}}
					/>
					<Action label="Release older selection" onPress={() => chats.releaseSelect(false)} />
					<Action label="Change website setup" onPress={() => changeSetup("demo-website")} />
					<Action
						label="Remove website"
						onPress={() => {
							chats.projects = chats.projects.filter((p) => p.projectId !== "demo-website");
							chats.publish();
						}}
					/>
					<Action
						label="Go offline"
						onPress={() => {
							chats.script.offline = true;
							chats.publish();
						}}
					/>
					<Action
						label="Save and reopen"
						onPress={() => {
							const view = captureView();
							startFresh();
							restoreView(view);
						}}
					/>
					<Action
						label="Reopen as an older save"
						onPress={() => {
							// A view saved before New recorded whether the user chose its project.
							const { chatChosen: _, ...view } = captureView();
							startFresh();
							restoreView(view);
						}}
					/>
					<Action label="Open New" onPress={() => planRoute.set({ kind: "new" })} />
				</View>
			</View>
		</Scroll>
	</View>
));
