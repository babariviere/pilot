/** Read-time, informational comparison over the existing bounded AI usage accounting. */
import type { AIUsageAccounting, AIUsageBudget, AIUsageBudgetComparison, AIUsageScope } from "@pilot/protocol";

function relevant(scope: AIUsageScope): boolean {
	return (
		scope.tokens.input + scope.tokens.output + scope.tokens.cacheRead + scope.tokens.cacheWrite > 0 ||
		scope.activity.count > 0 ||
		scope.activity.usageReports > 0 ||
		scope.activity.providerAttemptsObserved > 0 ||
		scope.cost.estimatedUsdMicros !== undefined ||
		scope.cost.billedUsdMicros !== undefined
	);
}

function subscriptionCoverage(scopes: AIUsageScope[]): AIUsageBudgetComparison["subscriptionCoverage"] {
	if (scopes.length && scopes.every((scope) => scope.cost.subscriptionCoverage === "covered")) return "covered";
	if (scopes.length && scopes.every((scope) => scope.cost.subscriptionCoverage === "not_covered"))
		return "not_covered";
	return "unknown";
}

function comparison(
	amount: number,
	limit: number,
): Extract<AIUsageBudgetComparison["comparison"], "below" | "equal" | "above"> {
	return amount < limit ? "below" : amount > limit ? "above" : "equal";
}

/** Missing scopes are never zero-filled. A partial amount can only prove above when its lower bound exceeds the limit. */
export function compareAIUsageBudget(
	accounting: AIUsageAccounting | undefined,
	budget: AIUsageBudget | undefined,
): AIUsageBudgetComparison | undefined {
	if (!budget) return;
	const scopes = accounting ? [accounting.direct, accounting.child].filter(relevant) : [];
	const coverage = subscriptionCoverage(scopes);
	const base = {
		basis: budget.basis,
		limitUsdMicros: budget.limitUsdMicros,
		window: budget.window,
		subscriptionCoverage: coverage,
		informational: true as const,
	};
	if (!scopes.length) return { ...base, comparison: "unavailable", coverage: "unavailable" };

	const amounts =
		budget.basis === "catalog_estimate"
			? scopes.flatMap((scope) =>
					scope.cost.estimatedUsdMicros === undefined ? [] : [scope.cost.estimatedUsdMicros],
				)
			: scopes.flatMap((scope) => (scope.cost.billedUsdMicros === undefined ? [] : [scope.cost.billedUsdMicros]));
	if (!amounts.length) return { ...base, comparison: "unavailable", coverage: "unavailable" };
	const observedUsdMicros = amounts.reduce((sum, value) => sum + value, 0);
	if (!Number.isSafeInteger(observedUsdMicros)) return { ...base, comparison: "unavailable", coverage: "unavailable" };
	const complete =
		budget.basis === "catalog_estimate"
			? scopes.every(
					(scope) =>
						scope.cost.estimateStatus === "catalog_estimate" && scope.cost.estimatedUsdMicros !== undefined,
				)
			: scopes.every((scope) => scope.cost.billedStatus === "known" && scope.cost.billedUsdMicros !== undefined);
	if (complete)
		return {
			...base,
			comparison: comparison(observedUsdMicros, budget.limitUsdMicros),
			observedUsdMicros,
			coverage: "complete_for_retained_usage",
		};
	return {
		...base,
		comparison: observedUsdMicros > budget.limitUsdMicros ? "above" : "indeterminate",
		observedUsdMicros,
		coverage: "partial_retained_usage",
	};
}
