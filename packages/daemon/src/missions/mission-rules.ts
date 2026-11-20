/** Mission rules that several modules apply. Change a rule here, not at its call sites. */
import type { MissionDecision, MissionRole } from "@pilot/protocol";

/** Done and dropped tasks are closed; every other status is open work. */
export function isOpenTask(task: { status: string }): boolean {
	return task.status !== "done" && task.status !== "dropped";
}

/** A member chat of an active mission that builds: not the coordinator, a builder role or none (older chats). */
export function isActiveBuilder<T extends { active: boolean; coordinator: boolean; role?: MissionRole }>(
	member: T | undefined,
): member is T {
	return !!member?.active && !member.coordinator && (member.role === undefined || member.role === "builder");
}

/** Replaced and withdrawn decisions keep their history but no longer guide work. */
export function isActiveDecision(decision: Pick<MissionDecision, "replacement" | "withdrawn">): boolean {
	return !decision.replacement && !decision.withdrawn;
}
