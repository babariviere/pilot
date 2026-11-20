import { mount, signal } from "nsh";
import { findingGoal, openFindingDraft, restoreOtherDraft } from "./insights/insightsWork";
import { goalDraft } from "./missions/planning/planView";
import { Block, Body, Button, Buttons, Field, WindowCanvas } from "./ui";

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
mount(() => (
	<WindowCanvas>
		<Block gap={3}>
			<Field label="Goal" testID="insights-work-goal" value={goalDraft()} onChange={(v) => goalDraft.set(v)} />
			<Buttons>
				<Button label="Open finding draft" onPress={() => openFindingDraft("plan", finding, true)} />
				<Button label="Prepare work request" onPress={() => sent.set(findingGoal(goalDraft(), "plan"))} />
				<Button label="Discard finding draft" onPress={() => restoreOtherDraft()} />
			</Buttons>
			<Body testID="finding-work-request">{sent()}</Body>
		</Block>
	</WindowCanvas>
));
