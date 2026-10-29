import assert from "node:assert/strict";
import { test } from "node:test";
import type { MissionClassification, MissionTask, ModelList } from "@pilot/protocol";
import {
	type ModelNeed,
	type ModelRecommendationContext,
	recommendMissionModel,
} from "./mission-model-recommendation.ts";

const known: MissionClassification = {
	version: 1,
	effort: "medium",
	difficulty: "routine",
	risk: "low",
	uncertainty: "known",
	scope: "bounded",
	role: "builder",
	deliveryKind: "code",
};
const terra = "fixture/terra";
const strong = "fixture/strong";
const allowed: ModelList = {
	models: [terra, strong].map((id) => ({ id, provider: "fixture", name: id, thinkingLevels: ["off", "high"] })),
};
function task(
	change: Partial<MissionClassification> = {},
): Pick<MissionTask, "assignment" | "preferredModel" | "preferredThinking" | "preferredModelSetBy"> {
	return {
		assignment: {
			version: 1,
			revision: 1,
			intent: "Implement specified invariant",
			scope: "Bounded module",
			criteria: ["Pass checks"],
			classification: { ...known, ...change },
		},
	};
}
function context(): ModelRecommendationContext {
	return {
		now: 100,
		assessments: [
			{
				model: terra,
				needs: ["bounded-work", "substantive-work"],
				provenance: "Fixture coordinator assessment",
				reason: "Known medium-effort implementation, not independent review",
			},
			{
				model: strong,
				needs: [
					"bounded-work",
					"substantive-work",
					"complex-investigation",
					"independent-review",
					"specialist-review",
					"native-ui",
				],
				provenance: "Fixture specialist assessment",
				reason: "Broader investigation/review assessment, not capability proof",
			},
		],
		availability: [terra, strong].map((model) => ({
			model,
			status: "available",
			source: "provider-observation",
			provenance: "Synthetic provider fixture, no external calls",
			observedAt: 90,
			expiresAt: 110,
		})),
	};
}

test("known medium work may recommend assessed Terra, without fixed mappings or mutating inputs", () => {
	const input = task();
	const ctx = context();
	const before = structuredClone({ input, ctx, allowed });
	const result = recommendMissionModel(input, allowed, ctx);
	assert.equal(result.recommendedModel, terra);
	assert.equal(result.advice.tier, "T1");
	assert.equal(result.advisoryOnly, true);
	assert.match(result.reasons.join(" "), /including Terra if configured/);
	assert.match(result.reasons.join(" "), /not verified capability/);
	assert.deepEqual({ input, ctx, allowed }, before);
	const renamed = { models: [{ ...allowed.models[0]!, id: "custom/other" }] };
	ctx.assessments[0]!.model = "custom/other";
	ctx.availability[0]!.model = "custom/other";
	assert.equal(recommendMissionModel(input, renamed, ctx).recommendedModel, "custom/other");
	assert.equal(recommendMissionModel(task({ difficulty: "substantive" }), allowed, context()).advice.tier, "T2");
});

test("hard/uncertain exploration and independent review need separately assessed models", () => {
	for (const change of [
		{ role: "explorer", deliveryKind: "research", difficulty: "hard" },
		{ role: "explorer", uncertainty: "unknown" },
		{ role: "reviewer", effort: "small" },
		{ role: "reviewer", risk: "high" },
		{ deliveryKind: "native-ui" },
	] as const) {
		const result = recommendMissionModel(task(change), allowed, context());
		assert.equal(result.recommendedModel, strong);
		assert.equal(result.candidates[0]?.suitability, "assessed-insufficient");
	}
	const review = recommendMissionModel(task({ role: "reviewer", risk: "high" }), allowed, context());
	assert.ok(review.needs.includes("specialist-review"));
	assert.equal(review.advice.review, "specialist-and-human");
	assert.equal(recommendMissionModel(task({ effort: "unknown" }), allowed, context()).advice.tier, "T1");
	assert.equal(recommendMissionModel(task({ effort: "large" }), allowed, context()).advice.tier, "T1");
	assert.match(
		recommendMissionModel(task({ role: "explorer", deliveryKind: "research" }), allowed, context()).reasons.join(" "),
		/not proof of code-free/,
	);
});

test("unknown classification/intent and expanded scope stay explicit and never admit work", () => {
	const missing = recommendMissionModel({}, allowed, context());
	assert.equal(missing.advice.classification, null);
	assert.equal(missing.advice.tier, "T3");
	assert.equal(missing.recommendedModel, null);
	for (const change of [{ scope: "expanded" }, { role: "unknown" }, { deliveryKind: "unknown" }] as const) {
		const result = recommendMissionModel(task(change), allowed, context());
		assert.equal(result.status, "needs-attention");
		assert.equal(result.recommendedModel, null);
	}
	const result = recommendMissionModel(task({ scope: "expanded" }), allowed, context());
	assert.equal(result.advice.needsRescope, true);
	assert.equal(result.advice.tier, "T3");
});

test("user preference wins candidate order or blocks, never silently falls back or asserts suitability", () => {
	const input = { ...task(), preferredModel: strong, preferredThinking: "high", preferredModelSetBy: "user" as const };
	assert.equal(recommendMissionModel(input, allowed, context()).recommendedModel, strong);
	for (const model of ["unknown/model", "disallowed/model", terra]) {
		const result = recommendMissionModel(
			{ ...task({ role: "reviewer" }), preferredModel: model, preferredModelSetBy: "user" },
			allowed,
			context(),
		);
		assert.equal(result.preference?.model, model);
		assert.equal(result.recommendedModel, null);
		assert.match(result.reasons.join(" "), /without fallback/);
	}
	const badThinking = recommendMissionModel({ ...input, preferredThinking: "unsupported" }, allowed, context());
	assert.equal(badThinking.recommendedModel, null);
	assert.equal(badThinking.preference?.thinking, "unsupported");
});

test("disallowed assessments never enter candidates; unavailable/unknown/stale observations are not availability", () => {
	const input = { ...task(), preferredModel: terra, preferredModelSetBy: "user" as const };
	for (const patch of [
		{ status: "unavailable" },
		{ status: "unknown" },
		{ expiresAt: 100 },
		{ observedAt: 101 },
		{ source: "catalog" },
	] as const) {
		const ctx = context();
		Object.assign(ctx.availability[0]!, patch);
		const result = recommendMissionModel(input, allowed, ctx);
		assert.equal(result.recommendedModel, null);
		assert.equal(result.candidates[0]!.availability, patch.status === "unavailable" ? "unavailable" : "unknown");
		assert.equal(result.advice.review, "targeted-independent");
	}
	const ctx = context();
	ctx.availability = [];
	const noObservation = recommendMissionModel(input, allowed, ctx);
	assert.equal(noObservation.candidates[0]!.availability, "unknown");
	assert.equal(noObservation.recommendedModel, null);
	ctx.assessments.push({
		model: "disallowed/model",
		needs: ["bounded-work"],
		provenance: "Synthetic",
		reason: "Not eligible",
	});
	const excluded = recommendMissionModel(task(), allowed, ctx);
	assert.deepEqual(excluded.excludedAssessments, ["disallowed/model"]);
	assert.ok(!excluded.candidates.some((c) => c.model === "disallowed/model"));
	assert.equal(recommendMissionModel(task(), { models: [] }, context()).recommendedModel, null);
});

test("missing/weak assessments and model availability never lower review/check baselines", () => {
	for (const needs of [[], ["bounded-work"]] as ModelNeed[][]) {
		const ctx = context();
		for (const a of ctx.assessments) a.needs = needs;
		const result = recommendMissionModel(task({ role: "reviewer", risk: "high" }), allowed, ctx);
		assert.equal(result.recommendedModel, null);
		assert.equal(result.advice.tier, "T3");
		assert.equal(result.advice.review, "specialist-and-human");
		assert.match(result.reasons.join(" "), /Checks remain mandatory/);
	}
	const ctx = context();
	ctx.assessments = [];
	assert.equal(recommendMissionModel(task(), allowed, ctx).candidates[0]!.suitability, "unassessed");
	assert.equal(recommendMissionModel(task(), allowed, ctx).recommendedModel, null);
});

test("assessment and provider provenance are mandatory, bounded and copied", () => {
	const ctx = context();
	const result = recommendMissionModel(task(), allowed, ctx);
	ctx.assessments[0]!.needs.length = 0;
	assert.deepEqual(result.candidates[0]!.assessment?.needs, ["bounded-work", "substantive-work"]);
	for (const change of [
		(c: ModelRecommendationContext) => {
			c.assessments[0]!.provenance = "";
		},
		(c: ModelRecommendationContext) => {
			c.availability[0]!.provenance = "";
		},
		(c: ModelRecommendationContext) => {
			c.availability[0]!.source = "usage" as never;
		},
		(c: ModelRecommendationContext) => {
			c.assessments.push(c.assessments[0]!);
		},
		(c: ModelRecommendationContext) => {
			c.assessments[0]!.needs = ["invented" as ModelNeed];
		},
		(c: ModelRecommendationContext) => {
			c.assessments = Array(257).fill(c.assessments[0]);
		},
	]) {
		const invalid = context();
		change(invalid);
		assert.throws(() => recommendMissionModel(task(), allowed, invalid));
	}
});
