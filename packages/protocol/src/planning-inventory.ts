import type { InterviewFence } from "./mission-interview.ts";

/** Passive native planning list. No answer, receipt or execution capability. */
export interface PlanningInventoryItem {
	missionId: string;
	title: string;
	stage: "questions" | "review" | "planning" | "submitted" | "published";
	needsYou: boolean;
	round: InterviewFence;
	interviewRevision: number;
	planRevision: number | null;
}

/** A successful inventory is complete. Capacity and authority failures are non-2xx, not empty lists. */
export interface PlanningInventory {
	version: 1;
	projectId: string;
	status: "available";
	limit: number;
	total: number;
	items: PlanningInventoryItem[];
}
