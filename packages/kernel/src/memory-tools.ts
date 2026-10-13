/** Project memory tools are backed by pilotd over the supervised worker channel. */

import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export type MemoryCall = (
	action: "wake" | "note" | "recall" | "zoom",
	args: Record<string, JsonValue>,
) => Promise<JsonValue>;

export function createMemoryTools(call: MemoryCall, sessionId: string): ToolDefinition[] {
	return [
		defineTool({
			name: "memory_note",
			label: "Note project memory",
			description:
				"Save one durable, project-wide fact, decision, user preference, or hard-won outcome. Note only lasting information that will help future chats. Do not repeat or paraphrase facts already present in project memory. Never store secrets, temporary status, task instructions, or speculation.",
			parameters: Type.Object({
				text: Type.String({
					minLength: 1,
					maxLength: 280,
					description: "One concise line, at most 280 UTF-8 bytes.",
				}),
			}),
			executionMode: "sequential",
			annotations: { openWorldHint: false },
			async execute(_id, params) {
				const data = await call("note", { text: params.text, sessionId });
				return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
			},
		}),
		defineTool({
			name: "memory_recall",
			label: "Recall project memory",
			description:
				"Search project memory using a case-insensitive regular expression. Returns bounded, newest-first matching notes.",
			parameters: Type.Object({ regex: Type.String({ maxLength: 512 }) }),
			executionMode: "sequential",
			annotations: { openWorldHint: false },
			async execute(_id, params) {
				const data = await call("recall", { regex: params.regex });
				return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
			},
		}),
		defineTool({
			name: "memory_zoom",
			label: "Zoom project memory",
			description:
				"Expand an inclusive #lo-hi range printed in project memory into its two child ranges. Use only ranges shown by wake or recall.",
			parameters: Type.Object({ lo: Type.Integer({ minimum: 0 }), hi: Type.Integer({ minimum: 1 }) }),
			executionMode: "sequential",
			annotations: { openWorldHint: false },
			async execute(_id, params) {
				const data = await call("zoom", { lo: params.lo, hi: params.hi });
				return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
			},
		}),
	];
}
