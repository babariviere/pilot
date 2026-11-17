/** Native planning records only. Neither the frontier nor publication grants execution. */
export type PlanSource =
	| { kind: "decision"; id: string; digest: string }
	| { kind: "knowledge"; id: string; revision: number; linkRevision: number };
/** A disposable experiment in the agreement loop, never an execution grant. */
export interface PlanPrototype {
	context: string;
	experimentType: "logic-state" | "ui";
	smallestExperiment: string;
	/** Saved by older plans only. Pilot no longer stops prototype chats on time. */
	maxMinutes?: number;
	maxCostUsd: number;
	/** The model of the chat that makes the prototype, chosen by the planner. Omitted: the project's task model. */
	model?: string;
	/** Its thinking level. Omitted: the model's default. */
	thinking?: string;
}
export interface PlanPrototypeResult {
	/** Exact input snapshot. Later map changes make this evidence stale, not deleted. */
	planRevision: number;
	questionDigest: string;
	contextDigest: string;
	artifact: { sessionId: string; artifactId: string; revision: number };
	observations: string[];
	verdict: "supported" | "not-supported" | "inconclusive";
	unresolvedQuestions: string[];
}
export interface PlanQuestion {
	id: string;
	title: string;
	question: string;
	kind: "human" | "research" | "prototype";
	/** Required only for prototype questions. Omitted on legacy records. */
	prototype?: PlanPrototype;
	/** Written through plan-prototype-result only; never accepted as a map input. */
	prototypeResult?: PlanPrototypeResult;
	options: import("./mission-interview.ts").InterviewOption[];
	recommendedOptionId: string | null;
	dependsOn: string[];
	claimedBy: string | null;
	sources: PlanSource[];
	resolution: null | { kind: "decision" | "knowledge" | "interview"; id: string; digest: string };
}
export type PlanQuestionInput = Omit<PlanQuestion, "resolution" | "claimedBy" | "prototypeResult">;
export interface MissionFog {
	id: string;
	area: string;
	why: string;
	readyWhen: string;
	dependsOn: string[];
	sources: PlanSource[];
	/** Promoted rows stay in history; never simultaneously active fog and precise questions. */
	promotedTo: string[];
}
export interface PlanSpec {
	problem: string;
	solution: string;
	stories: { id: string; text: string }[];
	implementation: string[];
	testing: string[];
	exclusions: string[];
}
export interface PlanSlice {
	id: string;
	title: string;
	outcome: string;
	acceptance: string[];
	storyIds: string[];
	dependsOn: string[];
	/** Mixed slices keep substantive UI and backend ownership explicit. */
	owners: ("opus-ui" | "sol-backend")[];
	/** Exact repository-relative files or directory prefixes. Omitted scope takes the whole project's writer slot. */
	files?: string[];
	/**
	 * UI prototype questions the user settled for this slice. Its task names them, so the worker builds what the
	 * user chose. Omitted: no chosen prototype, and a worker on screen work shows a mockup before building.
	 */
	prototypes?: string[];
}
export interface MissionPlan {
	version: 1;
	missionId: string;
	revision: number;
	ownerSessionId: string;
	ownerFence: { memberEventId: number; coordinatorEventId: number };
	destination: string;
	sources: PlanSource[];
	questions: PlanQuestion[];
	fog: MissionFog[];
	spec: PlanSpec | null;
	slices: PlanSlice[];
	round: null | { topicId: string; digest: string; questionSetRevision: number };
	review: null | { digest: string; questionId: string; questionSetRevision: number };
	publication: null | {
		digest: string;
		submissionDigest: string;
		briefRevision: number;
		markdown: string;
		/**
		 * Published tasks. definition: the task as a confirmed revision left it (publishedDefinition); without it,
		 * the task must still match its slice. A task a revision added has slice ID "revision:<proposal>:<key>".
		 */
		tasks: { sliceId: string; taskId: string; definition?: string }[];
	};
}
export type PlanWrite =
	| {
			purpose: "plan-map";
			expectedRevision: number;
			destination: string;
			sources: PlanSource[];
			questions: PlanQuestionInput[];
			fog: Omit<MissionFog, "promotedTo">[];
	  }
	| {
			purpose: "plan-promote";
			expectedRevision: number;
			fogId: string;
			questions: PlanQuestionInput[];
	  }
	| {
			purpose: "plan-prototype-result";
			expectedRevision: number;
			questionId: string;
			result: PlanPrototypeResult;
	  }
	| { purpose: "plan-claim"; expectedRevision: number; questionId: string; claimedBy: string | null }
	| {
			purpose: "plan-resolve";
			expectedRevision: number;
			questionId: string;
			resolution: NonNullable<PlanQuestion["resolution"]>;
	  }
	| { purpose: "plan-propose"; expectedRevision: number; spec: PlanSpec; slices: PlanSlice[] }
	| { purpose: "plan-review"; expectedRevision: number }
	| {
			purpose: "plan-ask";
			expectedRevision: number;
			topicId: string;
			questions: import("./mission-interview.ts").InterviewQuestion[];
	  }
	| { purpose: "plan-publish"; expectedRevision: number };

/**
 * Whether a claim the map cites still matches its record at this read.
 * current: unchanged. changed: the record has a newer or different version.
 * missing: replaced, withdrawn, unlinked, or not in this read.
 */
export type PlanClaimState = "current" | "changed" | "missing";
/** One cited record, as the map shows it. */
export interface PlanMapSource {
	kind: "decision" | "knowledge" | "interview";
	id: string;
	/** Such as "Decision 4", "Knowledge: Title, revision 3" or "Interview round 2". */
	label: string;
	state: PlanClaimState;
	/** Knowledge only: whether its current revision was checked. A check is not proof of the claim. */
	checked?: "checked" | "not_checked" | "needs_check";
}
/** One precise question on the map, derived from its saved `PlanQuestion`. */
export interface PlanMapItem {
	id: string;
	title: string;
	question: string;
	kind: PlanQuestion["kind"];
	/**
	 * settled: resolved by an explicit record. asking: its topic interview is open.
	 * claimed: a member holds it (record ownership, never admission). ready: on the frontier.
	 * waiting: unsettled prerequisites first.
	 */
	state: "settled" | "asking" | "claimed" | "ready" | "waiting";
	dependsOn: string[];
	/** Unsettled prerequisites, by question ID. */
	waitingOn: string[];
	claimedBy: string | null;
	/** Claimed by Pilot's research chat, which has finished: its findings wait for the planner to record them. */
	findingsWaiting?: boolean;
	/** The fog area this question came from, by fog ID. */
	fromFog: string | null;
	sources: PlanMapSource[];
	settledBy: PlanMapSource | null;
	/** Prototype questions only: the limits its planner set, shown to the user. Cost is not enforced. */
	limits?: { maxCostUsd: number; model?: string };
	/** Prototype questions only. Findings are evidence, never acceptance or build authority. */
	evidence?: {
		state: "missing" | "current" | "stale";
		verdict?: PlanPrototypeResult["verdict"];
		planRevision?: number;
		artifact?: PlanPrototypeResult["artifact"];
		observations: string[];
		unresolvedQuestions: string[];
	};
}
export interface PlanMapFog {
	id: string;
	area: string;
	why: string;
	readyWhen: string;
	dependsOn: string[];
	sources: PlanMapSource[];
	/** Question IDs it became. Empty while still fog. */
	promotedTo: string[];
}
/**
 * The shared Wayfinder map: one projection of the saved plan, decisions, Knowledge links,
 * interview history and published tasks, rebuilt on every read and never stored. People see it
 * in the native planning page; the planning coordinator reads the same object. Reading or
 * showing it grants no execution, approval or admission.
 */
export interface MissionPlanMap {
	version: 1;
	/** Saved plan revision, or null before the first map. */
	planRevision: number | null;
	destination: string;
	items: PlanMapItem[];
	fog: PlanMapFog[];
	counts: {
		settled: number;
		asking: number;
		claimed: number;
		ready: number;
		waiting: number;
		activeFog: number;
		/** Cited records or prototype findings that are not current at this read. */
		notCurrent: number;
	};
	/** The agreement and its build tasks. Publication creates todo tasks only; it starts nothing. */
	agreement: null | {
		state: "proposed" | "in-review" | "published";
		briefRevision: number | null;
		tasks: { sliceId: string; taskId: string; number: number | null; title: string; status: string | null }[];
	};
}
