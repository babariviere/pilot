import type { SlackMessageType, SlackProjectLabel, SlackCorrection } from "@pilot/protocol";

export interface SlackClassifierContext {
	labels: SlackProjectLabel[];
	corrections: SlackCorrection[];
	guide?: string;
}

/** External Slack content never supplies instructions, tools, project scope, or URLs. */
export interface SlackClassification {
	type: SlackMessageType;
	label: string | null;
	confidence: number;
	severity: "low" | "medium" | "high" | "critical";
	summary: string;
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
	required: ["type", "label", "confidence", "severity", "summary"],
	properties: {
		type: { type: "string", enum: ["bug", "question", "request", "unknown"] },
		label: { type: ["string", "null"], maxLength: 80 },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
		summary: { type: "string", minLength: 1, maxLength: 240 },
	},
} as const;

/** No markdown stripping, coercion, extraction from prose, or repair of malformed model output. */
export function parseSlackClassification(text: string, labels?: SlackProjectLabel[]): SlackClassification {
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
		Object.keys(value).sort().join(",") !== "confidence,label,severity,summary,type" ||
		!["bug", "question", "request", "unknown"].includes(value.type) ||
		typeof value.confidence !== "number" ||
		!Number.isFinite(value.confidence) ||
		value.confidence < 0 ||
		value.confidence > 1 ||
		!["low", "medium", "high", "critical"].includes(value.severity) ||
		typeof value.summary !== "string" ||
		!value.summary.trim() ||
		value.summary.length > 240 ||
		/[\r\n\x00-\x1f]/.test(value.summary) ||
		(value.label !== null &&
			(typeof value.label !== "string" ||
				!value.label.trim() ||
				value.label.length > 80 ||
				/[\x00-\x1f]/.test(value.label) ||
				(labels !== undefined && !labels.some((label) => label.name === value.label))))
	)
		throw invalid();
	return { ...value, summary: value.summary.trim() };
}
