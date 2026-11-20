// Headless control fixture only. New with invented projects, one mission in
// planning, two plans whose tasks exist (one Today knows, one it does not)
// and a switch that turns mission planning off. No daemon, worker, provider
// or storage.
import { mount, View } from "nsh";
import { PlanFeed, type Planning, type PlanRow } from "pilot-day/native";
import { openDay } from "./app/testing/mockFeeds";
import { NewScreen } from "./missions/intake/NewScreen";
import { mirrorPlanning } from "./missions/planning/planning";
import { planRoute } from "./missions/planning/planView";
import { stateWord } from "./missions/words";
import { DEMO_PROJECTS, ScriptedChats } from "./sessions/chatDemo";
import { mirrorChats } from "./sessions/chatFeed";
import type { PlanningFeed } from "./sources/feeds";
import { Button, Buttons, Caption, WindowCanvas } from "./ui";

let planningOff = false;
const source = new PlanFeed("interview");
const day = openDay();
const known = day.today().moving[0] ?? day.today().notMoving[0];

function shape(p: Planning): Planning {
	const first = p.plans[0];
	const withTasks = (missionId: string, title: string): PlanRow[] =>
		first
			? [
					{
						...first,
						missionId,
						title,
						stage: "published",
						line: "Published as tasks. Work admission is separate",
						needsYou: false,
						pendingQuestions: undefined,
					},
				]
			: [];
	return {
		...p,
		plans: [
			...p.plans.slice(0, 1),
			...(known ? withTasks(known.id, "Known mission") : []),
			...withTasks("published-search", "Search past chats"),
		],
		canCreate: planningOff ? false : p.canCreate,
		createReason: planningOff
			? "Mission planning is not configured for this project. Nothing was sent."
			: p.createReason,
	};
}

// Snapshots go through `shape`; every other feed call goes to the mock feed unchanged.
const feed = new Proxy(source, {
	get(target, key) {
		if (key === "snapshot") return () => shape(target.snapshot());
		if (key === "onChange") return (listener: (p: Planning) => void) => target.onChange((p) => listener(shape(p)));
		const value = Reflect.get(target, key);
		return typeof value === "function" ? value.bind(target) : value;
	},
}) as unknown as PlanningFeed;

const chats = new ScriptedChats(DEMO_PROJECTS, null);
const plans = mirrorPlanning(feed, mirrorChats(chats));
planRoute.set({ kind: "new" });

mount(() => (
	<WindowCanvas>
		<If when={planRoute()?.kind === "new"}>
			<View class="flex-1">
				<NewScreen plans={plans} day={day} />
			</View>
		</If>
		<Caption>{`Today's state: ${known ? stateWord(known) : "none"}`}</Caption>
		<Buttons>
			<Button
				label="Turn planning off"
				onPress={() => {
					planningOff = true;
					plans.planning.set(feed.snapshot());
				}}
			/>
		</Buttons>
	</WindowCanvas>
));
