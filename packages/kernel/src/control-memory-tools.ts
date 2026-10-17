/** Control-chat navigation only. The daemon rechecks the supervised caller on every call. */
import type { JsonValue } from "@earendil-works/chord";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ControlMemoryCall = (action: "zoom" | "date", args: Record<string, JsonValue>) => Promise<JsonValue>;
export function createControlMemoryTools(control: boolean, call: ControlMemoryCall): ToolDefinition[] {
	if (!control) return [];
	return [
		defineTool({
			name: "history",
			label: "Chat history",
			description:
				"Read control-chat history. zoom: open line id+n into its two halves; requires n. n=1 gives the whole message, paged when long. date: get message id's date and time.",
			parameters: Type.Object({
				action: StringEnum(["zoom", "date"] as const),
				id: Type.Integer({ minimum: 0 }),
				n: Type.Optional(Type.Integer({ minimum: 1, description: "Required for zoom. Aligned power of two." })),
				offset: Type.Optional(Type.Integer({ minimum: 0, description: "Next page offset returned for n=1." })),
			}),
			executionMode: "sequential",
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, params) {
				const args: Record<string, JsonValue> = { id: params.id };
				switch (params.action) {
					case "zoom":
						if (params.n === undefined) throw new Error("History zoom requires n");
						args.n = params.n;
						if (params.offset !== undefined) args.offset = params.offset;
						break;
					case "date":
						break;
					default:
						throw new Error("Unknown history action");
				}
				const data = await call(params.action, args);
				return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
			},
		}),
	];
}
