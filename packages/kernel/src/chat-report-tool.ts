/** The `chat_report` tool: a chat started from Slack, Linear or a schedule saves its answer for the user's result page. Executed by pilotd. */
import type { JsonValue } from "@earendil-works/chord/json";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CHAT_REPORT_TOOL = "chat_report";
export type ChatReportCall = (args: Record<string, JsonValue>) => Promise<JsonValue>;

export function createChatReportTool(call: ChatReportCall): ToolDefinition {
	return defineTool({
		name: CHAT_REPORT_TOOL,
		label: "Chat report",
		description:
			"This chat was started from Slack, Linear or a schedule, so the user reads its result later on a result page, not in the chat. Before you end, save the answer with this tool. A new call replaces the earlier report. Write plain sentences for someone who did not follow the work. Limits: answer 8,000 characters; howItKnows, limits and nextStep 2,000 each; 10 links. Put longer material in links or artifacts. Saving a report does not mark anything done; the user checks the result.",
		promptSnippet: "Save this job chat's answer for the user's result page",
		parameters: Type.Object({
			answer: Type.String({ description: "The answer or outcome, in a few sentences first, then any detail." }),
			howItKnows: Type.Optional(Type.String({ description: "The sources, checks or evidence behind the answer." })),
			limits: Type.Optional(Type.String({ description: "What you did not check, assumptions and open doubts." })),
			nextStep: Type.Optional(Type.String({ description: "What the user should do next, if anything." })),
			links: Type.Optional(
				Type.Array(
					Type.Object({
						url: Type.String({ description: "https://, http:// or pilot:// URL" }),
						title: Type.Optional(Type.String()),
					}),
				),
			),
		}),
		executionMode: "sequential",
		async execute(_callId, params): Promise<AgentToolResult<JsonValue>> {
			const result = await call(params as unknown as Record<string, JsonValue>);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
