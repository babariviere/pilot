import { type JSX, mount, signal, View } from "nsh";
import { findingGoal, openFindingDraft, restoreOtherDraft } from "./insightsWork";
import { goalDraft } from "./planView";
import { Block, Body, Button, Buttons, Field, GridBackdrop } from "./ui";

const sent = signal("");
goalDraft.set("Keep my unrelated draft");
const finding = {
	key: "repeated-checks",
	revision: 3,
	title: "Repeated checks",
	updatedAt: 1,
	proposal: "Remember check results",
	projectId: "fixture",
	evidence: [{ sessionId: "source-fixture", label: "Release evidence", excerpt: "Private fixture excerpt" }],
};
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
		<Block gap={3}>
			<Field label="Goal" testID="insights-work-goal" value={goalDraft()} onChange={(v) => goalDraft.set(v)} />
			<Buttons>
				<Button label="Open finding draft" onPress={() => openFindingDraft("plan", finding, true)} />
				<Button label="Prepare work request" onPress={() => sent.set(findingGoal(goalDraft(), "plan"))} />
				<Button label="Discard finding draft" onPress={() => restoreOtherDraft()} />
			</Buttons>
			<Body testID="finding-work-request">{sent()}</Body>
		</Block>
	</FixtureWindow>
));
