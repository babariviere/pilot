import type { ReviewProfileDefinition } from "./mission-review-contract.ts";

const NET_CHANGE =
	"For code, judge the net introduced or worsened behavior/debt in the exact retained base/head comparison, not intermediate commits or unchanged legacy. Keep existing audit baseline distinct. Findings need retained evidence, a concrete trigger and failure/maintenance cost, and counterevidence. Resolve findings only with evidence that the triggering path is fixed, including fixes elsewhere on that path. No findings is valid. Preferences inform this rubric, never silently replace it. Confidence is qualitative, not calibrated probability. No acceptance or safe-to-merge verdict.";
const SLOP =
	"User-authored Slop seed: implicit coupling; layer-first folders; duplication; representable illegal states; god files; shotgun surgery; layering violations; pass-through wrappers; errors/validation away from boundaries; overly defensive code. Require code evidence and concrete maintenance/failure cost. Recognize legitimate adapters, trust boundaries, shared infrastructure, independent rules and real I/O/durability recovery. No line/file-count heuristics, blanket wrapper/duplication bans, speculative fallbacks, hidden errors or automatic architectural rewrites. Distinguish existing audit baseline from introduced debt.";

/** Optional definitions only. Importing does not persist, select models, learn preferences or run reviews. */
export function optionalReviewSeeds(): Record<string, ReviewProfileDefinition> {
	const profile = (purpose: string, rubric: string): ReviewProfileDefinition => ({
		version: 1,
		purpose,
		rubric: `${rubric} ${NET_CHANGE}`,
		applicableIntents: ["code", "native-ui", "research"],
		modelSelection: {
			unavailable: "No model selected; allowed catalog, suitability and availability require explicit assessment.",
		},
		reasoningEffort: null,
		timeLimitMs: null,
		outputInterpretation: {
			kind: "pass-fail",
			pass: "No evidenced introduced/worsened concerns under this rubric and stated coverage; not acceptance.",
			fail: "Evidenced introduced/worsened concerns require attention; not a delivery gate.",
		},
	});
	return {
		correctness: profile(
			"Correctness",
			"Assess intended outcomes, boundary cases and violated invariants with applicable retained content evidence. For non-code work, cite the pinned report/brief and its limitations, not invented code.",
		),
		security: profile(
			"Security",
			"Assess concrete trust boundaries, attacker prerequisites, exposed assets and evidenced failure paths. Do not invent threats or claim complete security coverage.",
		),
		maintainability: { ...profile("Maintainability / Slop", SLOP), applicableIntents: ["code"] },
		"human-attention": {
			...profile(
				"Human attention",
				"Explain where human judgement or missing information matters, consequences and the concrete question. Attention is not correctness severity, effort or authority.",
			),
			outputInterpretation: {
				kind: "attention",
				low: "Little human attention indicated within stated coverage.",
				medium: "A bounded judgement or clarification deserves attention.",
				high: "Material uncertainty/consequences require human attention; this does not create a policy gate.",
			},
		},
	};
}
