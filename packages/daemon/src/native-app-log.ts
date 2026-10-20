import type { OperationHost } from "@pilot/protocol";
import { redactDiagnosticText } from "./diagnostic-redaction.ts";

/** The production Swift producer's closed schema. A second disclosure fence, never raw app text. */
export function nativeAppLogLine(raw: string, host: OperationHost, now: number): string | undefined {
	if (Buffer.byteLength(raw) > 2048) return;
	try {
		const value = JSON.parse(raw);
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			value.schemaVersion !== 1 ||
			Object.keys(value).some(
				(key) => !["schemaVersion", "at", "host", "event", "errorDomain", "errorCode"].includes(key),
			) ||
			!value.host ||
			Object.keys(value.host).sort().join(",") !== "daemonId,hostId,lineageId" ||
			value.host.hostId !== "daemon" ||
			value.host.daemonId !== host.daemonId ||
			value.host.lineageId !== host.lineageId ||
			![
				"app_started",
				"app_terminating",
				"transport_failed",
				"repair_start_failed",
				"repair_archive_failed",
				"repair_started",
			].includes(value.event) ||
			typeof value.at !== "string" ||
			!Number.isFinite(Date.parse(value.at)) ||
			new Date(value.at).toISOString() !== value.at ||
			Date.parse(value.at) > now ||
			now - Date.parse(value.at) > 7 * 86400_000 ||
			(value.errorDomain !== undefined &&
				!["NSURLErrorDomain", "NSCocoaErrorDomain", "NSPOSIXErrorDomain", "other"].includes(value.errorDomain)) ||
			(value.errorCode !== undefined &&
				(!Number.isSafeInteger(value.errorCode) || Math.abs(value.errorCode) > 1_000_000))
		)
			return;
		return redactDiagnosticText(JSON.stringify(value));
	} catch {
		return;
	}
}
