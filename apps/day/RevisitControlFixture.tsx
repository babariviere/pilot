// Production Revisit views with a canonical selective-checkpoint-shaped mock read.
import { mount } from "nsh";
import type { PlanningFeed } from "./feeds";
import { MockDayScreen, openDay, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("revisit");
const base = plans.feed;
const feed: PlanningFeed = {
	snapshot: () => base.snapshot(),
	onChange: (cb) => base.onChange(cb),
	page(id) {
		const page = base.page(id);
		if (!page?.revisit?.revision) return page;
		return {
			...page,
			revisit: {
				...page.revisit,
				revision: {
					...page.revisit.revision,
					selectivePause: true,
					affectedWork: 2,
					affectedTasks: ["#5 Follow macOS Focus for quiet hours", "#7 Remove email digest"],
					pause: "needed",
				},
			},
		};
	},
	open: (id) => base.open(id),
	plan: (r) => base.plan(r),
	start: (r) => base.start(r),
	saveAnswer: (r) => base.saveAnswer(r),
	submit: (r) => base.submit(r),
	checkSubmit: (r) => base.checkSubmit(r),
	revisit: base.revisit?.bind(base),
	confirmRevision: base.confirmRevision?.bind(base),
	checkRevision: base.checkRevision?.bind(base),
	dispose: () => base.dispose(),
};
mount(() => <MockDayScreen day={day} plans={{ ...plans, feed }} />);
