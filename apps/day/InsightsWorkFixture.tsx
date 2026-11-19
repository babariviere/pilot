import { mount, signal, Text, View } from "nsh";
import { findingGoal, openFindingDraft, restoreOtherDraft } from "./insightsWork";
import { goalDraft } from "./planView";
import { Action, Field } from "./ui";

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
	<View class="gap-3 p-6">
		<Field label="Goal" testID="insights-work-goal" value={goalDraft()} onChange={(v) => goalDraft.set(v)} />
		<Action label="Open finding draft" onPress={() => openFindingDraft("plan", finding, true)} />
		<Action label="Prepare work request" onPress={() => sent.set(findingGoal(goalDraft(), "plan"))} />
		<Action label="Discard finding draft" onPress={() => restoreOtherDraft()} />
		<Text testID="finding-work-request">{sent()}</Text>
	</View>
));
