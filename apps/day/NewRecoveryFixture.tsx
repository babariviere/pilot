// Isolated fixture: unknown receipts and a new draft, never real creation.
import { mount, Text, View } from "nsh";
import type { PlanOutcome } from "pilot-day/native";
import type { PlanningFeed } from "./feeds";
import { openPlanning } from "./mockFeeds";
import { NewScreen } from "./NewScreen";
import { goalDraft } from "./planView";

const plans = openPlanning("fresh");
const original = plans.feed;
const project = "demo-pilot";
plans.planning.update((p) => ({
	...p,
	setup: {
		...p.setup,
		unconfirmed: true,
		creations: [{ operationId: "original-receipt", goal: "Export a chat", projectId: project }],
	},
}));
goalDraft.set("Export a chat");
const result = (message: string): PlanOutcome => ({ status: "unknown", revision: 0, message, missionId: null });
const feed: PlanningFeed = {
	snapshot: () => plans.planning(),
	onChange: (cb) => original.onChange(cb),
	page: (id) => original.page(id),
	open: (id) => original.open(id),
	start: (intent) => original.start(intent),
	saveAnswer: (intent) => original.saveAnswer(intent),
	submit: (intent) => original.submit(intent),
	checkSubmit: (intent) => original.checkSubmit(intent),
	dispose: () => original.dispose(),
	canCheckNew: () => true,
	checkNew: async (id) => result(`Checked ${id}. No creation sent.`),
	plan: async (intent) =>
		result(
			intent.createAnother
				? "Separate request chosen. Original receipt kept."
				: "Different goal can be planned independently.",
		),
};
mount(() => (
	<View class="flex-1">
		<Text>Mock data · New recovery</Text>
		<NewScreen plans={{ ...plans, feed }} />
	</View>
));
