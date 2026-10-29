import type { MissionClassification } from "@pilot/protocol";

/** Exact bounded write shape; legacy reads never run through this parser. */
export function classificationWrite(value: unknown): MissionClassification {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("classification must be an object");
	const input = value as Record<string, unknown>;
	const dimensions = {
		effort: ["small", "medium", "large", "unknown"],
		difficulty: ["routine", "substantive", "hard", "unknown"],
		risk: ["low", "medium", "high", "unknown"],
		uncertainty: ["known", "unknown"],
		scope: ["bounded", "expanded", "unknown"],
		role: ["builder", "explorer", "reviewer", "unknown"],
		deliveryKind: ["code", "native-ui", "research", "unknown"],
	};
	if (Object.keys(input).sort().join() !== [...Object.keys(dimensions), "version"].sort().join())
		throw new Error("Invalid classification fields");
	if (input.version !== 1) throw new Error("Unsupported classification version");
	for (const [name, values] of Object.entries(dimensions))
		if (!values.includes(input[name] as string)) throw new Error(`Invalid classification ${name}`);
	return {
		version: 1,
		...Object.fromEntries(Object.keys(dimensions).map((key) => [key, input[key]])),
	} as MissionClassification;
}

/** Balanced preset recommendation only. No caller may use it as an admission or delivery grant. */
export function classificationAdvice(value: MissionClassification | undefined) {
	let classification: MissionClassification | undefined;
	try {
		classification = classificationWrite(value);
	} catch {
		// Missing/future stored assessments stay inspectable and unknown, not routine by default.
	}
	const c = classification;
	const reasons: string[] = [];
	const needsRescope = c?.scope === "expanded";
	if (needsRescope) reasons.push("Scope exceeds the approved assignment; coordinator rescoping is needed.");
	const safetyUnknown = !c || c.risk === "unknown" || c.uncertainty === "unknown" || c.scope === "unknown";
	if (safetyUnknown) reasons.push("Safety-relevant risk, uncertainty or scope is unknown.");
	if (c) reasons.push(`Declared difficulty: ${c.difficulty}; risk: ${c.risk}. Effort does not select authority.`);
	const tier =
		needsRescope || safetyUnknown || c?.risk === "high" || c?.difficulty === "hard" || c?.difficulty === "unknown"
			? "T3"
			: c?.difficulty === "substantive" || c?.risk === "medium"
				? "T2"
				: "T1";
	const review = tier === "T3" ? "specialist-and-human" : tier === "T2" ? "full-independent" : "targeted-independent";
	const deliveryBaseline = tier === "T3" ? "human-gate" : "automatic-after-all-gates";
	reasons.push(`Balanced ${tier}: ${review} review; ${deliveryBaseline}. Checks remain mandatory.`);
	if (
		c?.effort === "medium" &&
		c.difficulty !== "hard" &&
		c.difficulty !== "unknown" &&
		!safetyUnknown &&
		!needsRescope
	)
		reasons.push(
			"Known medium-effort work can be assessed for a midrange model, including Terra if configured; no fixed mapping.",
		);
	if (c?.role === "reviewer")
		reasons.push("Independent reviewer suitability is assessed separately from builder effort.");
	if (c?.deliveryKind === "research")
		reasons.push("Research is a declared intent, not proof of code-free work or no contributions.");
	return {
		classification: c ?? null,
		tier,
		review,
		deliveryBaseline,
		needsRescope,
		reasons,
		advisoryOnly: true,
	} as const;
}
