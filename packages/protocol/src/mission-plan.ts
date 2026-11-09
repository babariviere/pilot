/** Native planning records only. Neither the frontier nor publication grants execution. */
export type PlanSource =
	| { kind: "decision"; id: string; digest: string }
	| { kind: "knowledge"; id: string; revision: number; linkRevision: number };
export interface PlanQuestion {
	id: string;
	title: string;
	question: string;
	kind: "human" | "research";
	options: import("./mission-interview.ts").InterviewOption[];
	recommendedOptionId: string | null;
	dependsOn: string[];
	claimedBy: string | null;
	sources: PlanSource[];
	resolution: null | { kind: "decision" | "knowledge" | "interview"; id: string; digest: string };
}
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
		tasks: { sliceId: string; taskId: string }[];
	};
}
export type PlanWrite =
	| {
			purpose: "plan-map";
			expectedRevision: number;
			destination: string;
			sources: PlanSource[];
			questions: Omit<PlanQuestion, "resolution" | "claimedBy">[];
			fog: Omit<MissionFog, "promotedTo">[];
	  }
	| {
			purpose: "plan-promote";
			expectedRevision: number;
			fogId: string;
			questions: Omit<PlanQuestion, "resolution" | "claimedBy">[];
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
