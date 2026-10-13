/** External Slack content never supplies instructions, tools, project scope, or URLs. */
export interface SlackClassification {
	isBugReport: boolean;
	confidence: number;
	severity: "low" | "medium" | "high" | "critical";
	summary: string;
	guessedProject: string | null;
}
export class SlackModelUnavailable extends Error {
	constructor() {
		super(
			"Slack classification requires scoped, authenticated openai-codex/gpt-6-luna. Check pi model settings and sign-in.",
		);
	}
}

export const SLACK_CLASSIFICATION_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["isBugReport", "confidence", "severity", "summary", "guessedProject"],
	properties: {
		isBugReport: { type: "boolean" },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
		summary: { type: "string", minLength: 1, maxLength: 240 },
		guessedProject: { type: ["string", "null"], maxLength: 120 },
	},
} as const;

/** No markdown stripping, coercion, extraction from prose, or repair of malformed model output. */
export function parseSlackClassification(text: string): SlackClassification {
	const invalid = () => new Error("Invalid Slack classification");
	if (Buffer.byteLength(text) > 4096) throw invalid();
	let value: SlackClassification;
	try {
		value = JSON.parse(text);
	} catch {
		throw invalid();
	}
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== "confidence,guessedProject,isBugReport,severity,summary" ||
		typeof value.isBugReport !== "boolean" ||
		typeof value.confidence !== "number" ||
		!Number.isFinite(value.confidence) ||
		value.confidence < 0 ||
		value.confidence > 1 ||
		!["low", "medium", "high", "critical"].includes(value.severity) ||
		typeof value.summary !== "string" ||
		!value.summary.trim() ||
		value.summary.length > 240 ||
		/[\r\n\x00-\x1f]/.test(value.summary) ||
		(value.guessedProject !== null &&
			(typeof value.guessedProject !== "string" ||
				value.guessedProject.length > 120 ||
				/[\x00-\x1f]/.test(value.guessedProject)))
	)
		throw invalid();
	return { ...value, summary: value.summary.trim() };
}
