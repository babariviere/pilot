/** Control-chat navigation only. The daemon rechecks the supervised caller on every call. */
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ControlMemoryCall = (action: "zoom" | "date", args: Record<string, JsonValue>) => Promise<JsonValue>;
export function createControlMemoryTools(control: boolean, call: ControlMemoryCall): ToolDefinition[] {
	if (!control) return [];
	return [
		defineTool({
			name: "zoom",
			label: "Open chat memory",
			description: "Open line id+n into its two halves; n=1 gives the whole message, paged when long.",
			parameters: Type.Object({
				id: Type.Integer({ minimum: 0 }),
				n: Type.Integer({ minimum: 1, description: "Aligned power of two." }),
				offset: Type.Optional(Type.Integer({ minimum: 0, description: "Next page offset returned for n=1." })),
			}),
			executionMode: "sequential",
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, args) {
				const data = await call("zoom", args);
				return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
			},
		}),
		defineTool({
			name: "date",
			label: "Message date",
			description: "The date and time of message id.",
			parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
			executionMode: "sequential",
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, args) {
				const data = await call("date", args);
				return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
			},
		}),
	];
}
