// Test fixture only: the mock mission "search" with a long published plan whose
// first task can start. Mock data; nothing here reads or sends anything real.
import { mount } from "nsh";
import type { PlanPage } from "pilot-day/native";
import type { PlanningFeed } from "./feeds";
import { MockDayScreen, openDay, openPlanning } from "./mockFeeds";
import { openMission } from "./view";

const day = openDay();
const plans = openPlanning("review");
const source = plans.feed;
const review = source.page(source.snapshot().plans[0].missionId) as PlanPage;
const ready: PlanPage = {
	...review,
	missionId: "search",
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
};
// Start only answers; every other feed call goes to the mock feed unchanged.
plans.feed = new Proxy(source, {
	get(target, key) {
		if (key === "page") return (id: string) => (id === "search" ? ready : target.page(id));
		if (key === "startWork")
			return async () => ({
				status: "accepted",
				revision: 1,
				missionId: "search",
				message: "Fixture: nothing started.",
			});
		const value = Reflect.get(target, key);
		return typeof value === "function" ? value.bind(target) : value;
	},
}) as PlanningFeed;

openMission("search");
mount(() => <MockDayScreen day={day} plans={plans} />);
