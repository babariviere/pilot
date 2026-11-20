// Real Day views with bounded, fictional scope replies and the saved interview fixture.
import { keymap, mount, View } from "nsh";
import { type Planning, type PlanRow, TodayFeed } from "pilot-day/native";
import { mirrorDay } from "./app/day";
import { MockDayScreen, openPlanning } from "./app/testing/mockFeeds";
import { mirrorScope, type ScopeSource, todayProject } from "./today/todayScope";
import { Block, Caption, WindowCanvas } from "./ui";

const plans = openPlanning("interview");
const today = new TodayFeed("quiet");
const exportRow = plans.planning().plans.find((p) => p.missionId === "export")!;
const project = (id: string, name: string, rows: PlanRow[]) => ({ id, name, rows });
const interview = (id: string, title: string, pendingQuestions: number): PlanRow => ({
	...exportRow,
	missionId: id,
	title,
	stage: "questions",
	identity: { interviewId: `${id}-1`, interviewRevision: 1, planRevision: null },
	pendingQuestions,
});
const exportPlan = interview("export", "Export a chat as Markdown", 4);
const scope = (rows: PlanRow[], sites = true) => [
	project("demo-pilot", "Pilot project", rows),
	...(sites
		? [
				project("demo-website", "Website", [
					interview("search", "Faster search", 1),
					{ ...interview("review", "Publish newsletter", 2), stage: "review" },
				]),
			]
		: []),
];
let projects = scope([exportPlan, interview("import", "Import settings", 2)]);
let fail = false;
let denyWebsite = false;
let holdAll = false;
let hold: ((resume: () => void) => void) | null = null;
let release: (() => void) | undefined;
const source: ScopeSource = {
	async read(selected, generation) {
		const pending = hold;
		hold = null;
		const rows = projects;
		if (holdAll && selected === "all") await new Promise<void>(() => {});
		if (pending) await new Promise<void>(pending);
		if (fail) return { ok: false, refusal: "offline" };
		const count = (p: (typeof projects)[number]) => p.rows.filter((r) => r.stage === "questions").length;
		return {
			ok: true,
			snapshot: {
				version: 1,
				scope: selected,
				generation,
				own: "demo-pilot",
				catalogComplete: true,
				complete: true,
				outsideNeedsYou: {
					count: rows.filter((p) => selected !== "all" && p.id !== selected).reduce((n, p) => n + count(p), 0),
					complete: true,
				},
				projects: rows.map((p) => ({
					...p,
					planningRead: denyWebsite && p.id === "demo-website" ? "refused" : "read",
					selected: selected === "all" || p.id === selected,
					currentness: "live",
					needsYou: { count: count(p), complete: true },
					today: today.snapshot(),
					planning:
						denyWebsite && p.id === "demo-website"
							? null
							: ({ ...plans.planning(), availability: "live", plans: p.rows } satisfies Planning),
				})),
			},
		};
	},
};
const mirror = mirrorScope(source);
const day = mirrorDay(today, { scope: mirror });
const read = () => void mirror.read(todayProject());
const bind = (n: number, run: () => void) => keymap.bind(`mod+shift+${n}`, run, { when: "always" });
bind(1, read); // identical read
bind(2, () => {
	// saved draft, not submitted
	projects = scope([{ ...exportPlan, pendingQuestions: 3 }, interview("import", "Import settings", 2)]);
	read();
});
bind(3, () => {
	// complete draft or uncertain submission: there is still no confirmed submission
	projects = scope([{ ...exportPlan, pendingQuestions: 0 }]);
	read();
});
bind(4, () => {
	// confirmed submission
	projects = scope([{ ...exportPlan, stage: "submitted" }]);
	read();
});
bind(5, () => {
	// next round, and Website access lost
	projects = scope(
		[{ ...exportPlan, pendingQuestions: 2, identity: { ...exportPlan.identity!, interviewId: "export-2" } }],
		false,
	);
	read();
});
bind(6, () => {
	// retain a late earlier reply
	hold = (resume) => {
		release = resume;
	};
	read();
});
bind(7, () => release?.());
bind(8, () => {
	fail = !fail;
	read();
});
bind(9, () => {
	projects = scope([], false);
	read();
});
bind(0, () => {
	hold = (resume) => {
		release = resume;
	};
	mirror.invalidate();
	read();
});
keymap.bind(
	"mod+shift+d",
	() => {
		denyWebsite = true;
		holdAll = true;
		read();
	},
	{ when: "always" },
);

mount(() => (
	<WindowCanvas>
		<View class="min-h-0 flex-1">
			<MockDayScreen day={day} plans={plans} />
		</View>
		<Block>
			<Caption testID="sent">{`Today notes: ${day.today().notes.length}`}</Caption>
		</Block>
	</WindowCanvas>
));
