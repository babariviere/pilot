/** Non-executing update proposals, admitted and validated by the supervising daemon. */
import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LiveUpdateProposalArgs } from "@pilot/protocol";
import { Type } from "typebox";
import type { KernelSpec } from "./protocol.ts";

export type LiveUpdateProposalCall = (args: LiveUpdateProposalArgs, operationId: string) => Promise<JsonValue>;

/** The flag is host-derived, not project discovery or model-supplied authority. */
export function createLiveUpdateTools(spec: KernelSpec, call?: LiveUpdateProposalCall): ToolDefinition[] {
	if (
		!spec.liveUpdateProposals ||
		!spec.projectId ||
		!call ||
		spec.pilot?.ask ||
		spec.role ||
		spec.pilot?.executionPermission?.level === "investigate" ||
		spec.pilot?.coordinatorView ||
		spec.mission?.sharedContext ||
		spec.mission?.role === "explorer" ||
		spec.mission?.role === "reviewer"
	)
		return [];
	return [
		defineTool({
			name: "pilot_update",
			label: "Propose Pilot update",
			description:
				"Propose an already-built local Pilot release for native user review. Does not accept, cancel, install or restart anything. The user must approve in Pilot. Reuse operationId after an interrupted proposal.",
			parameters: Type.Object(
				{
					directory: Type.String({
						minLength: 1,
						maxLength: 4096,
						pattern: "^/[^\\u0000]*$",
						description: "Absolute local built app release directory.",
					}),
					source: Type.String({ pattern: "^[0-9a-f]{40}$" }),
					build: Type.String({
						maxLength: 128,
						pattern: "^[0-9]+(?:\\.[0-9]+)*$",
						description: "Numeric dotted GUI build identifier.",
					}),
					summary: Type.String({ minLength: 1, maxLength: 2000 }),
					operationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
				},
				{ additionalProperties: false },
			),
			executionMode: "sequential",
			annotations: { destructiveHint: false, openWorldHint: false },
			async execute(id, params) {
				const { directory, source, build, summary } = params;
				const data = await call({ directory, source, build, summary }, params.operationId ?? id);
				return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
			},
		}),
	];
}
