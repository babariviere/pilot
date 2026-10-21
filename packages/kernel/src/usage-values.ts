/** Numeric usage normalization shared by aggregate summaries and local capture. No model/runtime imports. */
import type { AIUsageCost, AIUsageTokens } from "@pilot/protocol";
import manifest from "../package.json" with { type: "json" };

const PRICING_REVISION = `pi-ai@${manifest.dependencies["@earendil-works/pi-ai"]}`;

function amount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
		: 0;
}

function micros(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value * 1_000_000));
}

function add(left: number, right: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

export function usageTokens(values: unknown[]): AIUsageTokens {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let reasoning = 0;
	let reasoningReports = 0;
	let outputReports = 0;
	for (const value of values) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const usage = value as Record<string, unknown>;
		input = add(input, amount(usage.input));
		output = add(output, amount(usage.output));
		cacheRead = add(cacheRead, amount(usage.cacheRead));
		cacheWrite = add(cacheWrite, amount(usage.cacheWrite));
		if (amount(usage.output) > 0) outputReports++;
		if (usage.reasoning !== undefined) {
			reasoning = add(reasoning, amount(usage.reasoning));
			reasoningReports++;
		}
	}
	const reasoningStatus =
		reasoningReports === 0 ? "unavailable" : reasoningReports < outputReports ? "partial" : "reported";
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(reasoningReports ? { reasoning } : {}),
		reasoningStatus,
	};
}

export function usageCost(values: unknown[]): AIUsageCost {
	let estimatedUsdMicros = 0;
	let usageReports = 0;
	let pricedReports = 0;
	for (const value of values) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const usage = value as Record<string, unknown>;
		const tokenCount =
			amount(usage.input) + amount(usage.output) + amount(usage.cacheRead) + amount(usage.cacheWrite);
		const rawCost = usage.cost;
		const estimate =
			rawCost && typeof rawCost === "object" && !Array.isArray(rawCost)
				? micros((rawCost as Record<string, unknown>).total)
				: undefined;
		if (!tokenCount && estimate === undefined) continue;
		usageReports++;
		if (estimate !== undefined) {
			pricedReports++;
			estimatedUsdMicros = Math.min(Number.MAX_SAFE_INTEGER, estimatedUsdMicros + estimate);
		}
	}
	const estimateStatus =
		pricedReports === 0
			? "unavailable"
			: pricedReports < usageReports
				? "partial_catalog_estimate"
				: "catalog_estimate";
	return {
		estimateStatus,
		...(pricedReports ? { estimatedUsdMicros, pricingRevision: PRICING_REVISION } : {}),
		billedStatus: "unavailable",
		subscriptionCoverage: "unknown",
	};
}
