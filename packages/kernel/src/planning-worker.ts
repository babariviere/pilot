/** Private, versioned worker binding. Never accepted from model arguments or generic SpawnRequest. */
import type { DurableOperation, InterviewVersion, OperationHost, PlanWrite } from "@pilot/protocol";

export const PLANNING_PROFILE = {
	version: 1,
	id: "native-mission-planning",
	source: "https://github.com/mattpocock/skills",
	commit: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d",
} as const;

export interface PlanningWorkerBinding {
	version: 1;
	profile: typeof PLANNING_PROFILE;
	home: string;
	host: OperationHost;
	projectId: string;
	ownerSessionId: string;
	missionId: string;
	enrollmentId: string;
	creationOperationId: string;
}
export interface PlanningRound extends InterviewVersion {
	operationId: string;
	contextDigest: string;
}
export type PlanningWorkerRequest =
	| { action: "read"; revision?: number }
	| { action: "knowledge"; id: string; revision: number }
	| { action: "receipt"; operationId: string }
	| { action: "write"; toolCallId: string; request: PlanWrite }
	| {
			action: "questions";
			toolCallId: string;
			request: Extract<import("@pilot/protocol").InterviewWrite, { purpose: "interview-questions" }>;
	  };
export interface PlanningWorkerReply {
	value: unknown;
	blocked?: boolean;
	/** Saved before returning the tool, not a promise awaiting human answers. */
	hold?: PlanningRound;
}
export interface PlanningInput {
	binding: PlanningWorkerBinding;
	operation: DurableOperation;
	hold: PlanningRound | null;
	content: string;
}
export function assertPlanningBinding(binding: PlanningWorkerBinding): void {
	if (
		binding?.version !== 1 ||
		planningJSON(binding.profile) !== planningJSON(PLANNING_PROFILE) ||
		!binding.home?.startsWith("/") ||
		![
			binding.projectId,
			binding.ownerSessionId,
			binding.missionId,
			binding.enrollmentId,
			binding.creationOperationId,
		].every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
		!binding.host?.daemonId ||
		!binding.host.lineageId
	)
		throw new Error("Trusted planning worker binding unavailable");
}

export function planningJSON(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: item,
	);
}
