import { randomUUID } from "node:crypto";
import type { MissionThreadHandoff } from "../../protocol/src/mission-thread.ts";

/**
 * Tasks in one handoff, at most. A thread is one topic: more tasks than this is several topics, and the planner reads
 * the whole handoff in one turn. The mission tool's schema states the same number.
 */
const HANDOFF_TASKS = 20;
/** Acceptance lines per task and dependencies per task, at most, for the same reason. */
const HANDOFF_LINES = 20;

const text = (value: unknown, max: number, what: string): string => {
	if (typeof value !== "string" || !value.trim() || Array.from(value).length > max)
		throw new Error(`${what} must contain 1 to ${max} characters`);
	return value.trim();
};
const list = (value: unknown, max: number, what: string): unknown[] => {
	if (!Array.isArray(value) || !value.length || value.length > max)
		throw new Error(`${what} must list 1 to ${max} items (the limit is ${max}, so a handoff stays one topic)`);
	return value;
};

/** Checks a thread chat's handoff arguments. The handoff grants nothing: the user confirms the planner's revision. */
export function threadHandoff(args: Record<string, unknown>, sessionId: string): MissionThreadHandoff {
	const keys = new Set<string>();
	const tasks = list(args.handoffTasks, HANDOFF_TASKS, "handoffTasks").map((raw, index) => {
		const task = (raw ?? {}) as Record<string, unknown>;
		const extra = Object.keys(task).find(
			(k) => !["key", "title", "outcome", "acceptance", "dependsOn", "prototype"].includes(k),
		);
		if (extra) throw new Error(`handoffTasks[${index}] has an unknown field ${extra}`);
		if (typeof task.key !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(task.key))
			throw new Error(`handoffTasks[${index}].key is 1 to 64 letters, digits, - or _`);
		if (keys.has(task.key)) throw new Error(`Duplicate handoff task key ${task.key}`);
		keys.add(task.key);
		const empty = Array.isArray(task.dependsOn) && !task.dependsOn.length;
		const dependsOn =
			task.dependsOn === undefined || empty
				? undefined
				: list(task.dependsOn, HANDOFF_LINES, `handoffTasks[${index}].dependsOn`).map((d) =>
						text(String(d), 128, `handoffTasks[${index}].dependsOn`),
					);
		const proto = task.prototype as Record<string, unknown> | undefined;
		if (
			proto !== undefined &&
			(typeof proto !== "object" ||
				typeof proto.artifactId !== "string" ||
				!proto.artifactId ||
				!Number.isSafeInteger(proto.revision) ||
				(proto.revision as number) < 1)
		)
			throw new Error(`handoffTasks[${index}].prototype needs artifactId and revision`);
		return {
			key: task.key,
			title: text(task.title, 200, `handoffTasks[${index}].title`),
			outcome: text(task.outcome, 4000, `handoffTasks[${index}].outcome`),
			acceptance: list(task.acceptance, HANDOFF_LINES, `handoffTasks[${index}].acceptance`).map((line) =>
				text(line, 1000, `handoffTasks[${index}].acceptance`),
			),
			...(dependsOn?.length ? { dependsOn } : {}),
			...(proto
				? { prototype: { artifactId: proto.artifactId as string, revision: proto.revision as number } }
				: {}),
		};
	});
	return { id: randomUUID(), sessionId, summary: text(args.summary, 4000, "summary"), tasks, at: Date.now() };
}
