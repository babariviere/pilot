/** Host-private linkage in the existing review worker. No provider, HTTP or gate. */
import { createHash } from "node:crypto";
import type { CriticalReviewEffort, CriticalReviewRetainedRecord, CriticalReviewRun } from "@pilot/protocol";
import { REVIEW_PROFILES, type ReviewProviderGates } from "./critical-review-accounting.ts";
import type { CriticalReviewDisk } from "./critical-review-disk.ts";
import { canonicalJSON } from "./operation-journal.ts";
import type { PreparedRetainedReviewInput } from "./retained-review-contract.ts";
import {
	compareRetainedReviewClaims,
	compareRetainedReviewTargetInput,
	retainedReviewLinkageDigest as digest,
	parseRetainedReviewCallClaim,
	parseRetainedReviewCompletionClaim,
	parseRetainedReviewRunBindingClaim,
	parseRetainedReviewTargetClaim,
	parseRetainedReviewUsageClaim,
	type RetainedReviewCallClaim,
	type RetainedReviewCompletionClaim,
	type RetainedReviewRunBindingClaim,
	type RetainedReviewTargetClaim,
	type RetainedReviewUsageClaim,
} from "./retained-review-linkage-contract.ts";
import type { WorkflowConfirmationRecord } from "./workflow-confirmation-store.ts";

export const RETAINED_RUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_retained_runs (
 run_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, host_id TEXT NOT NULL, mission_id TEXT NOT NULL,
 task_id TEXT NOT NULL, logical_task_id TEXT NOT NULL, channel_generation TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
 executor_exit TEXT, terminal_id TEXT, conflict INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS review_retained_budget ON review_retained_runs(host_id,mission_id,logical_task_id);
CREATE TABLE IF NOT EXISTS review_retained_aliases (
 host_id TEXT NOT NULL, task_id TEXT NOT NULL, mission_id TEXT NOT NULL, logical_task_id TEXT NOT NULL,
 PRIMARY KEY(host_id,task_id)
);
CREATE TABLE IF NOT EXISTS review_retained_events (
 kind TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL, record_id TEXT NOT NULL,
 PRIMARY KEY(kind,id)
);
CREATE TABLE IF NOT EXISTS review_retained_receipts (
 source TEXT NOT NULL, identity TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(source,identity)
);`;

export interface RetainedRunAdmission {
	version: 1;
	target: RetainedReviewTargetClaim;
	binding: RetainedReviewRunBindingClaim;
	input: PreparedRetainedReviewInput;
	consent: WorkflowConfirmationRecord;
	/** Resolved by the host. Unknown replacement/transfer history MUST refuse, not default to taskId. */
	logicalTaskId: string;
	/** No new effort default or automatic escalation. */
	effort: Exclude<CriticalReviewEffort, "session">;
}
interface RunRow {
	run_id: string;
	binding_id: string;
	host_id: string;
	mission_id: string;
	task_id: string;
	logical_task_id: string;
	channel_generation: string;
	closed: number;
	executor_exit: string | null;
	terminal_id: string | null;
	conflict: number;
}
type Event = RetainedReviewCallClaim | RetainedReviewUsageClaim | RetainedReviewCompletionClaim;
export interface RetainedRunCompletion {
	claim: RetainedReviewCompletionClaim;
	rawBase64: string | null;
}
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const id = (v: string) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);

export class RetainedReviewRunDisk {
	private readonly disk: CriticalReviewDisk;
	constructor(disk: CriticalReviewDisk) {
		this.disk = disk;
	}
	private row(runId: string): RunRow | undefined {
		return this.disk.db.prepare("SELECT * FROM review_retained_runs WHERE run_id=?").get(runId) as unknown as
			| RunRow
			| undefined;
	}
	private record<T>(recordId: string, now: number): T {
		const record = this.disk.get("retained", recordId, now) as CriticalReviewRetainedRecord | undefined;
		if (!record) throw new Error("Retained run content unavailable");
		return JSON.parse(record.payload) as T;
	}
	admission(runId: string, now: number): RetainedRunAdmission {
		const row = this.row(runId);
		if (!row) throw new Error("Unknown retained run");
		return this.record<RetainedRunAdmission>(row.binding_id, now);
	}
	private append(
		run: CriticalReviewRun,
		entry: CriticalReviewRetainedRecord["entry"],
		payload: unknown,
		now: number,
	): string {
		const body = canonicalJSON(payload);
		if (Buffer.byteLength(body) > 256 * 1024) throw new Error("Retained linkage payload exceeds limit");
		const recordId = hash(canonicalJSON(["retained-host-journal", 1, run.id, entry, payload]));
		this.disk.insert({
			schemaVersion: 1,
			kind: "retained",
			id: recordId,
			hostId: run.hostId,
			projectId: run.projectId,
			sourceIds: run.sourceIds,
			createdAt: now,
			runId: run.id,
			entry,
			payload: body,
		});
		return recordId;
	}
	private run(runId: string, now: number): CriticalReviewRun {
		const run = this.disk.get("run", runId, now);
		if (run?.kind !== "run") throw new Error("Retained run unavailable");
		return run;
	}
	/** Existing generic accounting cannot admit/reserve/send a retained run without this binding. */
	capacity(runId: string): void {
		// Preserve legacy session/PR admission behavior when no retained executor owns capacity.
		if (!this.disk.db.prepare("SELECT run_id FROM review_retained_runs WHERE executor_exit IS NULL LIMIT 1").get())
			return;
		const count = this.disk.db
			.prepare(`SELECT COUNT(*) n FROM (
		 SELECT run_id FROM review_retained_runs WHERE executor_exit IS NULL
		 UNION SELECT run_id FROM review_admissions WHERE active=1
		) WHERE run_id<>?`)
			.get(runId)!;
		if (Number(count.n) >= 2) throw new Error("Physical reviewer capacity unavailable; executor exit is unconfirmed");
	}
	sendable(runId: string, now: number): void {
		const row = this.row(runId);
		if (!row || row.closed || row.conflict || row.executor_exit)
			throw new Error("Retained run closed or quarantined");
		const a = this.admission(runId, now);
		this.capacity(runId);
		if (a.consent.confirmed.package.disclosure!.expiresAt <= now) throw new Error("Retained consent expired");
		const active = this.disk.db
			.prepare(
				"SELECT run_id,host_id,mission_id,logical_task_id FROM review_retained_runs WHERE executor_exit IS NULL AND run_id<>?",
			)
			.all(runId);
		if (
			active.length >= 2 ||
			active.some(
				(r) =>
					r.host_id === row.host_id &&
					r.mission_id === row.mission_id &&
					r.logical_task_id === row.logical_task_id,
			)
		)
			throw new Error("Physical reviewer capacity unavailable; executor exit is unconfirmed");
	}
	checkRun(runId: string, now: number): void {
		const run = this.run(runId, now);
		const target = this.disk.get("target", run.targetId, now);
		if (target?.kind !== "target") throw new Error("Review target unavailable");
		if (target.snapshot.kind === "retained-non-code") this.sendable(runId, now);
	}
	checkApproval(runId: string, approvalId: string, now: number): void {
		if (this.row(runId) && this.admission(runId, now).binding.admissionId !== approvalId)
			throw new Error("Cannot replace exact retained consent with another allowance");
	}
	ceiling(runId: string, money: number): void {
		const row = this.row(runId);
		if (!row) return;
		const totals = this.disk.db
			.prepare(`SELECT COALESCE(SUM(c.money),0) mission,
		 COALESCE(SUM(CASE WHEN r.logical_task_id=? THEN c.money ELSE 0 END),0) task
		 FROM review_calls c JOIN review_retained_runs r ON r.run_id=c.run_id WHERE r.host_id=? AND r.mission_id=?`)
			.get(row.logical_task_id, row.host_id, row.mission_id)!;
		if (Number(totals.task) + money > 4_000_000 || Number(totals.mission) + money > 20_000_000)
			throw new Error("Cumulative retained task/mission ceiling exhausted");
	}
	admit(value: RetainedRunAdmission, gates: ReviewProviderGates, now: number): void {
		const a = structuredClone(value);
		a.target = parseRetainedReviewTargetClaim(a.target);
		a.binding = parseRetainedReviewRunBindingClaim(a.target, a.binding);
		const { target: t, binding: b, consent: c } = a;
		const account = b.account;
		if (account.kind !== "claimed") throw new Error("Retained account binding mismatch");
		const p = c.confirmed.package,
			d = p.disclosure;
		if (
			a.version !== 1 ||
			!id(a.logicalTaskId) ||
			!["low", "medium", "high"].includes(a.effort) ||
			!compareRetainedReviewTargetInput(t, b, a.input) ||
			b.account.kind !== "claimed" ||
			b.account.configSha256 !== a.input.descriptor.runtime.configSha256 ||
			c.kind !== "review-consent" ||
			c.confirmed.purpose !== "review-consent" ||
			p.purpose !== "review-consent" ||
			c.missionId !== t.missionId ||
			p.missionId !== t.missionId ||
			p.projectId !== t.projectId ||
			p.coordinatorSessionId !== t.coordinatorSessionId ||
			!d ||
			d.expiresAt <= now ||
			d.provider !== b.provider ||
			d.model !== b.model ||
			d.account !== b.account.bindingId ||
			d.configurationRevision !== b.configObservationId ||
			d.missionLimitMicros !== 20_000_000 ||
			d.logicalTaskLimitMicros !== 4_000_000 ||
			d.cumulativeAcrossRechecks !== true ||
			d.refillOnReplacement !== false ||
			d.paidFallback !== false
		)
			throw new Error("Retained consent/config/input binding mismatch");
		const runId = b.runId;
		this.disk.transaction(() => {
			// A copied/rebound ledger must not acquire a fresh host namespace and zero balance.
			const knownHost = this.disk.db.prepare("SELECT host_id FROM review_retained_runs LIMIT 1").get();
			if (knownHost && knownHost.host_id !== t.hostId)
				throw new Error("Retained cross-host transfer is unsupported");
			const existing = this.row(runId);
			if (existing) {
				if (canonicalJSON(this.admission(runId, now)) !== canonicalJSON(a))
					throw new Error("Immutable retained admission conflict");
				this.sendable(runId, now);
				return;
			}
			if (Number(this.disk.db.prepare("SELECT COUNT(*) n FROM review_retained_runs").get()!.n) >= 10_000)
				throw new Error("Retained ledger capacity reached; no automatic eviction");
			const alias = this.disk.db
				.prepare("SELECT mission_id,logical_task_id FROM review_retained_aliases WHERE host_id=? AND task_id=?")
				.get(t.hostId, t.taskId);
			if (alias && (alias.mission_id !== t.missionId || alias.logical_task_id !== a.logicalTaskId))
				throw new Error("Task transfer/replacement accounting unresolved");
			const evidence = this.disk.get("evidence", b.evidenceId, now),
				context = this.disk.get("context", b.contextId, now);
			if (
				!evidence ||
				!context ||
				evidence.hostId !== t.hostId ||
				context.hostId !== t.hostId ||
				evidence.projectId !== t.projectId ||
				context.projectId !== t.projectId ||
				canonicalJSON(evidence) !== canonicalJSON(a.input.descriptor.manifest)
			)
				throw new Error("Actual sealed evidence/context unavailable or mismatched");
			const base = {
				schemaVersion: 1 as const,
				hostId: t.hostId,
				projectId: t.projectId,
				sourceIds: [...new Set([...evidence.sourceIds, ...context.sourceIds])],
				createdAt: now,
			};
			this.disk.insert({
				...base,
				kind: "target",
				id: t.targetId,
				snapshot: {
					kind: "retained-non-code",
					missionId: t.missionId,
					taskId: t.taskId,
					logicalTaskId: a.logicalTaskId,
					targetSha256: digest("target", t),
				},
			});
			const run: CriticalReviewRun = {
				...base,
				kind: "run",
				id: runId,
				targetId: t.targetId,
				evidenceId: b.evidenceId,
				contextId: b.contextId,
				state: "queued",
				effort: a.effort,
				modelId: b.model,
				policyVersion: context.kind === "context" ? context.policyVersion : "",
				limits: [],
			};
			this.disk.insert(run);
			this.disk.insert({
				...base,
				kind: "approval",
				id: b.admissionId,
				ownerId: t.coordinatorSessionId,
				runId,
				targetId: t.targetId,
				evidenceId: b.evidenceId,
				action: "app_allowance",
				providerId: b.provider,
				modelId: b.model,
				billing: account.billing,
				allowance: {
					...REVIEW_PROFILES[a.effort],
					moneyMicros: Math.min(4_000_000, REVIEW_PROFILES[a.effort].moneyMicros),
				},
				expiresAt: d.expiresAt,
			});
			const bindingId = this.append(run, "binding", a, now);
			this.disk.db
				.prepare("INSERT INTO review_retained_aliases VALUES(?,?,?,?) ON CONFLICT DO NOTHING")
				.run(t.hostId, t.taskId, t.missionId, a.logicalTaskId);
			this.disk.db
				.prepare(
					"INSERT INTO review_retained_runs(run_id,binding_id,host_id,mission_id,task_id,logical_task_id,channel_generation) VALUES(?,?,?,?,?,?,?)",
				)
				.run(runId, bindingId, t.hostId, t.missionId, t.taskId, a.logicalTaskId, b.channelGeneration);
			this.sendable(runId, now);
		});
		// Interrupted admission can only be retried with these exact immutable pins. It sends nothing.
		this.disk.accounting.admit(runId, b.admissionId, a.effort, gates, now);
	}
	private events<T>(runId: string, kind: string, now: number): T[] {
		return this.disk.db
			.prepare("SELECT record_id FROM review_retained_events WHERE run_id=? AND kind=? ORDER BY rowid")
			.all(runId, kind)
			.map((r) => this.record<T>(String(r.record_id), now));
	}
	private call(runId: string, callId: string): { state: string; request: string } {
		const call = this.disk.db
			.prepare("SELECT state,request FROM review_calls WHERE run_id=? AND call_id=?")
			.get(runId, callId);
		if (!call || call.state === "reserved") throw new Error("No claimed send for this run/call");
		return call as unknown as { state: string; request: string };
	}
	/** Conflicting callbacks quarantine durably. They never overwrite/refund the accepted observation. */
	observe(
		kind: "call" | "usage" | "completion",
		value: Event,
		rawBase64: string | null,
		now: number,
		channelGeneration: string,
	): { conflict: boolean } {
		const a = this.admission(value.runId, now),
			b = a.binding;
		if (channelGeneration !== b.channelGeneration) throw new Error("Retained callback channel mismatch");
		let v: Event;
		const calls = this.events<RetainedReviewCallClaim>(b.runId, "call", now);
		const usages = this.events<RetainedReviewUsageClaim>(b.runId, "usage", now);
		if (kind === "call") v = parseRetainedReviewCallClaim(b, value);
		else if (kind === "usage") {
			const c = calls.find((c) => c.callId === (value as RetainedReviewUsageClaim).callId);
			if (!c) throw new Error("Usage has no bound call observation");
			v = parseRetainedReviewUsageClaim(b, c, value);
			const call = this.call(b.runId, v.callId),
				request = JSON.parse(call.request);
			const rate = JSON.parse(
				String(this.disk.db.prepare("SELECT body FROM review_rates WHERE id=?").get(request.rateId)!.body),
			);
			if (hash(canonicalJSON(rate)) !== v.rateSha256) throw new Error("Usage rate binding mismatch");
		} else v = parseRetainedReviewCompletionClaim(b, calls, usages, value);
		const eventId = v.kind === "retained-completion" ? v.completionId : v.observationId;
		if (v.kind !== "retained-completion") this.call(b.runId, v.callId);
		if (v.kind === "retained-completion") {
			if (v.terminalCallId !== null) this.call(b.runId, v.terminalCallId);
			if (v.raw.kind === "bytes") {
				if (rawBase64 !== null && rawBase64.length > Math.ceil((50 * 1024) / 3) * 4)
					throw new Error("Retained report exceeds byte limit");
				const bytes = rawBase64 === null ? null : Buffer.from(rawBase64, "base64");
				if (
					!bytes ||
					bytes.toString("base64") !== rawBase64 ||
					bytes.length !== v.raw.length ||
					hash(bytes) !== v.raw.sha256
				)
					throw new Error("Exact completion bytes mismatch");
			} else if (rawBase64 !== null) throw new Error("Unexpected completion bytes");
		}
		return this.disk.transaction(() => {
			const row = this.row(b.runId)!;
			// Exact retries cannot authorize settlement or a positive callback after quarantine.
			if (row.conflict) throw new Error("Retained run quarantined");
			const previous = this.disk.db
				.prepare("SELECT record_id FROM review_retained_events WHERE kind=? AND id=?")
				.get(kind, eventId);
			const payload = kind === "completion" ? { claim: v, rawBase64 } : v;
			if (previous && canonicalJSON(this.record(String(previous.record_id), now)) === canonicalJSON(payload))
				return { conflict: false };
			const receipt =
				v.kind === "retained-usage"
					? this.disk.db
							.prepare("SELECT record_id FROM review_retained_receipts WHERE source=? AND identity=?")
							.get(v.receiptSource, v.receiptIdentity)
					: undefined;
			const conflict =
				!!previous ||
				!!receipt ||
				(kind === "completion" && !!row.terminal_id) ||
				(kind === "usage" && usages.some((u) => compareRetainedReviewClaims("usage", u, v) === "conflict"));
			if (conflict) {
				this.append(this.run(b.runId, now), "conflict", { kind, value: v }, now);
				this.disk.db.prepare("UPDATE review_retained_runs SET conflict=1,closed=1 WHERE run_id=?").run(b.runId);
				return { conflict: true };
			}
			// Revocation/recovery never restores output. Late usage can still reconcile a conservative charge.
			if (kind === "completion" && row.closed) throw new Error("Late output from a closed retained run");
			if (
				Number(
					this.disk.db
						.prepare("SELECT COUNT(*) n FROM review_retained_events WHERE run_id=? AND kind=?")
						.get(b.runId, kind)!.n,
				) >= 32
			)
				throw new Error("Retained run observation capacity reached");
			const recordId = this.append(this.run(b.runId, now), kind, payload, now);
			this.disk.db
				.prepare("INSERT INTO review_retained_events VALUES(?,?,?,?)")
				.run(kind, eventId, b.runId, recordId);
			if (v.kind === "retained-usage")
				this.disk.db
					.prepare("INSERT INTO review_retained_receipts VALUES(?,?,?)")
					.run(v.receiptSource, v.receiptIdentity, recordId);
			if (kind === "completion") {
				this.disk.db
					.prepare("UPDATE review_retained_runs SET terminal_id=?,closed=2 WHERE run_id=?")
					.run(eventId, b.runId);
				// Same transaction: conservative unknown usage and ledger release, NOT executor exit.
				this.disk.db
					.prepare("UPDATE review_calls SET state='uncertain' WHERE run_id=? AND state IN ('reserved','sent')")
					.run(b.runId);
				this.disk.db.prepare("UPDATE review_admissions SET active=0 WHERE run_id=?").run(b.runId);
			}
			return { conflict: false };
		});
	}
	settleObservation(value: RetainedReviewUsageClaim, now: number, channelGeneration: string): void {
		// Observation commit precedes settlement. Exact replay can finish an interrupted settlement.
		const result = this.observe("usage", value, null, now, channelGeneration);
		if (result.conflict) throw new Error("Retained usage conflict; quarantined");
		this.disk.accounting.settle(
			value.callId,
			{
				inputTokens: value.input,
				generatedTokens: value.generated,
				durationMs: value.durationMs,
			},
			true,
		);
	}
	reconcileUsage(now: number): void {
		for (const row of this.disk.db
			.prepare(`SELECT e.record_id FROM review_retained_events e
		 JOIN review_retained_runs r ON r.run_id=e.run_id WHERE e.kind='usage' AND r.conflict=0`)
			.all()) {
			const record = this.disk.get("retained", String(row.record_id), now) as
				| CriticalReviewRetainedRecord
				| undefined;
			if (!record) continue; // Erasure never reopens content, nor refunds its conservative charge.
			const v = JSON.parse(record.payload) as RetainedReviewUsageClaim;
			this.disk.accounting.settle(
				v.callId,
				{
					inputTokens: v.input,
					generatedTokens: v.generated,
					durationMs: v.durationMs,
				},
				true,
			);
		}
	}
	completion(runId: string, now: number): RetainedRunCompletion | undefined {
		const row = this.row(runId);
		if (row?.closed !== 2 || row.conflict) return undefined;
		return this.events<RetainedRunCompletion>(runId, "completion", now)[0];
	}
	revoke(runId: string): void {
		this.disk.db.prepare("UPDATE review_retained_runs SET closed=3 WHERE run_id=?").run(runId);
	}
	exited(runId: string, observation: string, channelGeneration: string): void {
		if (!id(observation)) throw new Error("Exact executor exit observation required");
		this.disk.transaction(() => {
			const row = this.row(runId);
			if (!row?.closed) throw new Error("Cannot release a running executor");
			if (row.channel_generation !== channelGeneration) throw new Error("Retained executor exit channel mismatch");
			if (row.executor_exit && row.executor_exit !== observation)
				throw new Error("Executor exit observation conflict");
			this.disk.db.prepare("UPDATE review_retained_runs SET executor_exit=? WHERE run_id=?").run(observation, runId);
		});
	}
}
