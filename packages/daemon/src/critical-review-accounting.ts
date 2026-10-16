/** Host-owned admission and reserve-before-send ledger. Not reachable from agent tools or HTTP. */
import { createHash } from "node:crypto";
import type {
	CriticalReviewApproval,
	CriticalReviewEffort,
	CriticalReviewReservation,
	CriticalReviewRun,
	CriticalReviewTarget,
	ReviewAllowance,
} from "@pilot/protocol";
import type { CriticalReviewDisk } from "./critical-review-disk.ts";
import type { CriticalReviewStore } from "./critical-review-store.ts";
import { canonicalJSON } from "./operation-journal.ts";

export const REVIEW_PROFILES: Readonly<Record<CriticalReviewEffort, ReviewAllowance>> = Object.freeze({
	low: { moneyMicros: 1_000_000, inputTokens: 32_000, generatedTokens: 6000, durationMs: 120_000 },
	medium: { moneyMicros: 4_000_000, inputTokens: 120_000, generatedTokens: 12_000, durationMs: 300_000 },
	high: { moneyMicros: 10_000_000, inputTokens: 300_000, generatedTokens: 24_000, durationMs: 600_000 },
	session: { moneyMicros: 4_000_000, inputTokens: 120_000, generatedTokens: 12_000, durationMs: 300_000 },
});
export interface ReviewRate {
	id: string;
	providerId: string;
	modelId: string;
	billing: "api" | "subscription";
	verifiedAt: number;
	validUntil: number;
	/** Integer micro-US dollars per million tokens. No cached-input discount assumed. */
	inputMicrosPerMillion: number;
	generatedMicrosPerMillion: number;
}
export interface ReviewProviderGates {
	providerAllowed: boolean;
	usageAllowed: boolean;
	subscriptionPaused: boolean;
}
export interface ReviewCallRequest {
	runId: string;
	approvalId: string;
	callId: string;
	rateId: string;
	phase: CriticalReviewReservation["phase"];
	inputTokens: number;
	generatedTokens: number;
	durationMs: number;
	gates: ReviewProviderGates;
}
interface Admission {
	run_id: string;
	target_key: string;
	effort: CriticalReviewEffort;
	active: number;
	started_at: number;
	approval_id: string;
	billing: string;
	escalations: number;
}
interface Charge {
	call_id: string;
	run_id: string;
	state: "reserved" | "sent" | "uncertain" | "settled";
	at: number;
	request: string;
	money: number;
	input: number;
	generated: number;
	duration: number;
}
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
function allowanceValid(value: ReviewAllowance): boolean {
	return !!value && [value.moneyMicros, value.inputTokens, value.generatedTokens, value.durationMs].every(integer);
}
function allowed(gates: ReviewProviderGates): void {
	if (gates?.providerAllowed !== true || gates.usageAllowed !== true || gates.subscriptionPaused !== false)
		throw new Error("Review provider/usage pause gate closed");
}
function price(rate: ReviewRate, input: number, generated: number): number {
	const value =
		(BigInt(input) * BigInt(rate.inputMicrosPerMillion) +
			BigInt(generated) * BigInt(rate.generatedMicrosPerMillion) +
			999_999n) /
		1_000_000n;
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Price overflow");
	return Number(value);
}
export class ReviewAccountingDisk {
	private readonly disk: CriticalReviewDisk;
	constructor(disk: CriticalReviewDisk) {
		this.disk = disk;
	}
	get db() {
		return this.disk.db;
	}
	private clock(now: number): void {
		if (!integer(now)) throw new Error("Invalid ledger clock");
		const previous = Number(
			this.db.prepare("SELECT value FROM review_ledger_meta WHERE key='clock'").get()?.value ?? 0,
		);
		if (now < previous) throw new Error("Review accounting clock moved backwards");
		this.db
			.prepare(
				"INSERT INTO review_ledger_meta VALUES('clock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
			)
			.run(now);
	}
	private require<K extends "run" | "approval" | "target">(
		kind: K,
		id: string,
		now: number,
	): K extends "run" ? CriticalReviewRun : K extends "approval" ? CriticalReviewApproval : CriticalReviewTarget {
		const record = this.disk.get(kind, id, now);
		if (!record) throw new Error(`Review ${kind} unavailable`);
		return record as never;
	}
	private approval(run: CriticalReviewRun, id: string, now: number): CriticalReviewApproval {
		const approval = this.require("approval", id, now);
		if (
			approval.action !== "app_allowance" ||
			approval.runId !== run.id ||
			approval.targetId !== run.targetId ||
			approval.evidenceId !== run.evidenceId ||
			approval.hostId !== run.hostId ||
			approval.projectId !== run.projectId ||
			approval.expiresAt <= now ||
			!allowanceValid(approval.allowance)
		)
			throw new Error("Invalid/expired structured review consent");
		return approval;
	}
	verifyRate(rate: ReviewRate, now: number): void {
		if (
			!rate ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(rate.id) ||
			!rate.providerId ||
			!rate.modelId ||
			!["api", "subscription"].includes(rate.billing) ||
			![rate.verifiedAt, rate.validUntil, rate.inputMicrosPerMillion, rate.generatedMicrosPerMillion].every(
				integer,
			) ||
			rate.verifiedAt > now ||
			rate.validUntil <= now ||
			(rate.billing === "api" && (!rate.inputMicrosPerMillion || !rate.generatedMicrosPerMillion)) ||
			(rate.billing === "subscription" && (rate.inputMicrosPerMillion || rate.generatedMicrosPerMillion))
		)
			throw new Error("Verified current pricing required");
		const body = canonicalJSON(rate);
		const existing = this.db.prepare("SELECT body FROM review_rates WHERE id=?").get(rate.id);
		if (existing && existing.body !== body) throw new Error("Immutable pricing ID conflict");
		this.db.prepare("INSERT OR IGNORE INTO review_rates VALUES(?,?)").run(rate.id, body);
	}
	admit(
		runId: string,
		approvalId: string,
		effort: CriticalReviewEffort,
		gates: ReviewProviderGates,
		now: number,
	): void {
		this.disk.transaction(() => {
			this.clock(now);
			allowed(gates);
			const run = this.require("run", runId, now);
			const approval = this.approval(run, approvalId, now);
			const target = this.require("target", run.targetId, now);
			if (!REVIEW_PROFILES[effort] || (target.snapshot.kind === "session") !== (effort === "session"))
				throw new Error("Invalid target profile");
			const key = createHash("sha256")
				.update(
					canonicalJSON([
						run.hostId,
						run.projectId,
						target.snapshot.kind,
						target.snapshot.kind === "session"
							? target.snapshot.sessionId
							: [target.snapshot.repositoryId, target.snapshot.number],
					]),
				)
				.digest("hex");
			if (
				effort !== "session" &&
				["low", "medium", "high"].indexOf(effort) < ["low", "medium", "high"].indexOf(run.effort)
			)
				throw new Error("Below trusted effort floor");
			const existing = this.db.prepare("SELECT * FROM review_admissions WHERE run_id=?").get(runId) as unknown as
				| Admission
				| undefined;
			let escalations = existing?.escalations ?? 0;
			if (existing) {
				if (existing.target_key !== key || existing.billing !== approval.billing)
					throw new Error("Retargeting or paid fallback denied");
				if (existing.effort !== effort) {
					if (
						effort === "session" ||
						existing.effort === "session" ||
						["low", "medium", "high"].indexOf(effort) <= ["low", "medium", "high"].indexOf(existing.effort) ||
						++escalations > 2
					)
						throw new Error("Only bounded upward escalation allowed");
				}
			}
			const active = this.db
				.prepare("SELECT run_id,target_key FROM review_admissions WHERE active=1 AND run_id<>?")
				.all(runId);
			if (active.length >= 2 || active.some((row) => row.target_key === key))
				throw new Error("Review concurrency limit");
			if (
				this.db
					.prepare("SELECT call_id FROM review_calls WHERE run_id=? AND state IN ('reserved','sent')")
					.get(runId)
			)
				throw new Error("Review call already in flight");
			this.db
				.prepare(
					"INSERT INTO review_admissions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET effort=excluded.effort,active=1,approval_id=excluded.approval_id,escalations=excluded.escalations",
				)
				.run(runId, key, effort, 1, run.createdAt, approvalId, approval.billing, escalations);
		});
	}
	reserve(request: ReviewCallRequest, now: number): CriticalReviewReservation {
		return this.disk.transaction(() => {
			this.clock(now);
			allowed(request.gates);
			if (
				![request.inputTokens, request.generatedTokens, request.durationMs].every(integer) ||
				!request.generatedTokens ||
				!request.durationMs ||
				!/^[A-Za-z0-9_-]{1,128}$/.test(request.callId) ||
				!["classifier", "analysis", "final", "follow_up"].includes(request.phase)
			)
				throw new Error("Invalid call bounds");
			if (this.db.prepare("SELECT value FROM review_ledger_meta WHERE key='overrun'").get())
				throw new Error("Provider overrun requires host reconciliation");
			if (this.db.prepare("SELECT call_id FROM review_calls WHERE call_id=?").get(request.callId))
				throw new Error("Call ID already reserved; never replay");
			const admission = this.db
				.prepare("SELECT * FROM review_admissions WHERE run_id=? AND active=1")
				.get(request.runId) as unknown as Admission | undefined;
			if (!admission || admission.approval_id !== request.approvalId) throw new Error("Review not admitted");
			const run = this.require("run", request.runId, now);
			const approval = this.approval(run, request.approvalId, now);
			if (!this.disk.get("evidence", run.evidenceId, now) || !this.disk.get("context", run.contextId, now))
				throw new Error("Review evidence/context unavailable");
			const row = this.db.prepare("SELECT body FROM review_rates WHERE id=?").get(request.rateId);
			if (!row) throw new Error("Verified pricing required");
			const rate = JSON.parse(row.body as string) as ReviewRate;
			this.verifyRate(rate, now);
			if (
				rate.providerId !== approval.providerId ||
				rate.modelId !== approval.modelId ||
				rate.billing !== approval.billing
			)
				throw new Error("Unapproved model/provider/fallback");
			const previous = this.db
				.prepare("SELECT * FROM review_calls WHERE run_id=?")
				.all(run.id) as unknown as Charge[];
			if (previous.some((call) => call.state === "reserved" || call.state === "sent"))
				throw new Error("One call at a time per run");
			const reserved = {
				moneyMicros: price(rate, request.inputTokens, request.generatedTokens),
				inputTokens: request.inputTokens,
				generatedTokens: request.generatedTokens,
				durationMs: request.durationMs,
			};
			const profile = REVIEW_PROFILES[admission.effort];
			const spent = previous.reduce(
				(sum, call) => ({
					moneyMicros: sum.moneyMicros + call.money,
					inputTokens: sum.inputTokens + call.input,
					generatedTokens: sum.generatedTokens + call.generated,
					durationMs: sum.durationMs + call.duration,
				}),
				{ moneyMicros: 0, inputTokens: 0, generatedTokens: 0, durationMs: 0 },
			);
			for (const key of ["moneyMicros", "inputTokens", "generatedTokens", "durationMs"] as const)
				if (spent[key] + reserved[key] > Math.min(profile[key], approval.allowance[key]))
					throw new Error(`Review total ${key} ceiling exhausted`);
			if (
				now - admission.started_at + request.durationMs >
				Math.min(profile.durationMs, approval.allowance.durationMs)
			)
				throw new Error("Review total wall-time ceiling exhausted");
			if (
				request.phase !== "final" &&
				spent.generatedTokens + reserved.generatedTokens >
					Math.floor(Math.min(profile.generatedTokens, approval.allowance.generatedTokens) * 0.85)
			)
				throw new Error("Final-output allowance reserved (15%)");
			if (
				request.phase === "classifier" &&
				(admission.effort === "session" ||
					previous.some((call) => JSON.parse(call.request).phase === "classifier") ||
					request.inputTokens > 12_000 ||
					request.generatedTokens > 1200 ||
					request.durationMs > 15_000 ||
					reserved.moneyMicros > 100_000)
			)
				throw new Error("Classifier ceiling or retry denied");
			const recent = this.db
				.prepare("SELECT * FROM review_calls WHERE at>? OR state IN ('reserved','sent','uncertain')")
				.all(now - 86400_000) as unknown as Charge[];
			if (
				recent.reduce((s, c) => s + c.money, reserved.moneyMicros) > 20_000_000 ||
				recent.reduce((s, c) => s + c.input, reserved.inputTokens) > 600_000 ||
				recent.reduce((s, c) => s + c.generated, reserved.generatedTokens) > 48_000
			)
				throw new Error("Shared rolling-24h review ceiling exhausted");
			const record: CriticalReviewReservation = {
				schemaVersion: 1,
				kind: "reservation",
				id: request.callId,
				hostId: run.hostId,
				projectId: run.projectId,
				sourceIds: run.sourceIds,
				createdAt: now,
				runId: run.id,
				approvalId: approval.id,
				callId: request.callId,
				rateId: rate.id,
				phase: request.phase,
				reserved,
			};
			this.disk.insert(record);
			this.db
				.prepare("INSERT INTO review_calls VALUES(?,?, 'reserved',?,?,?,?,?,?)")
				.run(
					request.callId,
					run.id,
					now,
					canonicalJSON(request),
					reserved.moneyMicros,
					reserved.inputTokens,
					reserved.generatedTokens,
					reserved.durationMs,
				);
			return record;
		});
	}
	send(callId: string, gates: ReviewProviderGates, now: number): void {
		this.disk.transaction(() => {
			this.clock(now);
			allowed(gates);
			const call = this.db.prepare("SELECT * FROM review_calls WHERE call_id=?").get(callId) as unknown as
				| Charge
				| undefined;
			if (call?.state !== "reserved") throw new Error("Call not sendable; no replay");
			const request = JSON.parse(call.request) as ReviewCallRequest;
			const run = this.require("run", call.run_id, now);
			const approval = this.approval(run, request.approvalId, now);
			const admission = this.db
				.prepare("SELECT * FROM review_admissions WHERE run_id=? AND active=1")
				.get(run.id) as unknown as Admission | undefined;
			if (
				!admission ||
				admission.approval_id !== approval.id ||
				now - admission.started_at + request.durationMs >
					Math.min(REVIEW_PROFILES[admission.effort].durationMs, approval.allowance.durationMs)
			)
				throw new Error("Review send deadline exhausted");
			const rate = JSON.parse(
				this.db.prepare("SELECT body FROM review_rates WHERE id=?").get(request.rateId)!.body as string,
			) as ReviewRate;
			this.verifyRate(rate, now);
			if (!this.disk.get("evidence", run.evidenceId, now) || !this.disk.get("context", run.contextId, now))
				throw new Error("Review evidence/context unavailable");
			if (request.phase === "classifier" && now - call.at + request.durationMs > 30_000)
				throw new Error("Classifier stage deadline exhausted");
			this.db.prepare("UPDATE review_calls SET state='sent' WHERE call_id=?").run(callId);
		});
	}
	settle(
		callId: string,
		usage: { inputTokens: number; generatedTokens: number; durationMs: number } | undefined,
	): void {
		this.disk.transaction(() => {
			const call = this.db.prepare("SELECT * FROM review_calls WHERE call_id=?").get(callId) as unknown as
				| Charge
				| undefined;
			if (!call) throw new Error("Unknown call");
			if (!usage) {
				if (call.state !== "settled")
					this.db.prepare("UPDATE review_calls SET state='uncertain' WHERE call_id=?").run(callId);
				return;
			}
			if (![usage.inputTokens, usage.generatedTokens, usage.durationMs].every(integer))
				throw new Error("Invalid provider receipt");
			const request = JSON.parse(call.request) as ReviewCallRequest;
			const rate = JSON.parse(
				this.db.prepare("SELECT body FROM review_rates WHERE id=?").get(request.rateId)!.body as string,
			) as ReviewRate;
			const money = price(rate, usage.inputTokens, usage.generatedTokens);
			if (call.state === "settled") {
				if (
					call.money !== money ||
					call.input !== usage.inputTokens ||
					call.generated !== usage.generatedTokens ||
					call.duration !== usage.durationMs
				)
					throw new Error("Usage receipt conflict");
				return;
			}
			if (call.state === "reserved") throw new Error("Cannot refund an unsent reservation");
			if (
				usage.inputTokens > request.inputTokens ||
				usage.generatedTokens > request.generatedTokens ||
				usage.durationMs > request.durationMs
			)
				this.db.prepare("INSERT OR REPLACE INTO review_ledger_meta VALUES('overrun',1)").run();
			this.db
				.prepare("UPDATE review_calls SET state='settled',money=?,input=?,generated=?,duration=? WHERE call_id=?")
				.run(money, usage.inputTokens, usage.generatedTokens, usage.durationMs, callId);
		});
	}
	finish(runId: string): void {
		if (
			this.db.prepare("SELECT call_id FROM review_calls WHERE run_id=? AND state IN ('reserved','sent')").get(runId)
		)
			throw new Error("Unsettled call");
		this.db.prepare("UPDATE review_admissions SET active=0 WHERE run_id=?").run(runId);
	}
	recover(): void {
		this.disk.transaction(() => {
			this.db.exec(
				"UPDATE review_calls SET state='uncertain' WHERE state IN ('reserved','sent'); UPDATE review_admissions SET active=0;",
			);
		});
	}
}

/** App-side trusted adapter must authenticate owner/scope before calling these host primitives. */
export class ReviewAccounting {
	private readonly store: CriticalReviewStore;
	constructor(store: CriticalReviewStore) {
		this.store = store;
	}
	onPrivateInvalidation(listener: () => void): () => void {
		return this.store.onPrivateInvalidation(listener);
	}
	grant(approval: CriticalReviewApproval): Promise<CriticalReviewApproval> {
		return this.store.put(approval);
	}
	verifyRate(rate: ReviewRate): Promise<void> {
		return this.store.rpc("verifyRate", { rate });
	}
	admit(runId: string, approvalId: string, effort: CriticalReviewEffort, gates: ReviewProviderGates): Promise<void> {
		return this.store.rpc("admit", { runId, approvalId, effort, gates });
	}
	reserve(request: ReviewCallRequest): Promise<CriticalReviewReservation> {
		return this.store.rpc("reserve", { request });
	}
	send(callId: string, gates: ReviewProviderGates): Promise<void> {
		return this.store.rpc("send", { callId, gates });
	}
	settle(callId: string, usage?: { inputTokens: number; generatedTokens: number; durationMs: number }): Promise<void> {
		return this.store.rpc("settle", { callId, usage });
	}
	finish(runId: string): Promise<void> {
		return this.store.rpc("finishRun", { runId });
	}
	recover(): Promise<void> {
		return this.store.rpc("recoverAccounting");
	}
}
