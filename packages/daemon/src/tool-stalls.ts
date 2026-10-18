import type {
	DiagnosticPauseReason,
	NeedsYouReason,
	ToolActivityAssessment,
	ToolActivityCall,
	ToolActivitySnapshot,
	ToolDiagnosticCategory,
} from "@pilot/protocol";

export const TOOL_CANCELLATION_DELAY_MS = 30_000;
export const TOOL_LIVENESS_STALE_MS = 60_000;

const NO_PROGRESS_MS: Record<ToolDiagnosticCategory, number> = {
	filesystem: 5 * 60_000,
	network: 10 * 60_000,
	mcp: 10 * 60_000,
	shell: 15 * 60_000,
	codemode: 15 * 60_000,
	orchestration: 15 * 60_000,
	other: 15 * 60_000,
	background: 60 * 60_000,
};
const CATEGORIES = new Set(Object.keys(NO_PROGRESS_MS));
const STATES = new Set(["dispatching", "running", "cancelling"]);
const WAIT_KINDS = new Set(["user", "background", "child"]);

function finiteTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function validSnapshot(snapshot: ToolActivitySnapshot | undefined): snapshot is ToolActivitySnapshot {
	return !!snapshot?.enabled && finiteTime(snapshot.observedAt) && Array.isArray(snapshot.calls);
}

function validCall(call: ToolActivityCall): boolean {
	return (
		!!call &&
		CATEGORIES.has(call.category) &&
		STATES.has(call.state) &&
		(call.waitKind === undefined || WAIT_KINDS.has(call.waitKind)) &&
		finiteTime(call.startedAt) &&
		finiteTime(call.progressAt) &&
		finiteTime(call.livenessAt) &&
		(call.cancelRequestedAt === undefined || finiteTime(call.cancelRequestedAt))
	);
}

export interface ToolStallContext {
	pauses: readonly DiagnosticPauseReason[];
	runningJobs: number;
}

export interface ToolAssessment {
	assessment: ToolActivityAssessment;
	thresholdMs?: number;
	dueAt?: number;
	attentionAt?: number;
}

const PAUSE_ASSESSMENTS: ReadonlyArray<[DiagnosticPauseReason, ToolActivityAssessment]> = [
	["sleep", "paused_sleep"],
	["update", "paused_update"],
	["quota", "paused_quota"],
	["connectivity", "paused_connectivity"],
	["user", "paused_user"],
];

/** Conservative evidence classification. A suspected state is never proof of deadlock. */
export function assessToolCall(
	call: ToolActivityCall,
	snapshotObservedAt: number,
	context: ToolStallContext,
	now: number,
): ToolAssessment {
	for (const [pause, assessment] of PAUSE_ASSESSMENTS) {
		if (context.pauses.includes(pause)) return { assessment };
	}

	if (call.cancelRequestedAt !== undefined) {
		const dueAt = call.cancelRequestedAt + TOOL_CANCELLATION_DELAY_MS;
		if (now >= dueAt)
			return {
				assessment: "suspected_cancellation_delay",
				thresholdMs: TOOL_CANCELLATION_DELAY_MS,
				attentionAt: dueAt,
			};
		return { assessment: "cancelling", thresholdMs: TOOL_CANCELLATION_DELAY_MS, dueAt };
	}

	const livenessAt = Math.max(call.livenessAt, snapshotObservedAt);
	const livenessDue = livenessAt + TOOL_LIVENESS_STALE_MS;
	if (now >= livenessDue)
		return {
			assessment: "suspected_unresponsive",
			thresholdMs: TOOL_LIVENESS_STALE_MS,
			attentionAt: livenessDue,
		};

	if (call.waitKind === "user") return { assessment: "waiting_user", dueAt: livenessDue };
	if (call.waitKind === "child") return { assessment: "waiting_child", dueAt: livenessDue };
	if (call.waitKind === "background" || (call.category === "background" && context.runningJobs > 0))
		return { assessment: "background_work", dueAt: livenessDue };

	const thresholdMs = NO_PROGRESS_MS[call.category];
	const progressDue = call.progressAt + thresholdMs;
	if (now >= progressDue) return { assessment: "suspected_no_progress", thresholdMs, attentionAt: progressDue };
	return { assessment: "active", thresholdMs, dueAt: Math.min(progressDue, livenessDue) };
}

export function toolStallAttention(
	snapshot: ToolActivitySnapshot | undefined,
	context: ToolStallContext,
	now = Date.now(),
): ({ reason: NeedsYouReason; at: number; assessment: ToolActivityAssessment } & ToolAssessment) | undefined {
	if (!validSnapshot(snapshot)) return;
	const rank: Partial<Record<ToolActivityAssessment, number>> = {
		suspected_cancellation_delay: 0,
		suspected_unresponsive: 1,
		suspected_no_progress: 2,
	};
	let selected:
		| ({ reason: NeedsYouReason; at: number; assessment: ToolActivityAssessment; rank: number } & ToolAssessment)
		| undefined;
	for (const call of snapshot.calls.slice(0, 32)) {
		if (!validCall(call)) continue;
		const result = assessToolCall(call, snapshot.observedAt, context, now);
		if (!result.attentionAt) continue;
		const minutes = Math.max(1, Math.floor((now - result.attentionAt + (result.thresholdMs ?? 0)) / 60_000));
		const detail =
			result.assessment === "suspected_cancellation_delay"
				? `A ${call.category} tool has not finished after cancellation was requested`
				: result.assessment === "suspected_unresponsive"
					? `The worker stopped reporting liveness during a ${call.category} tool`
					: `A ${call.category} tool has shown no useful progress for ${minutes} min`;
		const candidate = {
			...result,
			assessment: result.assessment,
			rank: rank[result.assessment] ?? 3,
			reason: { kind: "tool_stall" as const, detail },
			at: result.attentionAt,
		};
		if (
			!selected ||
			candidate.rank < selected.rank ||
			(candidate.rank === selected.rank && candidate.at < selected.at)
		)
			selected = candidate;
	}
	return selected;
}

export function nextToolStallAt(
	snapshot: ToolActivitySnapshot | undefined,
	context: ToolStallContext,
	now = Date.now(),
): number | undefined {
	if (!validSnapshot(snapshot)) return;
	let next: number | undefined;
	for (const call of snapshot.calls.slice(0, 32)) {
		if (!validCall(call)) continue;
		const result = assessToolCall(call, snapshot.observedAt, context, now);
		if (result.attentionAt !== undefined) continue;
		if (result.dueAt !== undefined && (next === undefined || result.dueAt < next)) next = result.dueAt;
	}
	return next;
}

/** One process-wide timer for all sessions. Snapshots update its nearest deadline; no per-call polling is used. */
export class ToolStallWatchdog {
	private readonly deadlines = new Map<string, { at: number; due: (id: string) => void }>();
	private timer?: ReturnType<typeof setTimeout>;

	update(id: string, at: number | undefined, due: (id: string) => void): void {
		if (at === undefined || !Number.isFinite(at)) this.deadlines.delete(id);
		else this.deadlines.set(id, { at, due });
		this.arm();
	}

	remove(id: string): void {
		if (this.deadlines.delete(id)) this.arm();
	}

	close(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.deadlines.clear();
	}

	private arm(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		let earliest = Number.POSITIVE_INFINITY;
		for (const deadline of this.deadlines.values()) earliest = Math.min(earliest, deadline.at);
		if (!Number.isFinite(earliest)) return;
		this.timer = setTimeout(() => this.fire(), Math.max(1, earliest - Date.now()));
		this.timer.unref();
	}

	private fire(): void {
		this.timer = undefined;
		const now = Date.now();
		for (const [id, deadline] of [...this.deadlines]) {
			if (deadline.at > now) continue;
			this.deadlines.delete(id);
			try {
				deadline.due(id);
			} catch {
				// Observation cannot affect the worker.
			}
		}
		this.arm();
	}
}
