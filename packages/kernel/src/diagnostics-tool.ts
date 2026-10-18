/** Content-free, read-only local diagnostics. pilotd owns authorization, host identity and bounded storage reads. */
import { Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DiagnosticTargetReference, SessionDiagnostics } from "@pilot/protocol";

export const DIAGNOSTICS_TOOL = "diagnostics";
export type DiagnosticsCall = (sessionId: string, limit?: number) => Promise<SessionDiagnostics>;

export function createDiagnosticsTool(call: DiagnosticsCall, target: DiagnosticTargetReference): ToolDefinition {
	return defineTool({
		name: DIAGNOSTICS_TOOL,
		label: "Diagnostics",
		description: `Read bounded operational evidence for the host-admitted target ${target.chatUrl} on ${target.host.hostId}. This never starts or changes the target and never returns conversation history, prompts, tool data, paths, credentials or raw errors. OS native crash/hang evidence is host-level and must not be attributed to the target without other evidence. Check host, freshness, source availability and truncation before drawing conclusions; cite evidence refs when reporting findings.`,
		promptSnippet: `Inspect bounded evidence for ${target.chatUrl}`,
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 128, description: "Maximum evidence items." })),
		}),
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_callId, params): Promise<AgentToolResult<SessionDiagnostics>> {
			const result = await call(target.sessionId, params.limit);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
