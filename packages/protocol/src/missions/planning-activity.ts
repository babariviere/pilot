/** What the planning coordinator does now and a compact view of its chat, for the native planning page.
 * Data only: clients word it. Nothing here is progress, acceptance or permission.
 */

/** One tool step of the planning coordinator. */
export interface PlanningStep {
	/** The tool's name, such as "read" or "mission_plan". */
	tool: string;
	/** True while the step has no saved result. Older chat pages report false. */
	running: boolean;
	/** True when its saved result is an error. */
	failed: boolean;
	/** The tool's own action argument, such as "plan-map". At most 80 characters. */
	action?: string;
	/** A short target: a project-relative path, a search pattern, a query or a URL. At most 200 characters. */
	target?: string;
}

/** The coordinator's live run, from the daemon's memory and the newest saved history. */
export interface PlanningActivity {
	sessionId: string;
	working: boolean;
	/** Epoch ms when this daemon saw the current run start. Null when unknown or idle. */
	workingSince: number | null;
	/** Epoch ms of the newest saved message or tool progress. Null when unknown. */
	lastStepAt: number | null;
	/** The newest tool step of the current run. Null when idle or when the newest message has no tool step. */
	step: PlanningStep | null;
}

/** One row of the planning chat. Text is limited; long text says so. */
export type PlanningChatRow = { key: string; entryId: number } & (
	| { role: "you" | "pilot"; text: string; shortened: boolean }
	/** Pilot's own planning request (answers passed on, a continuation or a Revisit). */
	| { role: "request" }
	| { role: "step"; step: PlanningStep }
);

/** GET /api/projects/:projectId/missions/:missionId/planning/history?before=N&limit=N */
export interface PlanningChatPage {
	version: 1;
	missionId: string;
	sessionId: string;
	/** Oldest first. */
	rows: PlanningChatRow[];
	more: boolean;
	/** Read before this entry ID for the page before. Null when nothing is older. */
	nextBefore: number | null;
}
