/** Last observations only, process-local and bounded. No content, tool arguments, cursor or event history. */
import type { RefreshLiveHealth, RefreshObservation, RefreshOutcome, RefreshReason } from "@pilot/protocol";
export const SOURCE_REFRESH_CADENCE_MS = 300_000;
export const SOURCE_REFRESH_TIMEOUT_MS = 90_000;

export class SourceRefreshDiagnostics {
	private enabled = true;
	private readonly records = new Map<string, { key: string; value: RefreshLiveHealth }>();
	private dropped = 0;
	private droppedDue = 0;
	private readonly due = new Map<string, { key: string; at: number }>();
	readonly processStartedAt = Date.now();
	private observedSince = this.processStartedAt;
	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		this.clear();
	}
	clear(): void {
		this.records.clear();
		this.due.clear();
		this.dropped = 0;
		this.droppedDue = 0;
		this.observedSince = Date.now();
	}
	coverage() {
		return {
			enabled: this.enabled,
			processStartedAt: this.processStartedAt,
			observedSince: this.observedSince,
			retention: "current_process_last_observation" as const,
			sourceLimit: 256,
			droppedSources: this.dropped,
			dueRequestLimit: 256,
			droppedDueRequests: this.droppedDue,
		};
	}
	prune(currentKey: (id: string) => string | undefined): void {
		for (const [id, value] of this.records) if (currentKey(id) !== value.key) this.records.delete(id);
		for (const [id, value] of this.due) if (currentKey(id) !== value.key) this.due.delete(id);
	}
	requestDue(id: string, key: string): void {
		if (!this.enabled) return;
		if (!this.due.has(id) && this.due.size >= 256) {
			this.due.delete(this.due.keys().next().value!);
			this.droppedDue = Math.min(1_000_000, this.droppedDue + 1);
		}
		this.due.set(id, { key, at: Date.now() });
	}
	dueAt(id: string, key: string): number | undefined {
		const value = this.due.get(id);
		return this.enabled && value?.key === key ? value.at : undefined;
	}
	begin(id: string, key: string): void {
		if (!this.enabled) return;
		this.due.delete(id);
		const old = this.records.get(id);
		if (!old && this.records.size >= 256) {
			this.records.delete(this.records.keys().next().value!);
			this.dropped = Math.min(1_000_000, this.dropped + 1);
		}
		const at = Date.now();
		const previous = old?.key === key ? old.value : undefined;
		this.records.set(id, {
			key,
			value: {
				lastAttemptAt: at,
				lastStartedAt: at,
				...(previous?.lastCompletedAt === undefined
					? {}
					: { lastCompletedAt: previous.lastCompletedAt, outcome: previous.outcome, reason: previous.reason }),
				...(previous?.lastCommittedAt === undefined ? {} : { lastCommittedAt: previous.lastCommittedAt }),
				stages: previous?.stages.map((s) => ({ stage: s.stage, lastSucceededAt: s.lastSucceededAt })) ?? [],
			},
		});
	}
	observe(id: string, key: string, event: RefreshObservation): void {
		const record = this.records.get(id);
		if (!this.enabled || record?.key !== key) return;
		const at = Date.now();
		let stage = record.value.stages.find((s) => s.stage === event.stage);
		if (!stage) {
			stage = { stage: event.stage };
			record.value.stages.push(stage);
		}
		if (event.phase === "started") {
			stage.lastStartedAt = at;
			delete stage.lastCompletedAt;
			delete stage.outcome;
			delete stage.reason;
			delete stage.count;
		} else if (event.phase === "partial") {
			stage.outcome = "partial";
			stage.reason = event.reason ?? "unknown";
		} else {
			stage.lastCompletedAt = at;
			const outcome = event.outcome ?? "success";
			stage.outcome = stage.outcome === "partial" && outcome === "success" ? "partial" : outcome;
			if (stage.outcome === "success") stage.lastSucceededAt = at;
			if (event.reason) stage.reason = event.reason;
		}
		if (Number.isSafeInteger(event.channelIndex) && event.channelIndex! >= 0 && event.channelIndex! < 100)
			stage.channelIndex = event.channelIndex;
		if (Number.isSafeInteger(event.count) && event.count! >= 0 && event.count! <= 1_000_000)
			stage.count = event.count;
		if (event.stage === "commit" && event.phase === "completed" && event.outcome === "success") {
			record.value.lastCommittedAt = at;
			record.value.returnedItems = event.count;
		}
	}
	end(id: string, key: string, outcome: RefreshOutcome, reason?: RefreshReason): void {
		const record = this.records.get(id);
		if (!this.enabled || record?.key !== key) return;
		record.value.lastCompletedAt = Date.now();
		record.value.outcome =
			outcome === "success" &&
			record.value.stages.some(
				(s) =>
					s.lastStartedAt !== undefined &&
					s.lastStartedAt >= record.value.lastStartedAt &&
					s.outcome !== undefined &&
					s.outcome !== "success",
			)
				? "partial"
				: outcome;
		if (reason) record.value.reason = reason;
		if (outcome === "failure" || outcome === "cancelled") {
			const active = record.value.stages.findLast(
				(s) => s.lastStartedAt !== undefined && s.lastCompletedAt === undefined,
			);
			if (active) this.observe(id, key, { stage: active.stage, phase: "completed", outcome, reason });
		}
	}
	read(id: string, key: string): RefreshLiveHealth | undefined {
		const value = this.records.get(id);
		return this.enabled && value?.key === key ? structuredClone(value.value) : undefined;
	}
}

export function refreshAssessment(
	input: {
		configured: boolean;
		adapter: boolean;
		automatic: boolean;
		stopped: boolean;
		running?: { startedAt: number; cancelling: boolean };
		nextDueAt?: number;
		busySlots: number;
		live?: RefreshLiveHealth;
		backoff?: string;
		checkpointAt?: number;
		unobservedDueOverride?: boolean;
	},
	now: number,
) {
	const skew = [
		input.live?.lastStartedAt,
		input.live?.lastCompletedAt,
		input.running?.startedAt,
		input.checkpointAt,
	].some((v) => v !== undefined && (!Number.isFinite(v) || v > now));
	if (!input.configured) return { state: "not_configured", clockSkew: skew };
	if (input.stopped) return { state: "stopped", clockSkew: skew };
	if (!input.adapter) return { state: "unavailable", reason: "adapter_missing", clockSkew: skew };
	if (skew) return { state: "unknown_clock", clockSkew: true };
	if (input.running)
		return {
			state: input.running.cancelling
				? "cancelling"
				: now - input.running.startedAt > SOURCE_REFRESH_TIMEOUT_MS
					? "deadline_elapsed"
					: "running",
			runningMs: Math.max(0, now - input.running.startedAt),
			clockSkew: skew,
			...(now - input.running.startedAt > SOURCE_REFRESH_TIMEOUT_MS
				? { uncertainty: "clock_or_suspension_possible_not_proof_of_hang" }
				: {}),
		};
	if (!input.automatic) return { state: "not_scheduled", clockSkew: skew };
	if (input.backoff && input.nextDueAt !== undefined && input.nextDueAt > now)
		return { state: "backoff", reason: input.backoff, clockSkew: skew };
	if (input.unobservedDueOverride)
		return {
			state: input.busySlots >= 2 ? "queued" : "scheduled_due_now",
			reason: "due_request_time_unknown",
			clockSkew: skew,
		};
	if (input.nextDueAt !== undefined && input.nextDueAt <= now && input.busySlots >= 2)
		return {
			state: "queued",
			reason: "shared_slot_capacity",
			queueEvidence: "derived_current_capacity",
			clockSkew: skew,
		};
	if (input.nextDueAt !== undefined && input.nextDueAt + 2_000 < now)
		return {
			state: "overdue",
			overdueMs: now - input.nextDueAt,
			clockSkew: skew,
			uncertainty: "clock_or_suspension_possible_not_proof_of_stall",
		};
	return {
		state:
			input.live?.outcome === "success"
				? "healthy"
				: input.live?.outcome === "partial"
					? "partial"
					: "scheduled_unknown",
		clockSkew: skew,
	};
}
