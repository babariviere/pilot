import assert from "node:assert/strict";
import { test } from "node:test";
import type { AIUsageAccounting, AIUsageBudget, AIUsageScope } from "@pilot/protocol";
import { compareAIUsageBudget } from "./ai-usage-budget.ts";

const budget = (basis: AIUsageBudget["basis"], limitUsdMicros = 100): AIUsageBudget => ({
	basis,
	limitUsdMicros,
	window: "retained_chat",
});

function scope(
	kind: AIUsageScope["activity"]["kind"],
	cost: Partial<AIUsageScope["cost"]>,
	options: { usage?: boolean; coverage?: AIUsageScope["cost"]["subscriptionCoverage"] } = {},
): AIUsageScope {
	return {
		tokens: {
			input: options.usage === false ? 0 : 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoningStatus: "unavailable",
		},
		cost: {
			estimateStatus: "unavailable",
			billedStatus: "unavailable",
			subscriptionCoverage: options.coverage ?? "unknown",
			...cost,
		},
		activity: {
			kind,
			count: options.usage === false ? 0 : 1,
			success: options.usage === false ? 0 : 1,
			failure: 0,
			cancelled: 0,
			usageReports: options.usage === false ? 0 : 1,
			providerAttemptsObserved: options.usage === false ? 0 : 1,
			requestRetriesObserved: 0,
			elapsedMsObserved: 1,
			activeMsObserved: 1,
			outcomeCoverage: "partial",
			timingCoverage: "partial",
		},
	};
}

function accounting(direct: AIUsageScope, child = scope("child_operations", {}, { usage: false })): AIUsageAccounting {
	return {
		observedAt: 1,
		direct,
		child,
		time: {
			elapsedMs: 1,
			activeMs: 1,
			pausedMs: 0,
			idleMs: 0,
			coverage: "daemon_observed_partial",
		},
	};
}

test("catalog budgets report below, equal and above only for complete retained usage", () => {
	for (const [amount, expected] of [
		[99, "below"],
		[100, "equal"],
		[101, "above"],
	] as const) {
		const result = compareAIUsageBudget(
			accounting(
				scope("model_requests", {
					estimateStatus: "catalog_estimate",
					estimatedUsdMicros: amount,
					pricingRevision: "pi-ai@1.3.0",
				}),
			),
			budget("catalog_estimate"),
		);
		assert.equal(result?.comparison, expected);
		assert.equal(result?.coverage, "complete_for_retained_usage");
		assert.equal(result?.observedUsdMicros, amount);
		assert.equal(result?.informational, true);
	}
});

test("partial and unavailable estimates never become false zero or equality claims", () => {
	const partialBelow = compareAIUsageBudget(
		accounting(
			scope("model_requests", {
				estimateStatus: "partial_catalog_estimate",
				estimatedUsdMicros: 50,
				pricingRevision: "pi-ai@1.3.0",
			}),
			scope("child_operations", {}),
		),
		budget("catalog_estimate"),
	);
	assert.equal(partialBelow?.comparison, "indeterminate");
	assert.equal(partialBelow?.coverage, "partial_retained_usage");
	assert.equal(partialBelow?.observedUsdMicros, 50);

	const partialAbove = compareAIUsageBudget(
		accounting(
			scope("model_requests", {
				estimateStatus: "partial_catalog_estimate",
				estimatedUsdMicros: 101,
				pricingRevision: "pi-ai@1.3.0",
			}),
		),
		budget("catalog_estimate"),
	);
	assert.equal(partialAbove?.comparison, "above", "a lower bound above the limit is conclusive");
	assert.equal(
		compareAIUsageBudget(accounting(scope("model_requests", {})), budget("catalog_estimate"))?.comparison,
		"unavailable",
	);
	assert.equal(compareAIUsageBudget(undefined, budget("catalog_estimate"))?.observedUsdMicros, undefined);
	assert.equal(compareAIUsageBudget(undefined, undefined), undefined);
});

test("billed comparisons and subscription coverage stay distinct from catalog estimates", () => {
	const known = compareAIUsageBudget(
		accounting(
			scope(
				"model_requests",
				{
					estimateStatus: "catalog_estimate",
					estimatedUsdMicros: 10_000,
					pricingRevision: "pi-ai@1.3.0",
					billedStatus: "known",
					billedUsdMicros: 75,
				},
				{ coverage: "covered" },
			),
		),
		budget("billed"),
	);
	assert.deepEqual(known, {
		basis: "billed",
		limitUsdMicros: 100,
		window: "retained_chat",
		comparison: "below",
		observedUsdMicros: 75,
		coverage: "complete_for_retained_usage",
		subscriptionCoverage: "covered",
		informational: true,
	});
	const unavailable = compareAIUsageBudget(
		accounting(
			scope("model_requests", {
				estimateStatus: "catalog_estimate",
				estimatedUsdMicros: 10_000,
				pricingRevision: "pi-ai@1.3.0",
			}),
		),
		budget("billed"),
	);
	assert.equal(unavailable?.comparison, "unavailable");
	assert.equal(unavailable?.observedUsdMicros, undefined);
	assert.equal(unavailable?.subscriptionCoverage, "unknown");
});
