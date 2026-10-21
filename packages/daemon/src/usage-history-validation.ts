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

function object(value: unknown, fields: string[]): Record<string, unknown> {
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
	const record = object(value, ["provider", "model"]);
	requireValue(usageIdentifier(record.provider) && usageIdentifier(record.model));
	requireValue(!record.provider.includes(":") && !record.provider.includes("/"));
	return { provider: record.provider, model: record.model };
}

/** Construct canonical allowlisted data. Never include rejected input in errors/logs. */
export function parseUsageObservation(value: unknown): UsageObservation {
	const r = object(value, [
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
	]);
	requireValue(r.schemaVersion === 1 && usageUUID(r.generation) && usageUUID(r.sourceId));
	requireValue(usageIdentifier(r.operationId) && safeUsageInteger(r.revision) && r.revision > 0);
	requireValue(r.kind === "request" || r.kind === "checkpoint");
	requireValue(r.scope === "direct" || r.scope === "child");
	// Child tool totals are reconciliation only. Actual child requests retain direct source identity.
	requireValue(r.kind !== "request" || r.scope === "direct");
	requireValue(safeUsageInteger(r.observedAt));
	requireValue(r.completedAt === undefined || (safeUsageInteger(r.completedAt) && r.completedAt <= r.observedAt));
	requireValue(["committed", "legacy", "partial"].includes(r.coverage as string));
	requireValue(
		r.outcome === undefined || ["success", "failure", "cancelled", "unknown"].includes(r.outcome as string),
	);
	requireValue(
		[
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
		].includes(r.purpose as string),
	);
	const t = object(r.tokens, ["input", "output", "cacheRead", "cacheWrite", "reasoning", "reasoningStatus"]);
	for (const key of ["input", "output", "cacheRead", "cacheWrite"]) requireValue(safeUsageInteger(t[key]));
	requireValue(["reported", "partial", "unavailable"].includes(t.reasoningStatus as string));
	requireValue(
		t.reasoning === undefined || (safeUsageInteger(t.reasoning) && (t.reasoning as number) <= (t.output as number)),
	);
	requireValue((t.reasoningStatus === "unavailable") === (t.reasoning === undefined));
	const c = object(r.cost, [
		"estimateStatus",
		"estimatedUsdMicros",
		"pricingRevision",
		"billedStatus",
		"billedUsdMicros",
		"subscriptionCoverage",
	]);
	requireValue(["catalog_estimate", "partial_catalog_estimate", "unavailable"].includes(c.estimateStatus as string));
	requireValue(c.billedStatus === "unavailable" && c.billedUsdMicros === undefined);
	requireValue(["covered", "not_covered", "unknown"].includes(c.subscriptionCoverage as string));
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
		const a = object(r.attribution, ["projectId", "chatId", "runId", "mission"]);
		attribution = {};
		for (const key of ["projectId", "chatId", "runId"] as const) {
			if (a[key] !== undefined) {
				requireValue(usageUUID(a[key]));
				attribution[key] = a[key] as string;
			}
		}
		if (a.mission !== undefined) {
			const m = object(a.mission, ["homeId", "lineageId", "missionId"]);
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
	for (const key of ["requests", "providerAttempts", "retries", "durationMs"] as const) {
		if (r[key] !== undefined) {
			requireValue(safeUsageInteger(r[key]));
			result[key] = r[key];
		}
	}
	requireValue(Buffer.byteLength(JSON.stringify(result)) <= USAGE_ROW_BYTES);
	return result;
}
