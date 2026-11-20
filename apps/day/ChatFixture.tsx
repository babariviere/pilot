// Headless control fixture only. No daemon, worker, provider or storage.
// New with a scripted chat source that follows the connected rules
// (chatDemo.ts): two invented projects, passive selection, one send per
// creation, Unknown until Check, and a save-and-reopen that restores only
// the words and the user's own choice.
import { type JSX, mount, Scroll, View } from "nsh";
import { PlanFeed } from "pilot-day/native";
import { DEMO_PROJECTS, ScriptedChats } from "./chatDemo";
import { mirrorChats } from "./chatFeed";
import { NewScreen } from "./NewScreen";
import { mirrorPlanning } from "./planning";
import { planRoute } from "./planView";
import { Block, Button, Buttons, Caption, GridBackdrop } from "./ui";
import { captureView, restoreView, startFresh } from "./windowState";

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
	</FixtureWindow>
));
