/** Bounded content-free observations, never an executor, queue or retry policy. */

import { createHash } from "node:crypto";
import type { MissionLinearSync, RefreshReason, TrackedKind } from "@pilot/protocol";
import { SourceRateLimited, SourceSignInRequired } from "./source-mcp.ts";

export type BackgroundJob =
	| "linked_linear_sync"
	| "manual_lookup"
	| "slack_done_write"
	| "triage_rebuild"
	| "linear_parent_header";
export type JobOutcome = "success" | "no_work" | "skipped" | "partial" | "failure" | "cancelled" | "backoff";
export type JobStage =
	| NonNullable<MissionLinearSync["failure"]>["stage"]
	| "lookup"
	| "reserve"
	| "classification"
	| "commit"
	| "remove_eyes"
	| "eligibility";
export type JobReason =
	| RefreshReason
	| NonNullable<MissionLinearSync["failure"]>["category"]
	| "shared_slot_capacity"
	| "eligibility"
	| "cooldown"
	| "superseded";
export interface JobObservation {
	job: BackgroundJob;
	kind: TrackedKind;
	projectId?: string;
	queuedAt?: number;
	nextDueAt?: number;
	startedAt?: number;
	completedAt?: number;
	queued?: boolean;
	stage?: JobStage;
	stageStartedAt?: number;
	stageCompletedAt?: number;
	outcome?: JobOutcome;
	reason?: JobReason;
	count?: number;
	readCalls: number;
	writeCalls: number;
	failure?: NonNullable<MissionLinearSync["failure"]>;
	recent?: Array<{
		at: number;
		outcome: JobOutcome;
		reason?: JobReason;
		stage?: JobStage;
		readCalls: number;
		writeCalls: number;
		count?: number;
	}>;
}
export interface JobToken {
	id: string;
	key: string;
	sequence: number;
}
export class BackgroundJobDiagnostics {
	private enabled = true;
	private sequence = 0;
	private readonly records = new Map<
		string,
		{ key: string; sequence: number; completionSequence?: number; value: JobObservation }
	>();
	private readonly installed = new Set<string>();
	private dropped = 0;
	register(job: BackgroundJob, kind: TrackedKind): void {
		this.installed.add(`${job}:${kind}`);
	}
	setEnabled(value: boolean): void {
		if (this.enabled !== value) {
			this.enabled = value;
			this.clear();
		}
	}
	clear(): void {
		this.records.clear();
		this.dropped = 0;
	}
	coverage() {
		return { enabled: this.enabled, limit: 256, dropped: this.dropped, retention: "current_process_latest_per_job" };
	}
	private id(job: BackgroundJob, kind: TrackedKind, projectId?: string): string {
		return JSON.stringify([job, kind, projectId ?? null]);
	}
	private reserve(job: BackgroundJob, kind: TrackedKind, projectId: string | undefined, key: string) {
		const id = this.id(job, kind, projectId);
		let record = this.records.get(id);
		if (!record || record.key !== key) {
			if (!record && this.records.size >= 256) {
				this.records.delete(this.records.keys().next().value!);
				this.dropped = Math.min(1_000_000, this.dropped + 1);
			}
			record = {
				key,
				sequence: ++this.sequence,
				value: { job, kind, ...(projectId ? { projectId } : {}), readCalls: 0, writeCalls: 0 },
			};
			this.records.set(id, record);
		}
		return { id, record };
	}
	queue(job: BackgroundJob, kind: TrackedKind, projectId: string | undefined, key: string, nextDueAt?: number): void {
		if (!this.enabled) return;
		const { record } = this.reserve(job, kind, projectId, key);
		record.value.queuedAt ??= Date.now();
		record.value.queued = true;
		record.value.nextDueAt = nextDueAt;
	}
	begin(job: BackgroundJob, kind: TrackedKind, projectId: string | undefined, key: string): JobToken {
		if (!this.enabled) return { id: "", key, sequence: -1 };
		const { id, record } = this.reserve(job, kind, projectId, key);
		record.sequence = ++this.sequence;
		record.value = {
			job,
			kind,
			...(projectId ? { projectId } : {}),
			queuedAt: record.value.queuedAt,
			startedAt: Date.now(),
			queued: false,
			readCalls: 0,
			writeCalls: 0,
			recent: record.value.recent,
		};
		return { id, key, sequence: record.sequence };
	}
	private record(token: JobToken) {
		const record = this.records.get(token.id);
		return this.enabled && record?.key === token.key && record.sequence === token.sequence ? record : undefined;
	}
	stage(token: JobToken, stage: JobStage, write?: boolean): void {
		const record = this.record(token);
		if (!record) return;
		record.value.stage = stage;
		record.value.stageStartedAt = Date.now();
		delete record.value.stageCompletedAt;
		delete record.value.completedAt;
		if (write) record.value.writeCalls = Math.min(1_000_000, record.value.writeCalls + 1);
		else if (write === false) record.value.readCalls = Math.min(1_000_000, record.value.readCalls + 1);
	}
	progress(token: JobToken): void {
		const record = this.record(token);
		if (record) record.value.stageCompletedAt = Date.now();
	}
	failure(token: JobToken, failure: NonNullable<MissionLinearSync["failure"]>): void {
		const record = this.record(token);
		if (record) record.value.failure = { stage: failure.stage, category: failure.category };
	}
	end(token: JobToken, outcome: JobOutcome, reason?: JobReason, count?: number, nextDueAt?: number): void {
		const record = this.record(token);
		if (!record) return;
		Object.assign(record.value, { completedAt: Date.now(), outcome, reason });
		if (nextDueAt !== undefined) record.value.nextDueAt = nextDueAt;
		if (Number.isSafeInteger(count) && count! >= 0 && count! <= 1_000_000) record.value.count = count;
		const recent = record.value.recent ?? [];
		record.value.recent = [
			...(record.completionSequence === token.sequence ? recent.slice(0, -1) : recent),
			{
				at: Date.now(),
				outcome,
				reason,
				stage: record.value.stage,
				readCalls: record.value.readCalls,
				writeCalls: record.value.writeCalls,
				count: record.value.count,
			},
		].slice(-4);
		record.completionSequence = token.sequence;
	}
	prune(current: (projectId: string, kind: TrackedKind, job: BackgroundJob) => string | undefined): void {
		for (const [id, record] of this.records)
			if (
				record.value.projectId &&
				current(record.value.projectId, record.value.kind, record.value.job) !== record.key
			)
				this.records.delete(id);
	}
	read(job: BackgroundJob, kind: TrackedKind, projectId: string | undefined, key: string) {
		const installed = this.installed.has(`${job}:${kind}`);
		const record = this.records.get(this.id(job, kind, projectId));
		const observation = this.enabled && record?.key === key ? structuredClone(record.value) : undefined;
		return {
			job,
			kind,
			...(projectId ? { projectId } : {}),
			installed,
			cadence:
				job === "manual_lookup"
					? "user_triggered"
					: job === "linked_linear_sync"
						? "event_and_bounded_timer"
						: "event_driven",
			state: !this.enabled
				? "disabled"
				: !installed
					? "not_installed"
					: observation?.startedAt !== undefined && observation.completedAt === undefined
						? "running"
						: observation?.queued
							? observation.nextDueAt !== undefined && observation.nextDueAt > Date.now()
								? "deferred"
								: "queued"
							: observation?.nextDueAt !== undefined && observation.nextDueAt > Date.now()
								? "deferred"
								: (observation?.outcome ?? "idle_unobserved"),
			observation,
			applicability:
				job === "linked_linear_sync"
					? "managed_linked_missions_only_not_source_poll_eligibility"
					: job === "triage_rebuild"
						? "corrections_or_cases_when_eligible"
						: job === "slack_done_write"
							? "durably_reserved_done_items_only"
							: "explicit_lookup_only",
			quota:
				job === "slack_done_write"
					? "provider_limits_and_shared_slots_not_local_source_read_budget"
					: job === "triage_rebuild"
						? "grooming_cooldown_not_source_classification_quota"
						: "provider_limits_not_source_poll_quota",
			liveness: "Only observed events establish progress. Idle/event-driven work is not a failed scheduler.",
		};
	}
}

export function jobFailureReason(error: unknown, signal?: AbortSignal): JobReason {
	if (signal?.aborted)
		return signal.reason?.message === "Superseded by a newer lookup"
			? "superseded"
			: /timed out/.test(signal.reason?.message ?? "")
				? "timeout"
				: "stopped";
	if (error instanceof SourceRateLimited) return "provider_rate_limit";
	if (error instanceof SourceSignInRequired) return "sign_in";
	return "read_failed";
}
export function jobConfigurationKey(config: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(config ?? {}))
		.digest("hex");
}
