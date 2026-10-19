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
	const description = target
		? `Read bounded operational evidence for the host-admitted target ${target.chatUrl} on ${target.host.hostId}. This never starts or changes the target and never returns conversation history, prompts, tool data, paths, credentials or raw errors. OS native crash/hang evidence is host-level and must not be attributed to the target without other evidence. Check host, freshness, source availability and truncation before drawing conclusions; cite evidence refs when reporting findings.`
		: `Read a bounded content-free app/host snapshot for ${host.hostId}, including connectivity, aggregate chat state and daemon resource evidence. There is no attached chat, session identifier or transcript authority. This never starts, opens or changes a chat. Check local collection coverage and unavailable fields before drawing conclusions.`;
	return defineTool({
		name: DIAGNOSTICS_TOOL,
		label: "Diagnostics",
		description,
		promptSnippet: target ? `Inspect bounded evidence for ${target.chatUrl}` : `Inspect ${host.hostId} app health`,
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 128, description: "Maximum evidence items." })),
		}),
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_callId, params): Promise<AgentToolResult<DiagnosticSnapshot>> {
			const result = await call(target?.sessionId, params.limit);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
