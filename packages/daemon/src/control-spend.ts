import type { AIUsageAccounting, ControlSpend } from "@pilot/protocol";
import { combineScopes } from "./ai-usage.ts";

/** Constant retained size, including when a grant has started many archived chats. */
export class ControlSpendAccumulator {
	private sessions = 0;
	private observedSessions = 0;
	private scope = combineScopes([], "model_requests");
	add(usage: AIUsageAccounting | undefined): void {
		this.sessions++;
		if (!usage) return;
		this.observedSessions++;
		this.scope = combineScopes([this.scope, usage.direct, usage.child], "model_requests");
	}
	value(): ControlSpend {
		const cost = { ...this.scope.cost };
		if (this.observedSessions < this.sessions) {
			if (cost.estimateStatus === "catalog_estimate") cost.estimateStatus = "partial_catalog_estimate";
			cost.billedStatus = "unavailable";
			delete cost.billedUsdMicros;
		}
		return {
			sessions: this.sessions,
			observedSessions: this.observedSessions,
			cost,
			coverage: "ledger_observed_partial",
		};
	}
}
/** Catalog estimates stay estimates; missing ledger coverage must never turn into a known bill. */
export function controlSpend(usages: Array<AIUsageAccounting | undefined>): ControlSpend {
	const accumulator = new ControlSpendAccumulator();
	for (const usage of usages) accumulator.add(usage);
	return accumulator.value();
}
