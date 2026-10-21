import type { UsageObservation } from "@pilot/protocol";

export const USAGE_ROW_BYTES = 4096;
export const USAGE_DAY_MS = 86_400_000;
export const USAGE_RETENTION_MS = 30 * USAGE_DAY_MS;
export const USAGE_MAX_ROWS = 50_000;
export const USAGE_MAX_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const PRICE = /^[A-Za-z0-9][A-Za-z0-9._@:/+-]{0,127}$/;

export const safeUsageInteger = (value: unknown): value is number =>
	Number.isSafeInteger(value) && (value as number) >= 0;
export const usageUUID = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
export const usageIdentifier = (value: unknown): value is string =>
	typeof value === "string" && !value.includes("://") && IDENTIFIER.test(value);

const MODEL_FIELDS = ["provider", "model"];
const ROW_FIELDS = [
	"schemaVersion",
	"generation",
	"sourceId",
	"operationId",
	"revision",
	"kind",
	"scope",
	"observedAt",
	"completedAt",
	"coverage",
	"purpose",
	"attribution",
	"physicalModel",
	"virtualModel",
	"tokens",
	"cost",
	"requests",
	"providerAttempts",
	"retries",
	"durationMs",
	"outcome",
];
const COVERAGE = ["committed", "legacy", "partial"];
const OUTCOMES = ["success", "failure", "cancelled", "unknown"];
const PURPOSES = [
	"agent",
	"control",
	"follow_up",
	"title",
	"triage",
	"classification",
	"memory",
	"compaction",
	"other",
	"unknown",
];
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "reasoningStatus"];
const TOKEN_AMOUNTS = ["input", "output", "cacheRead", "cacheWrite"];
const REASONING_STATUS = ["reported", "partial", "unavailable"];
const COST_FIELDS = [
	"estimateStatus",
	"estimatedUsdMicros",
	"pricingRevision",
	"billedStatus",
	"billedUsdMicros",
	"subscriptionCoverage",
];
const ESTIMATES = ["catalog_estimate", "partial_catalog_estimate", "unavailable"];
const SUBSCRIPTIONS = ["covered", "not_covered", "unknown"];
const ATTRIBUTION_FIELDS = ["projectId", "chatId", "runId", "mission"];
const ATTRIBUTION_IDS = ["projectId", "chatId", "runId"] as const;
const MISSION_FIELDS = ["homeId", "lineageId", "missionId"];
const COUNTERS = ["requests", "providerAttempts", "retries", "durationMs"] as const;

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid usage record");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !fields.includes(key))) throw new Error("Invalid usage fields");
	return record;
}
function requireValue(condition: unknown): asserts condition {
	if (!condition) throw new Error("Invalid usage value");
}
function model(value: unknown): UsageObservation["physicalModel"] {
	if (value === undefined) return;
	const record = object(value, MODEL_FIELDS);
	requireValue(usageIdentifier(record.provider) && usageIdentifier(record.model));
	requireValue(!record.provider.includes(":") && !record.provider.includes("/"));
	return { provider: record.provider, model: record.model };
}

/** Construct canonical allowlisted data. Never include rejected input in errors/logs. */
function canonical(value: unknown): UsageObservation {
	const r = object(value, ROW_FIELDS);
	requireValue(r.schemaVersion === 1 && usageUUID(r.generation) && usageUUID(r.sourceId));
	requireValue(usageIdentifier(r.operationId) && safeUsageInteger(r.revision) && r.revision > 0);
	requireValue(r.kind === "request" || r.kind === "checkpoint");
	requireValue(r.scope === "direct" || r.scope === "child");
	// Child tool totals are reconciliation only. Actual child requests retain direct source identity.
	requireValue(r.kind !== "request" || r.scope === "direct");
	requireValue(safeUsageInteger(r.observedAt));
	requireValue(r.completedAt === undefined || (safeUsageInteger(r.completedAt) && r.completedAt <= r.observedAt));
	requireValue(COVERAGE.includes(r.coverage as string));
	requireValue(r.outcome === undefined || OUTCOMES.includes(r.outcome as string));
	requireValue(PURPOSES.includes(r.purpose as string));
	const t = object(r.tokens, TOKEN_FIELDS);
	for (const key of TOKEN_AMOUNTS) requireValue(safeUsageInteger(t[key]));
	requireValue(REASONING_STATUS.includes(t.reasoningStatus as string));
	requireValue(
		t.reasoning === undefined || (safeUsageInteger(t.reasoning) && (t.reasoning as number) <= (t.output as number)),
	);
	requireValue((t.reasoningStatus === "unavailable") === (t.reasoning === undefined));
	const c = object(r.cost, COST_FIELDS);
	requireValue(ESTIMATES.includes(c.estimateStatus as string));
	requireValue(c.billedStatus === "unavailable" && c.billedUsdMicros === undefined);
	requireValue(SUBSCRIPTIONS.includes(c.subscriptionCoverage as string));
	if (c.estimateStatus === "unavailable")
		requireValue(c.estimatedUsdMicros === undefined && c.pricingRevision === undefined);
	else
		requireValue(
			safeUsageInteger(c.estimatedUsdMicros) &&
				typeof c.pricingRevision === "string" &&
				!c.pricingRevision.includes("://") &&
				PRICE.test(c.pricingRevision),
		);
	let attribution: UsageObservation["attribution"];
	if (r.attribution !== undefined) {
		const a = object(r.attribution, ATTRIBUTION_FIELDS);
		attribution = {};
		for (const key of ATTRIBUTION_IDS) {
			if (a[key] !== undefined) {
				requireValue(usageUUID(a[key]));
				attribution[key] = a[key] as string;
			}
		}
		if (a.mission !== undefined) {
			const m = object(a.mission, MISSION_FIELDS);
			requireValue(usageUUID(m.homeId) && usageUUID(m.lineageId) && usageUUID(m.missionId));
			attribution.mission = { homeId: m.homeId, lineageId: m.lineageId, missionId: m.missionId };
		}
	}
	const result: UsageObservation = {
		schemaVersion: 1,
		generation: r.generation as string,
		sourceId: r.sourceId as string,
		operationId: r.operationId as string,
		revision: r.revision as number,
		kind: r.kind,
		scope: r.scope,
		observedAt: r.observedAt as number,
		...(r.completedAt === undefined ? {} : { completedAt: r.completedAt as number }),
		coverage: r.coverage as UsageObservation["coverage"],
		purpose: r.purpose as UsageObservation["purpose"],
		...(r.outcome === undefined ? {} : { outcome: r.outcome as UsageObservation["outcome"] }),
		...(attribution ? { attribution } : {}),
		...(r.physicalModel === undefined ? {} : { physicalModel: model(r.physicalModel) }),
		...(r.virtualModel === undefined ? {} : { virtualModel: model(r.virtualModel) }),
		tokens: {
			input: t.input as number,
			output: t.output as number,
			cacheRead: t.cacheRead as number,
			cacheWrite: t.cacheWrite as number,
			...(t.reasoning === undefined ? {} : { reasoning: t.reasoning as number }),
			reasoningStatus: t.reasoningStatus as UsageObservation["tokens"]["reasoningStatus"],
		},
		cost: {
			estimateStatus: c.estimateStatus as UsageObservation["cost"]["estimateStatus"],
			...(c.estimatedUsdMicros === undefined
				? {}
				: { estimatedUsdMicros: c.estimatedUsdMicros as number, pricingRevision: c.pricingRevision as string }),
			billedStatus: "unavailable",
			subscriptionCoverage: c.subscriptionCoverage as UsageObservation["cost"]["subscriptionCoverage"],
		},
	};
	for (const key of COUNTERS) {
		if (r[key] !== undefined) {
			requireValue(safeUsageInteger(r[key]));
			result[key] = r[key];
		}
	}
	return result;
}

export function parseUsageObservation(value: unknown): UsageObservation {
	const result = canonical(value);
	requireValue(Buffer.byteLength(JSON.stringify(result)) <= USAGE_ROW_BYTES);
	return result;
}

/** Bound corrupt on-disk JSON before parsing; avoid serializing every validated row a second time. */
export function readUsageObservation(json: string): UsageObservation {
	requireValue(Buffer.byteLength(json) <= USAGE_ROW_BYTES);
	return canonical(JSON.parse(json));
}
