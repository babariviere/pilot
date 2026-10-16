/** Pure durable-intent reduction. Structural changes never manufacture task completion. */
import { randomUUID } from "node:crypto";
import type { MissionLinearSync, MissionTaskStatus } from "@pilot/protocol";

export interface LinearContributor {
	linkId: string;
	taskId: string;
	status: MissionTaskStatus;
}
export interface LinearSyncRecord {
	version: string;
	contributors: LinearContributor[];
	status: MissionLinearSync;
	intent?: { target: NonNullable<MissionLinearSync["target"]>; stateId?: string; config?: string };
	attempts: number;
	/** A resume accepts the next freshly verified remote state as the baseline. */
	acceptBaseline?: boolean;
	/** Independent of transient network errors and terminal observations. Only explicit resume clears it. */
	paused?: string;
}

export function linearTarget(tasks: LinearContributor[]): MissionLinearSync["target"] {
	if (!tasks.length) return;
	if (tasks.every((t) => t.status === "done")) return "merged";
	const unfinished = tasks.filter((t) => t.status !== "done");
	if (unfinished.every((t) => t.status === "in_review")) return "inReview";
	if (tasks.some((t) => t.status === "in_progress" || t.status === "in_review" || t.status === "done"))
		return "inProgress";
}

export function reconcileLinearRecord(
	previous: LinearSyncRecord | undefined,
	contributors: LinearContributor[],
	structuralEdit = false,
	reopenedTask = false,
): LinearSyncRecord {
	if (
		previous &&
		!structuralEdit &&
		!reopenedTask &&
		JSON.stringify(previous.contributors) === JSON.stringify(contributors)
	)
		return previous;
	const record: LinearSyncRecord = {
		...previous,
		version: randomUUID(),
		contributors,
		status: { ...previous?.status, state: "idle", updatedAt: Date.now() },
		attempts: 0,
	};
	delete record.intent;
	delete record.status.target;
	delete record.status.error;
	delete record.status.retryAt;
	const structural =
		previous &&
		(structuralEdit ||
			JSON.stringify(previous.contributors.map((t) => [t.linkId, t.taskId])) !==
				JSON.stringify(contributors.map((t) => [t.linkId, t.taskId])));
	const reopened =
		reopenedTask ||
		previous?.contributors.some(
			(old) =>
				["done", "dropped"].includes(old.status) &&
				contributors.some((t) => t.taskId === old.taskId && !["done", "dropped"].includes(t.status)),
		);
	if (previous?.status.state === "terminal" && !reopened) {
		record.status.state = "terminal";
		return record;
	}
	if (
		previous?.paused ||
		previous?.status.state === "paused" ||
		reopened ||
		(structural && (previous?.status.issueId || previous?.intent))
	) {
		record.status.state = "paused";
		record.status.reason = reopened
			? "A contributing task reopened. Review the ticket, then resume synchronization."
			: previous?.status.state === "paused"
				? previous.status.reason
				: "Contributing links changed. Review the scope, then resume synchronization.";
		record.paused = previous?.paused ?? record.status.reason;
		return record;
	}
	delete record.status.reason;
	const target = linearTarget(contributors);
	// Initial attachment and link edits alone may start work, but never mark it complete.
	if (target && (target !== "merged" || (previous && !structural))) {
		record.intent = { target };
		record.status = { ...record.status, state: "pending", target };
	}
	return record;
}
