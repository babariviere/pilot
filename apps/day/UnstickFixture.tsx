// Headless fixture only: a stuck mock mission whose saved answers belong to an earlier wording,
// with Unstick's repair agent. Mock data.
import { mount, signal, Text, View } from "nsh";
import type { PlanPage } from "pilot-day/native";
import { openPlanning } from "./mockFeeds";
import { Unstick } from "./Unstick";
import { Action } from "./ui";

type Repair = NonNullable<NonNullable<PlanPage["unstick"]>["repair"]>;

const plans = openPlanning("wayfinder");
const source = plans.feed;
await source.open("linux");
const page = signal<PlanPage>({
	...(source.page("linux") as PlanPage),
	unstick: {
		state: "stuck",
		line: "Some saved answers belong to an earlier wording of their question, so new answers cannot be saved.",
		fix: "dropEarlierAnswers",
		checks: ["Planning agent: idle", "Questions: 13, saved answers: 7, 7 to an earlier wording"],
		repair: { available: true, state: "none", chatId: "", proposal: null, reason: "", current: false },
	},
});
const applied = signal(0);
const sentNote = signal("");
const repair = (change: Partial<Repair>) => {
	const u = page().unstick!;
	page.set({ ...page(), unstick: { ...u, repair: { ...u.repair!, ...change } } });
};
const accepted = (missionId: string, message: string) => ({
	status: "accepted" as const,
	revision: 1,
	missionId,
	message,
});
plans.feed = Object.assign(Object.create(Object.getPrototypeOf(source)), source, {
	page: () => page(),
	// Methods, as the connected feed's: called unbound, they would throw.
	async dropEarlierAnswers(this: unknown, intent: { missionId: string }) {
		if (this !== plans.feed) throw new Error("dropEarlierAnswers called without its feed");
		applied.set(applied() + 1);
		page.set({
			...page(),
			unstick: { state: "waiting", line: "Pilot waits for your answers to this round.", fix: "none", checks: [] },
		});
		return accepted(intent.missionId, "Removed. Answer those questions again.");
	},
	async repairStart(this: unknown, intent: { missionId: string }) {
		if (this !== plans.feed) throw new Error("repairStart called without its feed");
		repair({ available: false, state: "looking", chatId: "repair-1" });
		return accepted(intent.missionId, "An agent is looking. Its fix shows here.");
	},
	async repairApply(this: unknown, intent: { missionId: string; note: string }) {
		if (this !== plans.feed) throw new Error("repairApply called without its feed");
		sentNote.set(intent.note || "(agent's note)");
		return accepted(intent.missionId, "Sent. Pilot continues planning with this note.");
	},
});
mount(() => (
	<View class="flex-1 gap-4 bg-background p-8">
		<Unstick plans={plans} page={page()} />
		<Text testID="applied">{`Applied: ${applied()}`}</Text>
		<Text testID="sent-note">{`Note: ${sentNote()}`}</Text>
		<Action
			testID="agent-done"
			label="Agent done"
			onPress={() =>
				repair({
					available: true,
					state: "proposed",
					current: true,
					proposal: {
						fix: "plannerNote",
						cause: "The map is full: Pilot refused a save with 42 questions.",
						note: "Merge open research questions a and b.",
						certainty: "high",
						evidence: ["plan-map refused: Invalid planning list"],
					},
				})
			}
		/>
	</View>
));
