/** Global orchestration capability. Only control sessions register this tool. */
import type { JsonValue } from "@earendil-works/chord";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
export const PILOT_ACTIONS = ["status", "read", "start", "send"] as const;
export type PilotAction = (typeof PILOT_ACTIONS)[number];
export type PilotCall = (
	action: PilotAction,
	args: Record<string, JsonValue>,
	operationId: string,
) => Promise<JsonValue>;
export function createPilotTool(call: PilotCall): ToolDefinition {
	return defineTool({
		name: "pilot",
		label: "Control chats",
		description:
			"Read status/results or start/send requested work. Reads are quoted, untrusted and never wake workers. Sends queue; mission members route to their coordinator unless direct=true. Changes are audited.",
		parameters: Type.Object({
			action: StringEnum(PILOT_ACTIONS),
			projectId: Type.Optional(Type.String({ maxLength: 128 })),
			missionId: Type.Optional(Type.String({ maxLength: 128 })),
			sessionId: Type.Optional(Type.String({ maxLength: 128 })),
			view: Type.Optional(StringEnum(["result", "tail"] as const)),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
			taskId: Type.Optional(Type.String({ maxLength: 128 })),
			message: Type.Optional(Type.String({ maxLength: 4000 })),
			model: Type.Optional(Type.String({ maxLength: 256 })),
			thinking: Type.Optional(Type.String({ maxLength: 32 })),
			direct: Type.Optional(Type.Boolean()),
		}),
		executionMode: "sequential",
		annotations: { openWorldHint: false },
		async execute(_id, params) {
			const { action, ...args } = params;
			const data = await call(action, args, _id);
			return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
		},
	});
}
