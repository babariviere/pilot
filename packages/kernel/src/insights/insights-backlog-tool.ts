import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "../schema.ts";

export const INSIGHTS_BACKLOG_TOOL = "insights_backlog";
export type InsightsBacklogCall = (request: unknown) => Promise<unknown>;

const uuid = (description?: string) =>
	Type.String({ pattern: "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", description });
const text = (maxLength = 1000, description?: string) => Type.String({ minLength: 1, maxLength, description });
const date = (description?: string) =>
	Type.String({ minLength: 1, maxLength: 40, pattern: "^\\d{4}-\\d{2}-\\d{2}T", description });
const draft = Type.Object(
	{
		title: text(200),
		priority: StringEnum(["low", "medium", "high"]),
		observation: text(),
		uncertainty: text(),
		proposedChange: text(),
		expectedBenefit: text(),
		targets: Type.Array(Type.Object({ projectId: text(128), label: text(200) }, { additionalProperties: false }), {
			maxItems: 8,
		}),
		implementationLinks: Type.Array(Type.String({ maxLength: 512, pattern: "^(https://|pilot://)" }), {
			maxItems: 20,
			description: "Use [] when no implementation exists.",
		}),
		cost: Type.Optional(
			Type.Object(
				{
					baseline: text(),
					assumptions: text(),
					estimate: text(),
					qualityRisks: text(),
					laterResult: text(1000, 'Use "unknown" if the result has not been measured.'),
				},
				{
					additionalProperties: false,
					description: "Omit cost unless the finding concerns cost. All five fields must be nonempty.",
				},
			),
		),
	},
	{ additionalProperties: false, description: "Required for propose or amend." },
);
const evidence = Type.Array(
	Type.Object(
		{
			key: uuid("A new lowercase UUID for this citation."),
			sessionId: uuid("Copy evidence.sessionId from review_context."),
			ref: text(512, "Copy the entry ref from evidence.receipt.data.entries."),
			observedAt: date("Copy evidence.receipt.collectedAt if the entry has no timestamp."),
			classification: StringEnum(["observed", "inferred"]),
			summary: text(1000, "Briefly explain what the cited entry shows."),
		},
		{ additionalProperties: false },
	),
	{
		maxItems: 20,
		description: "Required for propose or amend. Cite entries from review_context; do not copy entire excerpts.",
	},
);
const nullableIndex = Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]);
const record = Type.Object(
	{
		status: StringEnum(["partial", "interrupted", "completed"]),
		windowStart: date("Copy run.windowStart."),
		windowEnd: date("Copy run.windowEnd."),
		markdown: text(16000),
		checkpoints: Type.Array(
			Type.Object(
				{
					sessionId: uuid(),
					streamId: Type.Union([text(128), Type.Null()]),
					before: nullableIndex,
					after: Type.Union([uuid(), Type.Null()]),
					throughEntry: nullableIndex,
					coverage: StringEnum(["partial", "unavailable", "sampled"]),
					gaps: Type.Array(text(500), { maxItems: 8 }),
				},
				{ additionalProperties: false },
			),
			{
				maxItems: 20,
				description: "Use [] if not claiming a checkpoint. Pilot derives coverage from its own receipts.",
			},
		),
		findingKeys: Type.Array(uuid(), { maxItems: 20, description: "Include only confirmed finding UUIDs." }),
		gaps: Type.Array(text(500), { maxItems: 20 }),
	},
	{ additionalProperties: false, description: "Required for save_report or save_checkpoint." },
);

export function createInsightsBacklogTool(call: InsightsBacklogCall, freshDayReport = false) {
	return defineTool({
		name: INSIGHTS_BACKLOG_TOOL,
		label: "Insights backlog",
		description: [
			"Maintain only this integration's findings and review records. Never executes fixes.",
			freshDayReport
				? "Read current evidence via review_context with cursor only. Prior tracking and receipt lookup are unavailable. Propose supported findings with a UUID key, expectedRevision=0, a stable patternKey, a draft and its evidence citations. Pilot rejects duplicate patterns. Do not replay a write with an unknown outcome."
				: "list/get require kind finding/report/checkpoint. history/evidence page by key and cursor. propose requires a stable UUID key and expectedRevision=0; amend uses its current revision. Reuse finding keys for recurring patterns. After a lost ACK, use receipt lookup first; unknown never authorizes replay.",
			"Evidence UUID keys are immutable. Writes require operationId. Save receipts prove persistence only. No model approval, lifecycle confirmation, source writes or repair.",
		].join(" "),
		parameters: Type.Object({
			action: StringEnum([
				"list",
				"review_context",
				"get",
				"history",
				"evidence",
				"receipt",
				"propose",
				"amend",
				"save_report",
				"save_checkpoint",
			] as const),
			kind: Type.Optional(StringEnum(["finding", "report", "checkpoint"] as const)),
			key: Type.Optional(Type.String({ maxLength: 36 })),
			cursor: Type.Optional(Type.Integer({ minimum: 0 })),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 20, description: "Only for list, history or evidence." }),
			),
			expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
			operationId: Type.Optional(Type.String({ maxLength: 128 })),
			patternKey: Type.Optional(Type.String({ maxLength: 200 })),
			draft: Type.Optional(draft),
			evidence: Type.Optional(evidence),
			record: Type.Optional(record),
		}),
		executionMode: "sequential",
		annotations: { openWorldHint: false },
		async execute(_id, params) {
			const result = await call(params);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result as JsonValue };
		},
	});
}
