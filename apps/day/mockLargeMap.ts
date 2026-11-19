// Mock data: a large Wayfinder map, like a mission whose broad research was split
// into many narrow questions. Built from the mock Linux mission; every record is invented.
import type { Exploration, PlanPage } from "pilot-day/native";

const AREAS = [
	"Day navigation and outcome screens",
	"Mission planning and legacy missions",
	"Mission execution controls",
	"Feedback triage and fix workflow",
	"Native GUI update and close recovery",
	"Daemon ownership and update handoff",
	"Artifact capture and native preview",
	"Review, kept evidence and verification",
	"Workspace custody and retention",
	"GitHub integration and PR delivery",
	"Linear intake and sub-issues",
	"Slack intake and background triage",
	"Schedules, hooks and flows",
	"Insights integration",
	"Agent profiles, tools and context",
	"Models, MCP and usage policy",
	"Knowledge and preferences",
	"Secrets and credential safeguards",
	"Power, sleep and offline behavior",
	"Diagnostics, logs and telemetry",
	"Distribution, CLI and legacy boundaries",
];

/** The Linux mission's map with 21 research questions, two places that wait for all of them, and three interviews. */
export function largeMap(page: PlanPage): PlanPage {
	const base = page.explorations[0];
	const item = (id: string, title: string, over: Partial<Exploration>): Exploration => ({
		...base,
		id,
		title,
		question: `What is true about ${title.toLowerCase()}?`,
		after: [],
		by: "",
		result: "",
		sources: [],
		sourceRefs: [],
		fromFog: "",
		round: "",
		evidence: "",
		observations: [],
		unresolved: [],
		changed: [],
		findingsWaiting: false,
		...over,
	});
	const research = AREAS.map((title, i) =>
		item(`audit-${i}`, title, {
			kind: "research",
			state: i < 8 ? "running" : "ready",
			by: i < 8 ? "An agent is on it" : "",
			findingsWaiting: i >= 2 && i < 8,
		}),
	);
	const consolidate = (id: string, title: string) =>
		item(id, title, { kind: "research", state: "waiting", after: AREAS });
	return {
		...page,
		explorations: [
			...research,
			consolidate("features", "Consolidate feature and safeguard coverage"),
			consolidate("prior", "Consolidate coverage of all prior tasks"),
			item("safety", "Clarify acceptance without aggressive safety", {
				kind: "grilling",
				state: "resolved",
				result: "Answered in interview round 2",
			}),
			item("retention", "Choose what to keep from the full inventory", {
				kind: "grilling",
				state: "waiting",
				after: ["Consolidate feature and safeguard coverage", "Consolidate coverage of all prior tasks"],
			}),
			item("acceptance", "Agree native acceptance and test seams", {
				kind: "grilling",
				state: "waiting",
				after: ["Choose what to keep from the full inventory"],
			}),
		],
	};
}
