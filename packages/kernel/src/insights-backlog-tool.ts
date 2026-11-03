import type { JsonValue } from "@earendil-works/chord";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export const INSIGHTS_BACKLOG_TOOL = "insights_backlog";
export type InsightsBacklogCall = (request: unknown) => Promise<unknown>;

export function createInsightsBacklogTool(call: InsightsBacklogCall): ToolDefinition {
	return defineTool({
		name: INSIGHTS_BACKLOG_TOOL,
		label: "Insights backlog",
		description:
			"Maintain only this integration's finding tracking records and review reports/checkpoints. Never executes fixes. list/get require kind finding/report/checkpoint. history/evidence page by key and cursor. propose requires a stable UUID key and expectedRevision=0; amend uses its current revision. Reuse finding keys for recurring patterns; evidence UUID keys are immutable. Draft: title, priority(low/medium/high), observation, uncertainty, proposedChange, expectedBenefit, targets[{projectId,label}], implementationLinks, optional cost{baseline,assumptions,estimate,qualityRisks,laterResult}. Estimates/results are claims, not verification. save_report/save_checkpoint require record{status(partial/interrupted/completed),windowStart,windowEnd,markdown,checkpoints[{sessionId,streamId(nullable),before(nullable),after(nullable),throughEntry(nullable),coverage(partial/unavailable/sampled),gaps}],findingKeys,gaps}. Missing stream continuity is a gap, never silently advance. Save receipts prove persistence only, not coverage or scheduling completion. Writes require operationId; after lost ACK use receipt lookup first, unknown never authorizes replay. No model approval, lifecycle confirmation, source/target-project writes, ordinary task edits, worker starts or repair.",
		parameters: Type.Object({
			action: StringEnum([
				"list",
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
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
			expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
			operationId: Type.Optional(Type.String({ maxLength: 128 })),
			draft: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			evidence: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 20 })),
			record: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		executionMode: "sequential",
		annotations: { openWorldHint: false },
		async execute(_id, params) {
			const result = await call(params);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result as JsonValue };
		},
	});
}
