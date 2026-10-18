import type { WatchEvent, WatchInput, WatchTarget } from "@pilot/protocol";

export type { Watch, WatchEvent, WatchInput, WatchTarget } from "@pilot/protocol";
export const WATCH_EVENTS: readonly WatchEvent[] = [
	"chat.settled",
	"chat.failed",
	"pr.merged",
	"pr.closed",
	"pr.ready",
	"linear.done",
	"mission.task_done",
	"mission.done",
];
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
	const target: WatchTarget = {
		kind: value.target.kind,
		id: value.target.id.trim(),
		...(value.target.missionId === undefined ? {} : { missionId: value.target.missionId }),
	};
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
		...(typeof value.authorizationId === "string" && value.authorizationId.length <= 128
			? { authorizationId: value.authorizationId }
			: {}),
		event: value.event,
		target,
		filter: value.filter,
		mode: value.mode,
		note: value.note,
		expiresAt: value.expiresAt,
	};
}
