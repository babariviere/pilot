/** Closed, content-free records sharing the bounded request-timing log and its collection consent. */
import type { ControlPreparationDiagnosticEvidence } from "@pilot/protocol";

export interface ControlPreparationRecord {
	v: 1;
	source: "control_preparation";
	at: number;
	attemptRef: string;
	stage: ControlPreparationDiagnosticEvidence["stage"];
	outcome: ControlPreparationDiagnosticEvidence["outcome"];
	reason?: "preparation_failure";
	durationMs: number;
	droppedBefore?: number;
}

export function parseControlPreparationRecord(value: unknown): ControlPreparationRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const r = value as ControlPreparationRecord;
	if (
		r.v !== 1 ||
		r.source !== "control_preparation" ||
		!Number.isFinite(r.at) ||
		r.at < 0 ||
		r.at > 8_640_000_000_000_000 ||
		typeof r.attemptRef !== "string" ||
		!/^diagnostic:v1:control-preparation:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			r.attemptRef,
		) ||
		!["history_record", "history_summarization", "request_projection"].includes(r.stage) ||
		!["prepared", "failed", "cancelled"].includes(r.outcome) ||
		(r.outcome === "failed" ? r.reason !== "preparation_failure" : r.reason !== undefined) ||
		!Number.isFinite(r.durationMs) ||
		r.durationMs < 0 ||
		(r.droppedBefore !== undefined && (!Number.isSafeInteger(r.droppedBefore) || r.droppedBefore < 0))
	)
		return;
	return {
		v: 1,
		source: "control_preparation",
		at: r.at,
		attemptRef: r.attemptRef,
		stage: r.stage,
		outcome: r.outcome,
		durationMs: Math.round(Math.min(r.durationMs, Number.MAX_SAFE_INTEGER) * 100) / 100,
		...(r.reason ? { reason: r.reason } : {}),
		...(r.droppedBefore ? { droppedBefore: r.droppedBefore } : {}),
	};
}
