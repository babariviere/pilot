import type { DiagnosticLogSourceId, TargetLogSourceId } from "@pilot/protocol";

// Installed Pilot Next still writes logs that pilotd reads.
const scope = {
	app: "host",
	next_app: "host",
	day_app: "host",
	daemon: "host",
	kernel_worker: "host",
	native_report: "host",
	lifecycle: "target",
	request_timing: "target",
	tool_activity: "target",
} as const satisfies {
	[Id in DiagnosticLogSourceId]: Id extends TargetLogSourceId ? "target" : "host";
};

export const DIAGNOSTIC_LOG_SOURCES = Object.keys(scope) as DiagnosticLogSourceId[];
export const TARGET_LOG_SOURCES = DIAGNOSTIC_LOG_SOURCES.filter(
	(id): id is TargetLogSourceId => scope[id] === "target",
);
