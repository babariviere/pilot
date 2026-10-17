/** Content-free, read-only local diagnostics. pilotd owns authorization, host identity and bounded storage reads. */
import { Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionDiagnostics } from "@pilot/protocol";

export const DIAGNOSTICS_TOOL = "diagnostics";
export type DiagnosticsCall = (sessionId: string, limit?: number) => Promise<SessionDiagnostics>;

export function createDiagnosticsTool(call: DiagnosticsCall, currentSessionId: string): ToolDefinition {
	return defineTool({
		name: DIAGNOSTICS_TOOL,
		label: "Diagnostics",
		description:
			"Read bounded operational evidence for this chat or another chat in the same project on this host. This never starts or changes the target and never returns conversation history, prompts, tool data, paths, credentials or raw errors. Check host, freshness, source availability and truncation before drawing conclusions; cite evidence refs when reporting findings.",
		promptSnippet: "Inspect bounded local lifecycle and performance evidence",
		parameters: Type.Object({
			sessionId: Type.Optional(
				Type.String({
					maxLength: 80,
					description: "Target chat ID. Omit to inspect this chat.",
				}),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 128, description: "Maximum evidence items." })),
		}),
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_callId, params): Promise<AgentToolResult<SessionDiagnostics>> {
			const result = await call(params.sessionId ?? currentSessionId, params.limit);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
