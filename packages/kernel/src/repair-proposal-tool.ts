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
			"Publish one bounded, non-executing repair suggestion after the user asks for it. Base every finding on diagnostics evidence, cite 1–16 exact evidence refs, state uncertainty plainly, and propose a regression test. This only saves a draft for user review; it cannot create a coding chat, execute a repair, read a transcript, change the target, or retry, restart or replay anything.",
		promptSnippet: "Publish a bounded repair suggestion for user review",
		parameters: Type.Object({
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
