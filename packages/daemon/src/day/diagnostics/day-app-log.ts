/** Day's closed local operational schema. Never falls back to raw log text. */
import { createHash } from "node:crypto";
import type { OperationHost } from "@pilot/protocol";
import type { NextAppOmission } from "./next-app-log.ts";

const events = new Set([
	"startup",
	"launch.selected",
	"launch.refused",
	"service.start",
	"exit.failed",
	"host.open",
	"focus.changed",
	"read.failed",
	"refresh.failed",
	"read.shape_error",
	"connection.open",
	"connection.lost",
	"close.requested",
	"close.refused",
	"close.cancelled",
	"close.seal_failed",
	"close.timeout",
	"handoff.requested",
	"handoff.finished",
	"handoff.stage",
	"js.error",
	"js.warning",
	"native.error",
	"native.warning",
	"ui.error",
	"forms.unsaved",
	"other",
]);
const errors = new Set([
	"Identity",
	"Offline",
	"Unavailable",
	"Invalid",
	"Stale",
	"Storage",
	"Unknown",
	"Closed",
	"Busy",
	"Capacity",
	"focus",
	"thread",
]);
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

export function dayAppBinding(host: OperationHost): string {
	return createHash("sha256").update(`daemon\0${host.daemonId}\0${host.lineageId}`).digest("hex");
}

export function dayAppLogLine(
	raw: string,
	host: OperationHost,
	now: number,
	epoch: number,
): { text?: string; omission?: NextAppOmission } {
	const omit = (omission: NextAppOmission) => ({ omission });
	if (Buffer.byteLength(raw) > 4096) return omit("invalid");
	try {
		const v = JSON.parse(raw);
		if (!v || typeof v !== "object" || Array.isArray(v)) return omit("invalid");
		const required = ["schemaVersion", "epoch", "binding", "at", "pid", "event"];
		const optional = ["generation", "protocol", "wasConnected", "update", "error"];
		const numbers = raw.replace(/"(?:\\.|[^"\\])*"/g, '""').match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
		if (
			required.some((k) => !Object.hasOwn(v, k)) ||
			Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k)) ||
			numbers.some((n) => !integer(Number(n)) || String(Number(n)) !== n) ||
			v.schemaVersion !== 1 ||
			!integer(v.epoch) ||
			typeof v.binding !== "string" ||
			!/^[a-f0-9]{64}$/.test(v.binding) ||
			!integer(v.pid) ||
			v.pid > 4294967295 ||
			typeof v.event !== "string" ||
			!events.has(v.event) ||
			typeof v.at !== "string" ||
			!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.at) ||
			!Number.isFinite(Date.parse(v.at)) ||
			new Date(v.at).toISOString() !== v.at ||
			["generation", "protocol"].some((k) => Object.hasOwn(v, k) && !integer(v[k])) ||
			["wasConnected", "update"].some((k) => Object.hasOwn(v, k) && typeof v[k] !== "boolean") ||
			(Object.hasOwn(v, "error") && (typeof v.error !== "string" || !errors.has(v.error)))
		)
			return omit("invalid");
		if (v.binding !== dayAppBinding(host)) return omit("identity");
		if (v.epoch !== epoch) return omit("cleared");
		if (Date.parse(v.at) > now) return omit("future");
		if (now - Date.parse(v.at) > 7 * 86400_000) return omit("expired");
		return { text: JSON.stringify(v) };
	} catch {
		return omit("invalid");
	}
}
