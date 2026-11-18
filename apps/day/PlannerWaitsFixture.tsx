// Headless fixture only, mock data. A planning agent that ended its turn with
// a request in prose: the plan page shows its last words, a reply field,
// Reply and Continue; Today's planning row shows them with a way there.
// Reads arrive by shortcut, so the focused field keeps the focus.
import { keymap, mount, Scroll, signal, Text, View } from "nsh";
import type { PlanPage, PlanRow } from "pilot-day/native";
import { MockDayScreen, openDay, openPlanning } from "./mockFeeds";
import { PlannerWaits } from "./Unstick";
import { Action } from "./ui";

const SAYS = "Which database should the export use? Tell me and I will go on.";
const plans = openPlanning("wayfinder");
const source = plans.feed;
await source.open("linux");
const stuck = {
	state: "stuck" as const,
	line: "Pilot's planning agent ended its turn while the plan is still open. It may be waiting for your reply.",
	fix: "continue" as const,
	checks: ["Planning agent: idle, last turn done"],
	repair: null,
	reply: true,
	plannerSays: SAYS,
};
const page = signal<PlanPage>({
	...(source.page("linux") as PlanPage),
	fresh: true,
	canContinue: true,
	unstick: stuck,
});
const sent = signal<string[]>([]);
plans.feed = Object.assign(Object.create(Object.getPrototypeOf(source)), source, {
	page: () => page(),
	// A method, as the connected feed's: called unbound, it would throw.
	async continuePlanning(this: unknown, intent: { missionId: string; feedback: string; note?: string }) {
		if (this !== plans.feed) throw new Error("continuePlanning called without its feed");
		sent.update((s) => [...s, intent.note ? `note: ${intent.note}` : "continue"]);
		page.set({
			...page(),
			canContinue: false,
			unstick: { ...stuck, state: "moving", reply: false, plannerSays: "" },
		});
		return {
			status: "accepted" as const,
			revision: 1,
			missionId: intent.missionId,
			message: intent.note ? "Sent. Pilot continues planning with this note." : "Pilot continues planning.",
		};
	},
});
// The same page read again, as a background read delivers it.
keymap.bind("mod+shift+1", () => page.set({ ...page() }), { when: "always" });

const row: PlanRow = {
	missionId: "stuck-mission",
	title: "Export the audit log",
	stage: "planning",
	line: stuck.line,
	needsYou: true,
	plannerSays: SAYS,
	reply: true,
	identity: null,
};
// Today reads the list from its own unchanged feed, as the window does.
const todayPlans = openPlanning("wayfinder");
todayPlans.planning.update((p) => ({ ...p, plans: [row, ...p.plans] }));
const day = openDay();
const showToday = signal(false);

mount(() => (
	<View class="flex-1 bg-background">
		<If
			when={showToday()}
			else={
				<Scroll class="flex-1">
					<View class="gap-4 p-8">
						<PlannerWaits plans={plans} page={page()} />
					</View>
				</Scroll>
			}
		>
			<MockDayScreen day={day} plans={todayPlans} />
		</If>
		<View class="flex-row gap-2 border-t border-border px-6 py-2">
			<Text testID="sent">{`Sent: ${sent().join(", ") || "nothing"}`}</Text>
			<Action label="Show Today" onPress={() => showToday.set(true)} />
		</View>
	</View>
));
