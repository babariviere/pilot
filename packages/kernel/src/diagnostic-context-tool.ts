import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DiagnosticContextRequest, DiagnosticContextResponse } from "@pilot/protocol";

export const DIAGNOSTIC_CONTEXT_TOOL = "diagnostic_context";
export type DiagnosticContextCall = (
	request: DiagnosticContextRequest,
	signal?: AbortSignal,
) => Promise<DiagnosticContextResponse>;
export function createDiagnosticContextTool(call: DiagnosticContextCall): ToolDefinition {
	return defineTool({
		name: DIAGNOSTIC_CONTEXT_TOOL,
		label: "Pilot context",
		description:
			"Read bounded app-wide chats, history/search, usage/budgets, failures, mission context and Pilot logs. Discover trusted hosts first. Focus is not authority. No wake, writes, credentials or uploads.",
		promptSnippet: "Read app-wide evidence through trusted diagnostics capability",
		parameters: Type.Object({
			action: Type.Union(
				["hosts", "chats", "chat", "history", "search", "logs", "projects", "missions", "mission", "issues", "features"].map(
					(v) => Type.Literal(v),
				),
			),
			host: Type.Optional(
				Type.Object({
					hostId: Type.String({ maxLength: 200 }),
					daemonId: Type.String({ maxLength: 200 }),
					lineageId: Type.String({ maxLength: 200 }),
				}),
			),
			sessionId: Type.Optional(Type.String({ maxLength: 36 })),
			projectId: Type.Optional(Type.String({ maxLength: 128 })),
			missionId: Type.Optional(Type.String({ maxLength: 128 })),
			query: Type.Optional(
				Type.String({ maxLength: 200, description: "Literal title/history filter, never regex or instructions." }),
			),
			after: Type.Optional(
				Type.String({ maxLength: 36, description: "Prior page.after; retain with page.before when present." }),
			),
			since: Type.Optional(Type.String({ maxLength: 10, description: "features only: inclusive UTC day YYYY-MM-DD" })),
			until: Type.Optional(Type.String({ maxLength: 10, description: "features only: inclusive UTC day YYYY-MM-DD" })),
			before: Type.Optional(Type.Integer({ minimum: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
			log: Type.Optional(
				Type.Union([
					Type.Object({ action: Type.Literal("inventory") }),
					Type.Object({
						action: Type.Literal("search"),
						source: Type.Union(
							[
								"app",
								"daemon",
								"kernel_worker",
								"native_report",
								"lifecycle",
								"request_timing",
								"tool_activity",
							].map((v) => Type.Literal(v)),
						),
						q: Type.Optional(Type.String({ maxLength: 200 })),
						since: Type.Optional(Type.String({ maxLength: 64 })),
						cursor: Type.Optional(Type.String({ maxLength: 768 })),
						limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
					}),
					Type.Object({
						action: Type.Literal("excerpt"),
						ref: Type.String({ maxLength: 768 }),
						before: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
						after: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
					}),
				]),
			),
		}),
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_id, params, signal) {
			const result = await call(params as DiagnosticContextRequest, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
