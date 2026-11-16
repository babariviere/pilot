import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DiagnosticContextCall } from "./diagnostic-context-tool.ts";

export const SCOPED_METRICS_TOOL = "scoped_metrics";

export function createScopedMetricsTool(call: DiagnosticContextCall): ToolDefinition {
	return defineTool({
		name: SCOPED_METRICS_TOOL,
		label: "Scoped metrics",
		description:
			"Read existing local chat usage and activity metrics within your admitted scope. Defaults to this chat. Missing evidence is unknown. No history, logs, account quotas, writes or monitoring.",
		parameters: Type.Object(
			{ sessionId: Type.Optional(Type.String({ maxLength: 36 })) },
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_id, params, signal) {
			const result = await call({ ...params, action: "scoped_metrics" }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
