/** The `slack_status` tool: a chat started from a Slack message reports that it waits for someone else. Executed by pilotd. */
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export const SLACK_STATUS_TOOL = "slack_status";
export type SlackStatusCall = (args: Record<string, JsonValue>) => Promise<JsonValue>;

export function createSlackStatusTool(call: SlackStatusCall): ToolDefinition {
	return defineTool({
		name: SLACK_STATUS_TOOL,
		label: "Slack status",
		description:
			'Only for a chat started from a Slack message. Set "waiting" with a short reason when you can\'t continue until someone outside Pilot answers in the thread (a CSM, the reporter): ask them in Slack first if needed, then end your turn. Their next reply resumes this chat with the new messages. Set "in_progress" when you continue without waiting. The user owns other statuses.',
		promptSnippet: "Mark the chat's Slack message as waiting for a reply",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("waiting"), Type.Literal("in_progress")]),
			reason: Type.Optional(
				Type.String({
					maxLength: 200,
					description: 'waiting: who and what you wait for, e.g. "CSM to confirm the org ID".',
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_callId, params): Promise<AgentToolResult<JsonValue>> {
			const args: Record<string, JsonValue> = { status: params.status };
			if (params.reason !== undefined) args.reason = params.reason;
			const result = await call(args);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
