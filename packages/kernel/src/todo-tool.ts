import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { TODO_BODY_BYTES, type TodoCall } from "./todos.ts";

export function createTodoTool(call: TodoCall, actor: () => string) {
	const summary = {
		id: Type.String(),
		title: Type.String(),
		status: Type.String(),
		tags: Type.Array(Type.String()),
		created_at: Type.String(),
		assigned_to_session: Type.Optional(Type.String()),
	};
	return defineTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage this chat's durable todos, shared with its subagents. list: open items; listAll: all summaries; get: full item; create: title required; update: replace supplied fields; append: add body; delete: remove; claim/release: assign to this agent (force overrides another). IDs accept TODO-<hex> or raw hex. done/closed are closed; all other statuses remain open. Limits: 256 items, 64 KiB body each, 1 MiB total. Never reads workspace .pi/todos files.",
		parameters: Type.Object({
			action: StringEnum([
				"list",
				"listAll",
				"get",
				"create",
				"update",
				"append",
				"delete",
				"claim",
				"release",
			] as const),
			id: Type.Optional(Type.String({ maxLength: 64 })),
			title: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
			status: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
			body: Type.Optional(Type.String({ maxLength: TODO_BODY_BYTES })),
			tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 })),
			force: Type.Optional(Type.Boolean()),
		}),
		executionMode: "sequential",
		annotations: { openWorldHint: false },
		outputSchema: Type.Union([Type.Array(Type.Object(summary)), Type.Object({ ...summary, body: Type.String() })]),
		async execute(_id, params, signal) {
			signal?.throwIfAborted();
			const data = await call(params, actor());
			return { content: [{ type: "text", text: JSON.stringify(data) }], details: data, structuredContent: data };
		},
	});
}
