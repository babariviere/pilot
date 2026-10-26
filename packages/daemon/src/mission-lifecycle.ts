import type { MissionLifecycleRequest } from "@pilot/protocol";
import { Conflict } from "./errors.ts";

/** Strict opt-in contract: no arbitrary metadata, membership or automation payload. */
export function parseMissionLifecycle(
	value: unknown,
	home?: { daemonId: string; lineageId: string },
): MissionLifecycleRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected lifecycle confirmation");
	const v = value as Record<string, unknown>;
	const h = v.home as Record<string, unknown> | undefined;
	if (
		Object.keys(v).sort().join(",") !== "action,expectedStatus,home,operationId,projectId" ||
		!h ||
		typeof h !== "object" ||
		Array.isArray(h) ||
		Object.keys(h).sort().join(",") !== "daemonId,lineageId" ||
		typeof v.operationId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.operationId) ||
		typeof v.projectId !== "string" ||
		!/^[a-zA-Z0-9._-]{1,128}$/.test(v.projectId) ||
		!["active", "done", "archived"].includes(String(v.expectedStatus)) ||
		(v.action !== "archive" && v.action !== "reopen")
	)
		throw new Error("Invalid lifecycle confirmation");
	if (!home || h.daemonId !== home.daemonId || h.lineageId !== home.lineageId)
		throw new Conflict("The confirmed Local home changed");
	return value as MissionLifecycleRequest;
}
