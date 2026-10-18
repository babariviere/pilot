/** Durable, aggregate-only AI accounting. Raw provider/model/tool keys never leave the kernel. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { KernelUsage } from "@pilot/kernel";
import type { AIUsageAccounting, AIUsageActivity, AIUsageCost, AIUsageScope, AIUsageTokens } from "@pilot/protocol";
import { nodeTelemetry, type TelemetryAttributes } from "@pilot/telemetry";
import { durableJSON } from "./operation-journal.ts";

export const AI_USAGE_FILE = "ai-usage.json";
export const AI_USAGE_SCHEMA_VERSION = 1 as const;
export const MAX_AI_USAGE_CONVERSATIONS = 32;
export const MAX_AI_USAGE_TIMING_BOOTS = 4;
export const MAX_AI_USAGE_FILE_BYTES = 128 * 1024;
const CONVERSATION = /^(?:0|[1-9][0-9]{0,15})$/;
const ACTIVITY_EPOCH = /^(?:initial|0|[1-9][0-9]{0,15})$/;
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRICING = /^pi-ai@[0-9]+(?:\.[0-9]+){2}(?:[-+][a-zA-Z0-9.-]+)?$/;

type Timing = Pick<AIUsageActivity, "providerAttemptsObserved" | "elapsedMsObserved" | "activeMsObserved">;
type Outcomes = Pick<AIUsageActivity, "count" | "success" | "failure" | "cancelled" | "usageReports">;
type TimeCounters = Pick<StoredState["time"], "activeMs" | "pausedMs" | "idleMs">;

interface StoredScope {
	base: AIUsageScope;
	activityEpoch: string;
	activityRolled: Outcomes;
	timingRolled: Timing;
	timing: Record<string, Timing & { observedAt: number }>;
}

interface StoredConversation {
	observedAt: number;
	direct: StoredScope;
	child: StoredScope;
}

type Mode = "active" | "paused" | "idle";
interface StoredState {
	v: typeof AI_USAGE_SCHEMA_VERSION;
	rolledThrough: number;
	rolled: { direct: AIUsageScope; child: AIUsageScope };
	conversations: Record<string, StoredConversation>;
	time: { activeMs: number; pausedMs: number; idleMs: number; mode: Mode; since: number };
}

export interface AIUsageStateObservation {
	working: boolean;
	paused: boolean;
}

const zeroTiming = (): Timing => ({ providerAttemptsObserved: 0, elapsedMsObserved: 0, activeMsObserved: 0 });
const zeroOutcomes = (): Outcomes => ({ count: 0, success: 0, failure: 0, cancelled: 0, usageReports: 0 });
const zeroTokens = (): AIUsageTokens => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoningStatus: "unavailable",
});
const zeroCost = (): AIUsageCost => ({
	estimateStatus: "unavailable",
	billedStatus: "unavailable",
	subscriptionCoverage: "unknown",
});
const zeroScope = (kind: AIUsageActivity["kind"]): AIUsageScope => ({
	tokens: zeroTokens(),
	cost: zeroCost(),
	activity: {
		kind,
		count: 0,
		success: 0,
		failure: 0,
		cancelled: 0,
		usageReports: 0,
		...zeroTiming(),
		outcomeCoverage: "partial",
		timingCoverage: "partial",
	},
});

function initial(now: number): StoredState {
	return {
		v: AI_USAGE_SCHEMA_VERSION,
		rolledThrough: -1,
		rolled: { direct: zeroScope("model_requests"), child: zeroScope("child_operations") },
		conversations: {},
		time: { activeMs: 0, pausedMs: 0, idleMs: 0, mode: "idle", since: now },
	};
}

function integer(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function timestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function parseTokens(value: unknown): AIUsageTokens | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	if (
		!integer(record.input) ||
		!integer(record.output) ||
		!integer(record.cacheRead) ||
		!integer(record.cacheWrite) ||
		(record.reasoning !== undefined && !integer(record.reasoning)) ||
		!["reported", "partial", "unavailable"].includes(record.reasoningStatus as string)
	)
		return;
	return {
		input: record.input,
		output: record.output,
		cacheRead: record.cacheRead,
		cacheWrite: record.cacheWrite,
		...(record.reasoning === undefined ? {} : { reasoning: record.reasoning as number }),
		reasoningStatus: record.reasoningStatus as AIUsageTokens["reasoningStatus"],
	};
}

function parseCost(value: unknown): AIUsageCost | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	if (
		!["catalog_estimate", "partial_catalog_estimate", "unavailable"].includes(record.estimateStatus as string) ||
		(record.estimatedUsdMicros !== undefined && !integer(record.estimatedUsdMicros)) ||
		(record.pricingRevision !== undefined &&
			(typeof record.pricingRevision !== "string" || !PRICING.test(record.pricingRevision))) ||
		!["known", "unavailable"].includes(record.billedStatus as string) ||
		(record.billedUsdMicros !== undefined && !integer(record.billedUsdMicros)) ||
		!["covered", "not_covered", "unknown"].includes(record.subscriptionCoverage as string)
	)
		return;
	if (
		record.estimateStatus === "unavailable" &&
		(record.estimatedUsdMicros !== undefined || record.pricingRevision !== undefined)
	)
		return;
	if (record.estimateStatus !== "unavailable" && record.estimatedUsdMicros === undefined) return;
	if (record.estimateStatus === "catalog_estimate" && record.pricingRevision === undefined) return;
	if (record.billedStatus === "unavailable" && record.billedUsdMicros !== undefined) return;
	if (record.billedStatus === "known" && record.billedUsdMicros === undefined) return;
	return {
		estimateStatus: record.estimateStatus as AIUsageCost["estimateStatus"],
		...(record.estimatedUsdMicros === undefined ? {} : { estimatedUsdMicros: record.estimatedUsdMicros as number }),
		...(record.pricingRevision === undefined ? {} : { pricingRevision: record.pricingRevision as string }),
		billedStatus: record.billedStatus as AIUsageCost["billedStatus"],
		...(record.billedUsdMicros === undefined ? {} : { billedUsdMicros: record.billedUsdMicros as number }),
		subscriptionCoverage: record.subscriptionCoverage as AIUsageCost["subscriptionCoverage"],
	};
}

function parseActivity(value: unknown, kind: AIUsageActivity["kind"]): AIUsageActivity | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	const keys = [
		"count",
		"success",
		"failure",
		"cancelled",
		"usageReports",
		"providerAttemptsObserved",
		"elapsedMsObserved",
		"activeMsObserved",
	] as const;
	if (
		record.kind !== kind ||
		record.outcomeCoverage !== "partial" ||
		record.timingCoverage !== "partial" ||
		!keys.every((key) => integer(record[key])) ||
		(record.success as number) + (record.failure as number) + (record.cancelled as number) !== record.count ||
		(record.usageReports as number) > (record.count as number)
	)
		return;
	return Object.fromEntries([
		["kind", kind],
		...keys.map((key) => [key, record[key]]),
		["outcomeCoverage", "partial"],
		["timingCoverage", "partial"],
	]) as unknown as AIUsageActivity;
}

function parseScope(value: unknown, kind: AIUsageActivity["kind"]): AIUsageScope | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	const tokens = parseTokens(record.tokens);
	const cost = parseCost(record.cost);
	const activity = parseActivity(record.activity, kind);
	return tokens && cost && activity ? { tokens, cost, activity } : undefined;
}

function parseReport(value: KernelUsage["accounting"]): NonNullable<KernelUsage["accounting"]> | undefined {
	if (
		!value ||
		!CONVERSATION.test(value.conversationId) ||
		!BOOT.test(value.timingBoot) ||
		!ACTIVITY_EPOCH.test(value.activityEpoch) ||
		!timestamp(value.observedAt)
	)
		return;
	const direct = parseScope(value.direct, "model_requests");
	const child = parseScope(value.child, "child_operations");
	return direct && child ? { ...value, direct, child } : undefined;
}

function timing(activity: AIUsageActivity): Timing {
	return {
		providerAttemptsObserved: activity.providerAttemptsObserved,
		elapsedMsObserved: activity.elapsedMsObserved,
		activeMsObserved: activity.activeMsObserved,
	};
}

function withoutTiming(scope: AIUsageScope): AIUsageScope {
	return { ...scope, activity: { ...scope.activity, ...zeroTiming() } };
}

function sum(values: number[]): number {
	return Math.min(
		Number.MAX_SAFE_INTEGER,
		values.reduce((total, value) => total + value, 0),
	);
}

function tokenCount(tokens: AIUsageTokens): number {
	return sum([tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite]);
}

function combineScopes(scopes: AIUsageScope[], kind: AIUsageActivity["kind"]): AIUsageScope {
	if (!scopes.length) return zeroScope(kind);
	const reasoningScopes = scopes.filter((scope) => scope.tokens.reasoningStatus !== "unavailable");
	const outputScopes = scopes.filter((scope) => scope.tokens.output > 0);
	const tokens: AIUsageTokens = {
		input: sum(scopes.map((scope) => scope.tokens.input)),
		output: sum(scopes.map((scope) => scope.tokens.output)),
		cacheRead: sum(scopes.map((scope) => scope.tokens.cacheRead)),
		cacheWrite: sum(scopes.map((scope) => scope.tokens.cacheWrite)),
		...(reasoningScopes.length
			? { reasoning: sum(reasoningScopes.map((scope) => scope.tokens.reasoning ?? 0)) }
			: {}),
		reasoningStatus:
			reasoningScopes.length === 0
				? "unavailable"
				: reasoningScopes.length < outputScopes.length ||
						reasoningScopes.some((scope) => scope.tokens.reasoningStatus === "partial")
					? "partial"
					: "reported",
	};
	const withUsage = scopes.filter(
		(scope) =>
			tokenCount(scope.tokens) > 0 ||
			scope.activity.usageReports > 0 ||
			scope.cost.estimatedUsdMicros !== undefined ||
			scope.cost.billedUsdMicros !== undefined,
	);
	const estimates = withUsage.filter((scope) => scope.cost.estimatedUsdMicros !== undefined);
	const revisions = new Set(estimates.flatMap((scope) => scope.cost.pricingRevision ?? []));
	const estimatedUsdMicros = sum(estimates.map((scope) => scope.cost.estimatedUsdMicros ?? 0));
	const estimateStatus: AIUsageCost["estimateStatus"] =
		estimates.length === 0
			? "unavailable"
			: estimates.length < withUsage.length ||
					revisions.size !== 1 ||
					estimates.some((scope) => scope.cost.estimateStatus !== "catalog_estimate")
				? "partial_catalog_estimate"
				: "catalog_estimate";
	const billed = withUsage.filter((scope) => scope.cost.billedStatus === "known");
	const billedKnown = withUsage.length > 0 && billed.length === withUsage.length;
	const coverage = new Set(withUsage.map((scope) => scope.cost.subscriptionCoverage));
	return {
		tokens,
		cost: {
			estimateStatus,
			...(estimates.length ? { estimatedUsdMicros } : {}),
			...(revisions.size === 1 ? { pricingRevision: [...revisions][0] } : {}),
			billedStatus: billedKnown ? "known" : "unavailable",
			...(billedKnown ? { billedUsdMicros: sum(billed.map((scope) => scope.cost.billedUsdMicros ?? 0)) } : {}),
			subscriptionCoverage: coverage.size === 1 ? [...coverage][0]! : "unknown",
		},
		activity: {
			kind,
			count: sum(scopes.map((scope) => scope.activity.count)),
			success: sum(scopes.map((scope) => scope.activity.success)),
			failure: sum(scopes.map((scope) => scope.activity.failure)),
			cancelled: sum(scopes.map((scope) => scope.activity.cancelled)),
			usageReports: sum(scopes.map((scope) => scope.activity.usageReports)),
			providerAttemptsObserved: sum(scopes.map((scope) => scope.activity.providerAttemptsObserved)),
			elapsedMsObserved: sum(scopes.map((scope) => scope.activity.elapsedMsObserved)),
			activeMsObserved: sum(scopes.map((scope) => scope.activity.activeMsObserved)),
			outcomeCoverage: "partial",
			timingCoverage: "partial",
		},
	};
}

function difference(value: number | undefined, previous: number | undefined): number {
	return Math.max(0, (value ?? 0) - (previous ?? 0));
}

function recordDelta(scope: "direct" | "child", current: AIUsageScope, previous: AIUsageScope): void {
	const numeric: TelemetryAttributes = {
		"pilot.operation": "ai.usage",
		"pilot.ai.scope": scope,
		"pilot.ai.input_tokens": difference(current.tokens.input, previous.tokens.input),
		"pilot.ai.output_tokens": difference(current.tokens.output, previous.tokens.output),
		"pilot.ai.cache_read_tokens": difference(current.tokens.cacheRead, previous.tokens.cacheRead),
		"pilot.ai.cache_write_tokens": difference(current.tokens.cacheWrite, previous.tokens.cacheWrite),
		"pilot.ai.activity_count": difference(current.activity.count, previous.activity.count),
		"pilot.ai.success_count": difference(current.activity.success, previous.activity.success),
		"pilot.ai.failure_count": difference(current.activity.failure, previous.activity.failure),
		"pilot.ai.cancelled_count": difference(current.activity.cancelled, previous.activity.cancelled),
		"pilot.ai.usage_report_count": difference(current.activity.usageReports, previous.activity.usageReports),
		"pilot.ai.provider_attempt_count": difference(
			current.activity.providerAttemptsObserved,
			previous.activity.providerAttemptsObserved,
		),
	};
	const hasDelta = Object.entries(numeric).some(
		([key, value]) => key !== "pilot.operation" && key !== "pilot.ai.scope" && typeof value === "number" && value > 0,
	);
	if (!hasDelta) return;
	const attributes: TelemetryAttributes = {
		...numeric,
		"pilot.ai.reasoning_status": current.tokens.reasoningStatus,
		...(current.tokens.reasoning === undefined
			? {}
			: { "pilot.ai.reasoning_tokens": difference(current.tokens.reasoning, previous.tokens.reasoning) }),
		"pilot.ai.estimate_status": current.cost.estimateStatus,
		...(current.cost.estimatedUsdMicros === undefined
			? {}
			: {
					"pilot.ai.estimated_usd_micros": difference(
						current.cost.estimatedUsdMicros,
						previous.cost.estimatedUsdMicros,
					),
					"pilot.ai.pricing_source": "pi_catalog" as const,
				}),
		"pilot.ai.billed_status": current.cost.billedStatus,
		...(current.cost.billedUsdMicros === undefined
			? {}
			: {
					"pilot.ai.billed_usd_micros": difference(current.cost.billedUsdMicros, previous.cost.billedUsdMicros),
				}),
		"pilot.ai.subscription_coverage": current.cost.subscriptionCoverage,
	};
	nodeTelemetry().recordSpan("pilot.ai.usage", 0, attributes);
}

function timeCounters(state: StoredState): TimeCounters {
	return { activeMs: state.time.activeMs, pausedMs: state.time.pausedMs, idleMs: state.time.idleMs };
}

function recordTimeDelta(current: TimeCounters, previous: TimeCounters): void {
	const active = difference(current.activeMs, previous.activeMs);
	const paused = difference(current.pausedMs, previous.pausedMs);
	const idle = difference(current.idleMs, previous.idleMs);
	const elapsed = sum([active, paused, idle]);
	if (!elapsed) return;
	nodeTelemetry().recordSpan("pilot.ai.usage", 0, {
		"pilot.operation": "ai.usage",
		"pilot.ai.scope": "session",
		"pilot.ai.elapsed_ms": elapsed,
		"pilot.ai.active_ms": active,
		"pilot.ai.paused_ms": paused,
		"pilot.ai.idle_ms": idle,
	});
}

function materialize(scope: StoredScope): AIUsageScope {
	const timingTotal = [scope.timingRolled, ...Object.values(scope.timing)].reduce(
		(total, value) => ({
			providerAttemptsObserved: sum([total.providerAttemptsObserved, value.providerAttemptsObserved]),
			elapsedMsObserved: sum([total.elapsedMsObserved, value.elapsedMsObserved]),
			activeMsObserved: sum([total.activeMsObserved, value.activeMsObserved]),
		}),
		zeroTiming(),
	);
	const outcomes = [scope.activityRolled, scope.base.activity].reduce(
		(total, value) => ({
			count: sum([total.count, value.count]),
			success: sum([total.success, value.success]),
			failure: sum([total.failure, value.failure]),
			cancelled: sum([total.cancelled, value.cancelled]),
			usageReports: sum([total.usageReports, value.usageReports]),
		}),
		zeroOutcomes(),
	);
	return { ...scope.base, activity: { ...scope.base.activity, ...outcomes, ...timingTotal } };
}

function storedScope(
	scope: AIUsageScope,
	activityEpoch: string,
	boot: string,
	observedAt: number,
	previous?: StoredScope,
): StoredScope {
	const next: StoredScope = previous ?? {
		base: withoutTiming(scope),
		activityEpoch,
		activityRolled: zeroOutcomes(),
		timingRolled: zeroTiming(),
		timing: {},
	};
	if (next.activityEpoch !== activityEpoch) {
		next.activityRolled = {
			count: sum([next.activityRolled.count, next.base.activity.count]),
			success: sum([next.activityRolled.success, next.base.activity.success]),
			failure: sum([next.activityRolled.failure, next.base.activity.failure]),
			cancelled: sum([next.activityRolled.cancelled, next.base.activity.cancelled]),
			usageReports: sum([next.activityRolled.usageReports, next.base.activity.usageReports]),
		};
	}
	next.activityEpoch = activityEpoch;
	next.base = withoutTiming(scope);
	next.timing[boot] = { ...timing(scope.activity), observedAt };
	const boots = Object.entries(next.timing).sort((left, right) => left[1].observedAt - right[1].observedAt);
	while (boots.length > MAX_AI_USAGE_TIMING_BOOTS) {
		const [id, value] = boots.shift()!;
		next.timingRolled = {
			providerAttemptsObserved: sum([next.timingRolled.providerAttemptsObserved, value.providerAttemptsObserved]),
			elapsedMsObserved: sum([next.timingRolled.elapsedMsObserved, value.elapsedMsObserved]),
			activeMsObserved: sum([next.timingRolled.activeMsObserved, value.activeMsObserved]),
		};
		delete next.timing[id];
	}
	return next;
}

function settleTime(state: StoredState, now: number): void {
	const elapsed = Math.max(0, now - state.time.since);
	if (state.time.mode === "active") state.time.activeMs = sum([state.time.activeMs, elapsed]);
	else if (state.time.mode === "paused") state.time.pausedMs = sum([state.time.pausedMs, elapsed]);
	else state.time.idleMs = sum([state.time.idleMs, elapsed]);
	state.time.since = now;
}

function parseStored(value: unknown, now: number): StoredState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	if (
		record.v !== AI_USAGE_SCHEMA_VERSION ||
		!Number.isSafeInteger(record.rolledThrough) ||
		(record.rolledThrough as number) < -1
	)
		return;
	// Persisted state is produced only by this class. Re-validate through the public summary and reject malformed files.
	const state = record as unknown as StoredState;
	if (!state.rolled || !state.conversations || !state.time) return;
	const rolledDirect = parseScope(state.rolled.direct, "model_requests");
	const rolledChild = parseScope(state.rolled.child, "child_operations");
	if (
		!rolledDirect ||
		!rolledChild ||
		!integer(state.time.activeMs) ||
		!integer(state.time.pausedMs) ||
		!integer(state.time.idleMs)
	)
		return;
	const parsed = initial(now);
	parsed.rolledThrough = state.rolledThrough;
	parsed.rolled = { direct: rolledDirect, child: rolledChild };
	for (const [id, conversation] of Object.entries(state.conversations).slice(0, MAX_AI_USAGE_CONVERSATIONS)) {
		if (!CONVERSATION.test(id) || !timestamp(conversation?.observedAt)) return;
		const parseStoredScope = (
			value: StoredScope | undefined,
			kind: AIUsageActivity["kind"],
		): StoredScope | undefined => {
			const base = parseScope(value?.base, kind);
			if (
				!base ||
				!value ||
				!ACTIVITY_EPOCH.test(value.activityEpoch) ||
				!integer(value.activityRolled?.count) ||
				!integer(value.activityRolled?.success) ||
				!integer(value.activityRolled?.failure) ||
				!integer(value.activityRolled?.cancelled) ||
				!integer(value.activityRolled?.usageReports) ||
				value.activityRolled.success + value.activityRolled.failure + value.activityRolled.cancelled !==
					value.activityRolled.count ||
				value.activityRolled.usageReports > value.activityRolled.count ||
				!integer(value.timingRolled?.providerAttemptsObserved) ||
				!integer(value.timingRolled?.elapsedMsObserved) ||
				!integer(value.timingRolled?.activeMsObserved)
			)
				return;
			const result: StoredScope = {
				base,
				activityEpoch: value.activityEpoch,
				activityRolled: { ...value.activityRolled },
				timingRolled: { ...value.timingRolled },
				timing: {},
			};
			for (const [boot, counters] of Object.entries(value.timing ?? {}).slice(-MAX_AI_USAGE_TIMING_BOOTS)) {
				if (
					!BOOT.test(boot) ||
					!timestamp(counters.observedAt) ||
					!integer(counters.providerAttemptsObserved) ||
					!integer(counters.elapsedMsObserved) ||
					!integer(counters.activeMsObserved)
				)
					return;
				result.timing[boot] = { ...counters };
			}
			return result;
		};
		const direct = parseStoredScope(conversation.direct, "model_requests");
		const child = parseStoredScope(conversation.child, "child_operations");
		if (!direct || !child) return;
		parsed.conversations[id] = { observedAt: conversation.observedAt, direct, child };
	}
	parsed.time = {
		activeMs: state.time.activeMs,
		pausedMs: state.time.pausedMs,
		idleMs: state.time.idleMs,
		mode: "idle",
		since: now,
	};
	return parsed;
}

export class AIUsageLedger {
	private readonly states = new Map<string, StoredState>();
	private readonly writes = new Map<string, Promise<boolean>>();
	private readonly versions = new Map<string, number>();
	private readonly disabled = new Set<string>();
	private readonly home: string;
	private readonly now: () => number;
	private closed = false;

	constructor(home: string, now: () => number = Date.now) {
		this.home = home;
		this.now = now;
	}

	async load(sessionIds: Iterable<string>): Promise<void> {
		for (const id of sessionIds) {
			let handle: Awaited<ReturnType<typeof open>> | undefined;
			try {
				handle = await open(
					join(this.home, "sessions", id, AI_USAGE_FILE),
					constants.O_RDONLY | constants.O_NOFOLLOW,
				);
				const stat = await handle.stat();
				if (!stat.isFile() || stat.size > MAX_AI_USAGE_FILE_BYTES) continue;
				const state = parseStored(JSON.parse(await handle.readFile("utf8")), this.now());
				if (state) this.states.set(id, state);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
					this.disabled.add(id);
			} finally {
				await handle?.close().catch(() => undefined);
			}
		}
	}

	observeState(sessionId: string, observation: AIUsageStateObservation): void {
		if (this.closed || this.disabled.has(sessionId)) return;
		const state = this.state(sessionId);
		const mode: Mode = observation.paused ? "paused" : observation.working ? "active" : "idle";
		if (state.time.mode === mode) return;
		const previous = timeCounters(state);
		settleTime(state, this.now());
		state.time.mode = mode;
		const current = timeCounters(state);
		void this.schedule(sessionId).then((stored) => {
			if (stored) recordTimeDelta(current, previous);
		});
	}

	observeUsage(sessionId: string, value: KernelUsage["accounting"]): void {
		if (this.closed || this.disabled.has(sessionId)) return;
		const report = parseReport(value);
		if (!report) return;
		const numericId = Number(report.conversationId);
		const state = this.state(sessionId);
		if (numericId <= state.rolledThrough && !state.conversations[report.conversationId]) return;
		const previousTime = timeCounters(state);
		settleTime(state, this.now());
		const currentTime = timeCounters(state);
		const previous = state.conversations[report.conversationId];
		const previousDirect = previous ? materialize(previous.direct) : zeroScope("model_requests");
		const previousChild = previous ? materialize(previous.child) : zeroScope("child_operations");
		state.conversations[report.conversationId] = {
			observedAt: report.observedAt,
			direct: storedScope(
				report.direct,
				report.activityEpoch,
				report.timingBoot,
				report.observedAt,
				previous?.direct,
			),
			child: storedScope(report.child, report.activityEpoch, report.timingBoot, report.observedAt, previous?.child),
		};
		while (Object.keys(state.conversations).length > MAX_AI_USAGE_CONVERSATIONS) {
			const oldest = Object.keys(state.conversations).sort((left, right) => Number(left) - Number(right))[0]!;
			const rolled = state.conversations[oldest]!;
			state.rolled = {
				direct: combineScopes([state.rolled.direct, materialize(rolled.direct)], "model_requests"),
				child: combineScopes([state.rolled.child, materialize(rolled.child)], "child_operations"),
			};
			state.rolledThrough = Math.max(state.rolledThrough, Number(oldest));
			delete state.conversations[oldest];
		}
		const current = state.conversations[report.conversationId];
		const currentDirect = current ? materialize(current.direct) : previousDirect;
		const currentChild = current ? materialize(current.child) : previousChild;
		void this.schedule(sessionId).then((stored) => {
			if (!stored) return;
			recordDelta("direct", currentDirect, previousDirect);
			recordDelta("child", currentChild, previousChild);
			recordTimeDelta(currentTime, previousTime);
		});
	}

	summary(sessionId: string): AIUsageAccounting | undefined {
		const state = this.states.get(sessionId);
		if (!state) return;
		const conversations = Object.values(state.conversations);
		const direct = combineScopes(
			[state.rolled.direct, ...conversations.map((conversation) => materialize(conversation.direct))],
			"model_requests",
		);
		const child = combineScopes(
			[state.rolled.child, ...conversations.map((conversation) => materialize(conversation.child))],
			"child_operations",
		);
		const hasEvidence = [direct, child].some(
			(scope) =>
				tokenCount(scope.tokens) > 0 ||
				scope.activity.count > 0 ||
				scope.activity.providerAttemptsObserved > 0 ||
				scope.cost.estimatedUsdMicros !== undefined ||
				scope.cost.billedUsdMicros !== undefined,
		);
		if (!hasEvidence) return;
		const current = Math.max(0, this.now() - state.time.since);
		const activeMs = sum([state.time.activeMs, state.time.mode === "active" ? current : 0]);
		const pausedMs = sum([state.time.pausedMs, state.time.mode === "paused" ? current : 0]);
		const idleMs = sum([state.time.idleMs, state.time.mode === "idle" ? current : 0]);
		return {
			observedAt: Math.max(0, ...conversations.map((conversation) => conversation.observedAt)),
			direct,
			child,
			time: {
				elapsedMs: sum([activeMs, pausedMs, idleMs]),
				activeMs,
				pausedMs,
				idleMs,
				coverage: "daemon_observed_partial",
			},
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		for (const [id, state] of this.states) {
			const previous = timeCounters(state);
			settleTime(state, this.now());
			const current = timeCounters(state);
			void this.schedule(id).then((stored) => {
				if (stored) recordTimeDelta(current, previous);
			});
		}
		this.closed = true;
		await Promise.allSettled(this.writes.values());
	}

	private state(id: string): StoredState {
		let state = this.states.get(id);
		if (!state) {
			state = initial(this.now());
			this.states.set(id, state);
		}
		return state;
	}

	private schedule(id: string): Promise<boolean> {
		if (this.closed || this.disabled.has(id)) return Promise.resolve(false);
		this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
		const pending = this.writes.get(id);
		if (pending) return pending;
		const write = Promise.resolve()
			.then(() => this.flush(id))
			.catch(() => {
				this.disabled.add(id);
				return false;
			});
		this.writes.set(id, write);
		void write.finally(() => {
			if (this.writes.get(id) === write) this.writes.delete(id);
		});
		return write;
	}

	private async flush(id: string): Promise<boolean> {
		for (;;) {
			const version = this.versions.get(id) ?? 0;
			const state = this.states.get(id);
			if (!state) return false;
			const file = join(this.home, "sessions", id, AI_USAGE_FILE);
			const snapshot = structuredClone(state);
			if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_AI_USAGE_FILE_BYTES)
				throw new Error("AI usage ledger exceeds its bound");
			await durableJSON(file, snapshot);
			if (this.versions.get(id) === version) return true;
		}
	}
}
