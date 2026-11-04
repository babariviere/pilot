import type {
	InsightsInitialDefaults,
	InsightsInitialModelResolution,
	InsightsReviewSettings,
	InsightsSetupDefaults,
	ModelOption,
} from "@pilot/protocol";
import type { ModelCatalog } from "./models.ts";

/** Suggestions only. Import/status reads never create authority, work or schedules. */
export const INSIGHTS_INITIAL_DEFAULTS = Object.freeze({
	recurrence: Object.freeze({ every: "week", weekday: 5, time: "18:00", timeZone: "Europe/Paris" }),
	requestedModel: "Terra 6.1",
	scope: Object.freeze({
		host: "local",
		projects: "admitted",
		includeArchived: true,
		sourceAccess: "read_only",
		coverage: "partial",
	}),
	bounds: Object.freeze({ inventoryPages: 1, historyPages: 2, entriesPerPage: 4 }),
	budget: Object.freeze({ usd: 5, period: "report", enforcement: "advisory", basis: "initial_assumption" }),
	activationRequired: true,
}) satisfies InsightsInitialDefaults;

/** No fuzzy IDs, provider preference, price ordering or Pi/project default fallback. */
export function resolveInsightsInitialModel(models: readonly ModelOption[]): InsightsInitialModelResolution {
	const name = (s: string) => s.trim().replace(/\s+/gu, " ").toLowerCase();
	const ids = [
		...new Set(
			models.filter((m) => name(m.name) === name(INSIGHTS_INITIAL_DEFAULTS.requestedModel)).map((m) => m.id),
		),
	].sort();
	if (ids.length === 1) return { state: "available", id: ids[0]! };
	return ids.length ? { state: "ambiguous", ids } : { state: "unavailable", reason: "not_found" };
}

/** Reuses the configured, authenticated project scope without a provider completion or history read. */
export async function insightsSetupDefaults(
	projectId: string,
	cwd: string,
	catalog: Pick<ModelCatalog, "list">,
): Promise<InsightsSetupDefaults> {
	let model: InsightsInitialModelResolution;
	try {
		model = resolveInsightsInitialModel((await catalog.list(cwd)).models);
	} catch {
		// Do not expose credential/configuration errors or guess when catalog data is unavailable.
		model = { state: "unavailable", reason: "catalog_unavailable" };
	}
	return { projectId, defaults: INSIGHTS_INITIAL_DEFAULTS, model };
}

/** Informational only. This seam does not measure pricing/spend or enforce an allowance. */
export function insightsReviewBudget(budget: InsightsReviewSettings["budget"] = INSIGHTS_INITIAL_DEFAULTS.budget) {
	return {
		...budget,
		pricing: "unknown" as const,
		spendUsd: null,
		note:
			budget === INSIGHTS_INITIAL_DEFAULTS.budget
				? "Approximately $5 per report is an initial assumption, not a hard cap or approved spend. Budget period and scope still need activation confirmation. Pricing and spend are unknown here; do not infer zero cost or change models, budgets or limits automatically."
				: `Approximately $${budget.usd} per ${budget.period}, advisory only, not a hard cap, spending guarantee or approved spend. Changes need activation confirmation. Pricing and spend are unknown; do not infer zero cost or automatically change models, budgets or limits.`,
	};
}
