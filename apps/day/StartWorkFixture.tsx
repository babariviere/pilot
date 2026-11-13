// Headless control fixture only. No daemon, worker, provider or storage.
import { mount, signal, Text, View } from "nsh";
import { openPlanning } from "./mockFeeds";
import { StartWork } from "./PlanScreen";
import { Action } from "./ui";

const plans = openPlanning("review");
const source = plans.feed;
const original = source.page(source.snapshot().plans[0].missionId)!;
const page = signal({
	...original,
	interview: null,
	work: {
		canStart: true,
		canCheck: false,
		revision: 4,
		digest: "published",
		taskId: "first-task",
		title: "Check importer",
		model: "faux/faux-1",
		project: "Offline fixture",
		access: "build",
		thinking: "off",
		context: "exact-context",
		line: "",
	},
});
const sends = signal(0),
	checks = signal(0),
	lost = signal(false);
plans.feed = {
	snapshot: () => source.snapshot(),
	onChange: (cb) => source.onChange(cb),
	page: () => page(),
	open: (id) => source.open(id),
	plan: (i) => source.plan(i),
	start: (i) => source.start(i),
	saveAnswer: (i) => source.saveAnswer(i),
	submit: (i) => source.submit(i),
	checkSubmit: (i) => source.checkSubmit(i),
	dispose: () => source.dispose(),
	startWork: async (_mission, shown) => {
		if (
			shown.context !== "exact-context" ||
			shown.revision !== 4 ||
			shown.digest !== "published" ||
			shown.taskId !== "first-task"
		)
			throw new Error("Wrong identity");
		sends.set(sends() + 1);
		page.set({ ...page(), work: { ...page().work, canStart: false, canCheck: lost() } });
		return {
			status: lost() ? "unknown" : "accepted",
			revision: 1,
			missionId: original.missionId,
			message: lost() ? "Start is not confirmed." : "One background task admitted.",
		};
	},
	checkWork: async () => {
		checks.set(checks() + 1);
		page.set({ ...page(), work: { ...page().work, canCheck: false } });
		return {
			status: "accepted",
			revision: 2,
			missionId: original.missionId,
			message: "Exact receipt found. Nothing resent.",
		};
	},
};
mount(() => (
	<View class="flex-1 gap-4 bg-background p-8">
		<StartWork plans={plans} page={page()} />
		<Text>{`Sends: ${sends()} · Checks: ${checks()}`}</Text>
		<Action
			label="Change plan"
			onPress={() => page.set({ ...page(), work: { ...page().work, context: "changed" } })}
		/>
		<Action label="Lose acknowledgement" onPress={() => lost.set(true)} />
	</View>
));
