/** The `db` tool: user-configured Postgres access, executed by pilotd. The kernel never sees connection URLs. */
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentQuestion } from "@pilot/protocol";
import { normalizeQuestion, type PublishQuestion } from "./question-tool.ts";

export const DATABASE_TOOL = "db";
export type DatabaseAction = "access" | "query";
export type DatabaseCall = (action: DatabaseAction, args: Record<string, JsonValue>) => Promise<JsonValue>;

const Param = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const Mode = Type.Union([Type.Literal("read"), Type.Literal("write")]);
const Rows = {
	columns: Type.Array(Type.String()),
	rows: Type.Array(Type.Record(Type.String(), Type.Unknown())),
	rowCount: Type.Union([Type.Number(), Type.Null()], { description: "Null when rows were cut off." }),
	truncated: Type.Boolean(),
};

export function createDatabaseTool(call: DatabaseCall, publish: PublishQuestion): ToolDefinition {
	return defineTool({
		name: DATABASE_TOOL,
		label: "Database",
		description:
			'Query the user\'s configured Postgres databases. access without env lists environments, their modes and your grants. access with env and mode requests access: it is granted at once, or the user is asked and your turn ends (their decision arrives as the next message). Grants last for this chat. query runs one SQL statement with $1 params (mode "read" by default, read-only). In mode "write", statements runs several statements in one transaction. Results are capped by maxRows (default 100).',
		promptSnippet: "Query configured Postgres databases",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("access"), Type.Literal("query")]),
			env: Type.Optional(Type.String({ maxLength: 64, description: "Environment name from access." })),
			mode: Type.Optional(
				Type.Union([Type.Literal("read"), Type.Literal("write")], { description: 'Defaults to "read".' }),
			),
			reason: Type.Optional(Type.String({ maxLength: 600, description: "access: one sentence shown to the user." })),
			sql: Type.Optional(Type.String({ description: "query: one statement." })),
			params: Type.Optional(Type.Array(Param, { description: "Values for $1, $2, ..." })),
			statements: Type.Optional(
				Type.Array(Type.Object({ sql: Type.String(), params: Type.Optional(Type.Array(Param)) }), {
					maxItems: 20,
					description: 'query in mode "write": run in one transaction.',
				}),
			),
			maxRows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
		}),
		outputSchema: Type.Union([
			Type.Object({
				environments: Type.Array(
					Type.Object({
						name: Type.String(),
						modes: Type.Record(Type.String(), Type.Union([Type.Literal("allow"), Type.Literal("ask")])),
						granted: Type.Array(Mode),
					}),
				),
			}),
			Type.Object({
				status: Type.Union([Type.Literal("granted"), Type.Literal("pending")]),
				env: Type.String(),
				mode: Mode,
			}),
			Type.Object({ env: Type.String(), mode: Mode, ...Rows }),
			Type.Object({ env: Type.String(), mode: Mode, results: Type.Array(Type.Object(Rows)) }),
		]),
		executionMode: "sequential",
		annotations: { openWorldHint: true },
		async execute(callId, params): Promise<AgentToolResult<JsonValue>> {
			const { action, ...rest } = params;
			const args = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Record<
				string,
				JsonValue
			>;
			const result = await call(action, args);
			const question = pendingQuestion(result);
			if (question) {
				await publish(callId, question);
				// The request id is only for the app's answer, so the agent never sees it.
				const pending = {
					status: "pending",
					env: question.databaseAccess!.env,
					mode: question.databaseAccess!.mode,
				};
				return {
					content: [
						{
							type: "text",
							text: "The user is asked to grant access. End your turn now; their decision arrives as the next user message.",
						},
					],
					details: pending,
					structuredContent: pending,
					terminate: true,
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
				structuredContent: result,
			};
		},
	});
}

function pendingQuestion(result: JsonValue): AgentQuestion | undefined {
	if (!result || typeof result !== "object" || Array.isArray(result) || result.status !== "pending") return undefined;
	const question = result.question as Parameters<typeof normalizeQuestion>[0] & { databaseAccess?: JsonValue };
	const access = question?.databaseAccess;
	if (
		!access ||
		typeof access !== "object" ||
		Array.isArray(access) ||
		typeof access.id !== "string" ||
		typeof access.env !== "string" ||
		(access.mode !== "read" && access.mode !== "write")
	)
		throw new Error("pilotd returned an access request without an id");
	// normalizeQuestion keeps only ask_user's fields, so ask_user itself can never carry databaseAccess.
	return {
		...normalizeQuestion({ ...question, multiSelect: false }),
		databaseAccess: { id: access.id, env: access.env, mode: access.mode },
	};
}
