import type { TaskModelRequest } from "@pilot/protocol";
import { Conflict } from "./errors.ts";

/** Opt-in passive preference contract, not a task update or an idempotency key. */
export function parseTaskModel(value: unknown, home?: { daemonId: string; lineageId: string }): TaskModelRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected task preference");
	const v = value as Record<string, unknown>;
	const h = v.home as Record<string, unknown> | undefined;
	if (
		Object.keys(v).sort().join(",") !== "home,operationId,preferredModel,preferredThinking,projectId" ||
		!h ||
		typeof h !== "object" ||
		Array.isArray(h) ||
		Object.keys(h).sort().join(",") !== "daemonId,lineageId" ||
		typeof v.operationId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.operationId) ||
		typeof v.projectId !== "string" ||
		!/^[a-zA-Z0-9._-]{1,128}$/.test(v.projectId) ||
		(v.preferredModel !== null &&
			(typeof v.preferredModel !== "string" || !v.preferredModel.trim() || v.preferredModel.length > 256)) ||
		(v.preferredThinking !== null &&
			(typeof v.preferredThinking !== "string" || !v.preferredThinking || v.preferredThinking.length > 32)) ||
		(v.preferredModel === null && v.preferredThinking !== null)
	)
		throw new Error("Invalid task preference");
	if (!home || h.daemonId !== home.daemonId || h.lineageId !== home.lineageId)
		throw new Conflict("The confirmed Local home changed");
	return value as TaskModelRequest;
}
