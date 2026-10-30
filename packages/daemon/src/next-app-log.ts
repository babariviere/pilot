/** Next's private numeric capture, not Swift logs, edited exports or delivery receipts. */
import type { OperationHost } from "@pilot/protocol";
import { redactDiagnosticText } from "./diagnostic-redaction.ts";

export type NextAppOmission = "legacy" | "unbound" | "identity" | "expired" | "future" | "invalid" | "cleared";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keys = (v: unknown, expected: string[]) =>
	!!v &&
	typeof v === "object" &&
	!Array.isArray(v) &&
	Object.keys(v).sort().join(",") === [...expected].sort().join(",");
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

export function nextAppLogLine(
	raw: string,
	host: OperationHost,
	now: number,
	epoch = 0,
): { text?: string; omission?: NextAppOmission } {
	const omit = (omission: NextAppOmission) => ({ omission });
	if (Buffer.byteLength(raw) > 4096) return omit("invalid");
	try {
		const v = JSON.parse(raw);
		if (!v || typeof v !== "object" || Array.isArray(v)) return omit("invalid");
		if (v.schema === undefined || v.schema === 1) return omit("legacy");
		// Reject noncanonical numeric spellings before they can lose precision in JSON.parse.
		const numbers = raw.replace(/"(?:\\.|[^"\\])*"/g, '""').match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
		if (
			numbers.some((n) => !integer(Number(n)) || String(Number(n)) !== n) ||
			v.schema !== 2 ||
			!keys(v, [
				"schema",
				"epoch",
				...(Object.hasOwn(v, "host") ? ["host"] : []),
				"build",
				"run",
				"seconds",
				"operation",
				"request",
				"stage",
				"outcome",
				"response_received",
				"status",
				"elapsed_ms",
				"loss",
			]) ||
			!keys(v.build, ["version", "desktop_source_sha256"]) ||
			typeof v.build.version !== "string" ||
			!/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(v.build.version) ||
			typeof v.build.desktop_source_sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(v.build.desktop_source_sha256) ||
			typeof v.run !== "string" ||
			!UUID.test(v.run) ||
			!integer(v.seconds) ||
			(v.epoch !== null && !integer(v.epoch)) ||
			v.seconds > 253402300799 ||
			!keys(v.loss, ["dropped", "storage_errors"]) ||
			!integer(v.loss.dropped) ||
			!integer(v.loss.storage_errors) ||
			(v.request !== null && !integer(v.request)) ||
			(v.elapsed_ms !== null && !integer(v.elapsed_ms)) ||
			(v.status !== null && (!integer(v.status) || v.status < 100 || v.status > 599)) ||
			(v.stage !== null && !["identity", "target", "lookup", "execute", "adoption"].includes(v.stage)) ||
			(v.outcome !== null &&
				![
					"inFlight",
					"interrupted",
					"refused",
					"responseInterrupted",
					"tooLarge",
					"malformed",
					"identity",
					"receiptMismatch",
					"unknown",
					"pending",
					"accepted",
					"rejected",
					"privateWrite",
					"privateCapacity",
					"privateState",
				].includes(v.outcome)) ||
			!["startup", "deliveryRequest"].includes(v.operation) ||
			(v.operation === "startup"
				? [v.request, v.stage, v.outcome, v.response_received, v.status, v.elapsed_ms].some((x) => x !== null)
				: v.request === null ||
					v.stage === null ||
					v.elapsed_ms === null ||
					typeof v.response_received !== "boolean" ||
					(v.response_received ? v.outcome !== null || v.status !== 200 : v.outcome === null))
		)
			return omit("invalid");
		if (v.seconds * 1000 > now) return omit("future");
		if (now - v.seconds * 1000 > 7 * 86400_000) return omit("expired");
		if (v.host === undefined || v.host === null) return omit("unbound");
		if (
			!keys(v.host, ["hostId", "daemonId", "lineageId"]) ||
			v.host.hostId !== "daemon" ||
			typeof v.host.daemonId !== "string" ||
			!UUID.test(v.host.daemonId) ||
			typeof v.host.lineageId !== "string" ||
			!UUID.test(v.host.lineageId)
		)
			return omit("invalid");
		if (v.host.daemonId !== host.daemonId || v.host.lineageId !== host.lineageId) return omit("identity");
		if (v.epoch === null) return omit("invalid");
		if (v.epoch !== epoch) return omit("cleared");
		// A derived timestamp supports the existing since/ref interface, never raw fallback.
		return { text: redactDiagnosticText(JSON.stringify({ at: new Date(v.seconds * 1000).toISOString(), ...v })) };
	} catch {
		return omit("invalid");
	}
}
