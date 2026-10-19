/** Content-free, read-only local diagnostics. pilotd owns authorization, host identity and bounded storage reads. */
import { Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DiagnosticSnapshot, DiagnosticTargetReference, OperationHost } from "@pilot/protocol";

export const DIAGNOSTICS_TOOL = "diagnostics";
export type DiagnosticsCall = (sessionId?: string, limit?: number) => Promise<DiagnosticSnapshot>;
export type DiagnosticsScope =
	| { kind: "app"; host: OperationHost }
	| { kind: "chat"; target: DiagnosticTargetReference };

export function createDiagnosticsTool(call: DiagnosticsCall, scope: DiagnosticsScope): ToolDefinition {
	const target = scope.kind === "chat" ? scope.target : undefined;
	const host = scope.kind === "chat" ? scope.target.host : scope.host;
	const description =
		"Read bounded content-free operational evidence for a known chat on this host or initial focus/app health. No wake or mutation. Use diagnostic_context for app-wide discovery, history and linked hosts.";
	return defineTool({
		name: DIAGNOSTICS_TOOL,
		label: "Diagnostics",
		description,
		promptSnippet: target ? `Inspect bounded evidence for ${target.chatUrl}` : `Inspect ${host.hostId} app health`,
		parameters: Type.Object({
			sessionId: Type.Optional(
				Type.String({ maxLength: 36, description: "Known chat on this host; omit for focus/app health." }),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 128, description: "Maximum evidence items." })),
		}),
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_callId, params): Promise<AgentToolResult<DiagnosticSnapshot>> {
			const result = await call(params.sessionId ?? target?.sessionId, params.limit);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
