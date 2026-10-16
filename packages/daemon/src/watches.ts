/** Internal watch contract. Wire protocol/tool exposure separately from storage. */
export const WATCH_EVENTS = [
	"chat.settled",
	"chat.failed",
	"pr.merged",
	"pr.closed",
	"pr.ready",
	"linear.done",
	"mission.task_done",
	"mission.done",
] as const;
export type WatchEvent = (typeof WATCH_EVENTS)[number];
export type WatchTarget = {
	kind: "chat" | "project" | "mission" | "pr" | "chat_prs" | "linear" | "task";
	id: string;
	missionId?: string;
};
export interface WatchInput {
	event: WatchEvent;
	target: WatchTarget;
	filter?: { outcome?: "done" | "failed" | "stopped" };
	mode: "once" | "persistent";
	note: string;
	expiresAt?: number;
}
export interface Watch extends WatchInput {
	id: string;
	createdAt: number;
}
export const MAX_WATCHES = 10_000;

export function validateWatch(value: WatchInput, now = Date.now()): WatchInput {
	if (!value || !WATCH_EVENTS.includes(value.event) || !value.target) throw new Error("Invalid watch event or target");
	const kinds = value.event.startsWith("chat.")
		? ["chat", "project", "mission"]
		: value.event.startsWith("pr.")
			? ["pr", "chat_prs"]
			: value.event === "linear.done"
				? ["linear"]
				: value.event === "mission.done"
					? ["mission"]
					: ["task", "mission"];
	if (!kinds.includes(value.target.kind)) throw new Error("Watch target does not support this event");
	if (
		typeof value.target.id !== "string" ||
		!value.target.id.trim() ||
		value.target.id.length > 500 ||
		/[\x00-\x1f]/.test(value.target.id)
	)
		throw new Error("Invalid target ID");
	const target = { ...value.target, id: value.target.id.trim() };
	if (target.kind === "pr") {
		const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(target.id);
		if (!match) throw new Error("Expected a GitHub PR URL");
		target.id = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`.toLowerCase();
	}
	if (target.kind === "linear") {
		if (!/^[a-z][a-z0-9]*-\d+$/i.test(target.id)) throw new Error("Expected a Linear issue identifier");
		target.id = target.id.toUpperCase();
	}
	if (target.kind === "task") {
		if (typeof target.missionId !== "string" || !target.missionId.trim() || target.missionId.length > 200)
			throw new Error("Task targets require a mission ID");
	} else if (target.missionId !== undefined) throw new Error("Only task targets have a mission ID");
	if (value.mode !== "once" && value.mode !== "persistent") throw new Error("Invalid watch mode");
	if (typeof value.note !== "string" || !value.note.trim() || Buffer.byteLength(value.note) > 4096)
		throw new Error("Watch note must be 1–4096 bytes");
	if (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now))
		throw new Error("Watch expiry must be in the future");
	if (
		value.filter &&
		(Object.keys(value.filter).some((k) => k !== "outcome") ||
			!value.event.startsWith("chat.") ||
			(value.filter.outcome !== undefined && !["done", "failed", "stopped"].includes(value.filter.outcome)))
	)
		throw new Error("Invalid watch filter");
	return {
		event: value.event,
		target,
		filter: value.filter,
		mode: value.mode,
		note: value.note,
		expiresAt: value.expiresAt,
	};
}
