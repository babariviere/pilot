/** Bounded proposal publication for diagnostics specialists. It cannot create or mutate a repair or target chat. */
import { Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DiagnosticRepairProposal, DiagnosticRepairProposalDraft } from "@pilot/protocol";

export const REPAIR_PROPOSAL_TOOL = "repair_proposal";
export type RepairProposalCall = (draft: DiagnosticRepairProposalDraft) => Promise<DiagnosticRepairProposal>;

export function createRepairProposalTool(call: RepairProposalCall): ToolDefinition {
	return defineTool({
		name: REPAIR_PROPOSAL_TOOL,
		label: "Repair proposal",
		description:
			"Publish a bounded repair draft with an issue title and 1–16 exact diagnostic evidence refs. User review and native confirmation are required; this cannot start a repair or change any chat.",
		promptSnippet: "Publish a bounded repair suggestion for user review",
		parameters: Type.Object({
			repairTitle: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: 160,
					description: "Single-line issue-specific title, never raw logs or credentials.",
				}),
			),
			subject: Type.Optional(
				Type.Union([
					Type.Object({
						kind: Type.Literal("app"),
						host: Type.Object({ hostId: Type.String(), daemonId: Type.String(), lineageId: Type.String() }),
					}),
					Type.Object({
						kind: Type.Literal("chat"),
						host: Type.Object({ hostId: Type.String(), daemonId: Type.String(), lineageId: Type.String() }),
						sessionId: Type.String(),
						chatUrl: Type.String(),
					}),
				]),
			),
			evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 16 }),
			findings: Type.String({ minLength: 1, maxLength: 1200 }),
			uncertainty: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
			suggestedRepair: Type.String({ minLength: 1, maxLength: 1200 }),
			regressionTestGuidance: Type.String({ minLength: 1, maxLength: 800 }),
		}),
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_callId, params): Promise<AgentToolResult<DiagnosticRepairProposal>> {
			const result = await call(params);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
