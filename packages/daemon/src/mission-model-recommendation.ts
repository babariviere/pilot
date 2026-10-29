/** Advisory, host-only foundation. No model calls, settings writes, admission or delivery decisions. */
import type { MissionTask, ModelList } from "@pilot/protocol";
import { classificationAdvice } from "./mission-classification.ts";

export type ModelNeed =
	| "bounded-work"
	| "substantive-work"
	| "complex-investigation"
	| "independent-review"
	| "specialist-review"
	| "native-ui";
/** Per-call, explicitly attributed opinion, not verified model capability or a product mapping. */
export interface ModelSuitabilityAssessment {
	model: string;
	needs: ModelNeed[];
	provenance: string;
	reason: string;
}
export interface ModelAvailabilityObservation {
	model: string;
	status: "available" | "unavailable" | "unknown";
	/** Authentication/catalog/usage alone never establishes provider availability. */
	source: "provider-observation" | "catalog";
	provenance: string;
	observedAt: number;
	expiresAt: number;
}
export interface ModelRecommendationContext {
	assessments: ModelSuitabilityAssessment[];
	availability: ModelAvailabilityObservation[];
	now: number;
}
export type ModelRecommendationTask = Pick<
	MissionTask,
	"assignment" | "preferredModel" | "preferredThinking" | "preferredModelSetBy"
>;

const NEEDS: ModelNeed[] = [
	"bounded-work",
	"substantive-work",
	"complex-investigation",
	"independent-review",
	"specialist-review",
	"native-ui",
];

function contextCheck(context: ModelRecommendationContext): void {
	if (!Number.isFinite(context.now)) throw new Error("Invalid recommendation time");
	for (const entries of [context.assessments, context.availability]) {
		if (
			!Array.isArray(entries) ||
			entries.length > 256 ||
			new Set(entries.map((e) => e.model)).size !== entries.length
		)
			throw new Error("Recommendation inputs require at most 256 unique model entries");
	}
	const label = (value: string) => typeof value === "string" && !!value.trim() && Array.from(value).length <= 1000;
	for (const a of context.assessments)
		if (
			!label(a.model) ||
			!label(a.provenance) ||
			!label(a.reason) ||
			!Array.isArray(a.needs) ||
			a.needs.length > NEEDS.length ||
			a.needs.some((n) => !NEEDS.includes(n))
		)
			throw new Error("Invalid attributed model assessment");
	for (const a of context.availability)
		if (
			!label(a.model) ||
			!label(a.provenance) ||
			!["available", "unavailable", "unknown"].includes(a.status) ||
			!["provider-observation", "catalog"].includes(a.source) ||
			!Number.isFinite(a.observedAt) ||
			!Number.isFinite(a.expiresAt) ||
			a.expiresAt < a.observedAt
		)
			throw new Error("Invalid model availability observation");
}

/** `allowed` MUST come from ModelCatalog.listTaskModels, not usage records or caller-provided model names.
 * Catalog eligibility (scope/auth/price cap) is distinct from the supplied provider observation.
 * Results are ephemeral assessments; even a preferred, available model may be unsuitable.
 */
export function recommendMissionModel(
	task: ModelRecommendationTask,
	allowed: ModelList,
	context: ModelRecommendationContext,
) {
	contextCheck(context);
	const advice = classificationAdvice(task.assignment?.classification);
	const c = advice.classification;
	const needs: ModelNeed[] = [];
	if (
		!c ||
		c.difficulty === "hard" ||
		c.difficulty === "unknown" ||
		c.uncertainty === "unknown" ||
		c.scope !== "bounded"
	)
		needs.push("complex-investigation");
	else needs.push(c.difficulty === "substantive" ? "substantive-work" : "bounded-work");
	if (c?.role === "reviewer") needs.push(advice.tier === "T3" ? "specialist-review" : "independent-review");
	if (c?.deliveryKind === "native-ui") needs.push("native-ui");
	// Fail explicitly rather than silently omitting an eligible preference from a partial catalog.
	if (allowed.models.length > 2048) throw new Error("Task model catalog exceeds recommendation limit (2048)");
	const candidates = allowed.models.map((option) => {
		const assessment = context.assessments.find((a) => a.model === option.id);
		const observation = context.availability.find((a) => a.model === option.id);
		const availability =
			observation?.source === "provider-observation" &&
			observation.observedAt <= context.now &&
			context.now < observation.expiresAt
				? observation.status
				: "unknown";
		const suitability = assessment
			? needs.every((need) => assessment.needs.includes(need))
				? "assessed-suitable"
				: "assessed-insufficient"
			: "unassessed";
		return {
			model: option.id,
			availability,
			suitability,
			assessment: assessment ? structuredClone(assessment) : null,
			availabilityObservation: observation ? { ...observation } : null,
		} as const;
	});
	const preference = task.preferredModel
		? {
				model: task.preferredModel,
				thinking: task.preferredThinking ?? null,
				setBy: task.preferredModelSetBy ?? "unknown",
			}
		: null;
	const preferred = preference ? candidates.find((c) => c.model === preference.model) : undefined;
	const reasons = [
		...advice.reasons,
		"Suitability is an attributed assessment, not verified capability or safety. Catalog eligibility is not provider availability.",
	];
	if (c?.role === "explorer")
		reasons.push(
			"Exploration intent does not grant capabilities; hard or uncertain research needs complex-investigation assessment.",
		);
	if (!c || c.role === "unknown" || c.deliveryKind === "unknown")
		reasons.push("Assignment role or delivery intent is unknown; clarify before using the recommendation.");
	if (preference)
		reasons.push(`${preference.setBy} preference is retained without fallback; it does not establish suitability.`);
	const selected = preference
		? preferred
		: candidates.find((c) => c.suitability === "assessed-suitable" && c.availability === "available");
	const thinkingSupported =
		!preference?.thinking ||
		!!allowed.models.find((o) => o.id === preference.model)?.thinkingLevels?.includes(preference.thinking);
	const blocked =
		advice.needsRescope ||
		!c ||
		c.role === "unknown" ||
		c.deliveryKind === "unknown" ||
		!thinkingSupported ||
		!selected ||
		selected.availability !== "available" ||
		selected.suitability !== "assessed-suitable";
	if (preference && !preferred)
		reasons.push(
			"Preferred model is not in the current task-start catalog (scope, auth or price cap); no alternative selected.",
		);
	if (!thinkingSupported) reasons.push("Preferred thinking is unsupported; it is not silently changed.");
	if (blocked)
		reasons.push(
			"No actionable model recommendation: rescope, clarify intent, assess suitability or resolve model eligibility/availability.",
		);
	return {
		advisoryOnly: true,
		/** Snapshot context, not an acceptance receipt. Re-read task/definition fences before any later write. */
		assignmentRevision: task.assignment?.revision ?? null,
		advice,
		needs,
		preference,
		candidates,
		/** Out-of-scope assessments cannot introduce additional candidates. */
		excludedAssessments: context.assessments
			.filter((a) => !candidates.some((c) => c.model === a.model))
			.map((a) => a.model),
		status: blocked ? "needs-attention" : "recommended",
		recommendedModel: blocked ? null : selected!.model,
		reasons,
	} as const;
}
