/** Session-scoped Harness documents. No checkout files, timers, or SDK imports. */
import { randomBytes } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import type { SessionTodo, TodosUpdateEvent } from "@pilot/protocol";

export const TODO_LIMIT = 256;
export const TODO_BODY_BYTES = 64 * 1024;
export const TODO_STORE_BYTES = 1024 * 1024;

export type TodoRecord = {
	id: string;
	title: string;
	status: string;
	tags: string[];
	body: string;
	created_at: string;
	assigned_to_session?: string;
};
export interface TodoArgs {
	action: "list" | "listAll" | "get" | "create" | "update" | "append" | "delete" | "claim" | "release";
	id?: string;
	title?: string;
	status?: string;
	tags?: string[];
	body?: string;
	force?: boolean;
}
export type TodoResult = TodoRecord | Omit<TodoRecord, "body">[];
export type TodoCall = (args: TodoArgs, actor: string) => Promise<TodoResult>;
export const TodosDoc = defineDoc<{ items: TodoRecord[] }>({
	kind: "pilot.todos",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
	checkpointWhen: () => true,
});
/** Small projection: counts and UI subscriptions never materialize Markdown bodies. */
export type TodoProgress = { items: { [K in keyof SessionTodo]: SessionTodo[K] }[]; openCount: number };
export const TodoProgressDoc = defineDoc<TodoProgress>({
	kind: "pilot.todo-progress",
	version: 1,
	scope: "session",
	initial: () => ({ items: [], openCount: 0 }),
	checkpointWhen: () => true,
});
export const todoClosed = (status: string): boolean => ["closed", "done"].includes(status.toLowerCase());
export function todoProgress(items: TodoRecord[]): { items: SessionTodo[]; openCount: number } {
	return {
		openCount: items.filter((item) => !todoClosed(item.status)).length,
		items: items.map((item) => ({
			id: item.id,
			title: item.title,
			status: item.status,
			createdAt: item.created_at,
			...(item.assigned_to_session ? { assignedToSession: item.assigned_to_session } : {}),
		})),
	};
}
export function todosUpdate(state: { items: SessionTodo[] } | null | undefined): TodosUpdateEvent {
	return { type: "todos_update", items: state?.items.map((item) => ({ ...item })) ?? [] };
}
function bounded(value: unknown, name: string, bytes: number, empty = true): asserts value is string {
	if (typeof value !== "string" || (!empty && !value.trim()) || Buffer.byteLength(value) > bytes)
		throw new Error(`${name} must be ${empty ? "a" : "a nonempty"} string of at most ${bytes} UTF-8 bytes`);
}
/** Validate even direct child requests, not just SDK schema-checked calls. */
export function validateTodoArgs(args: TodoArgs, actor: string): void {
	if (
		!args ||
		!["list", "listAll", "get", "create", "update", "append", "delete", "claim", "release"].includes(args.action)
	)
		throw new Error("Unknown todo action");
	bounded(actor, "Actor", 256, false);
	if (args.id !== undefined) bounded(args.id, "ID", 64, false);
	if (args.title !== undefined) bounded(args.title, "Title", 1024, false);
	if (args.status !== undefined) bounded(args.status, "Status", 64, false);
	if (args.body !== undefined) bounded(args.body, "Body", TODO_BODY_BYTES);
	if (args.tags !== undefined) {
		if (!Array.isArray(args.tags) || args.tags.length > 32) throw new Error("At most 32 tags are allowed");
		for (const tag of args.tags) bounded(tag, "Tag", 64, false);
	}
	if (args.force !== undefined && typeof args.force !== "boolean") throw new Error("force must be boolean");
}
export const todoRead = (action: TodoArgs["action"]): boolean => ["list", "listAll", "get"].includes(action);
/** Mutates only the caller's transaction-local copy. Failed limits never discard older todos. */
export function applyTodo(items: TodoRecord[], args: TodoArgs, actor: string): TodoResult {
	validateTodoArgs(args, actor);
	if (args.action === "list" || args.action === "listAll")
		return items
			.filter((item) => args.action === "listAll" || !todoClosed(item.status))
			.sort(
				(a, b) =>
					Number(todoClosed(a.status)) - Number(todoClosed(b.status)) ||
					Number(!!b.assigned_to_session) - Number(!!a.assigned_to_session) ||
					a.created_at.localeCompare(b.created_at) ||
					a.id.localeCompare(b.id),
			)
			.map(({ body: _body, ...item }) => ({ ...item, tags: [...item.tags] }));
	let item: TodoRecord;
	if (args.action === "create") {
		if (args.title === undefined) throw new Error("create requires title");
		if (items.length >= TODO_LIMIT)
			throw new Error(`Todo limit (${TODO_LIMIT}) reached; delete obsolete items first`);
		let id: string;
		do {
			id = `TODO-${randomBytes(4).toString("hex")}`;
		} while (items.some((item) => item.id === id));
		item = {
			id,
			title: args.title,
			status: args.status ?? "open",
			tags: args.tags ?? [],
			body: args.body ?? "",
			created_at: new Date().toISOString(),
		};
		items.push(item);
	} else {
		const id = args.id
			?.trim()
			.replace(/^#/, "")
			.replace(/^TODO-/i, "")
			.toLowerCase();
		if (!id || !/^[a-f0-9]{8}$/.test(id)) throw new Error("Expected TODO-<8 hex digits> or raw hex ID");
		const index = items.findIndex((item) => item.id === `TODO-${id}`);
		if (index < 0) throw new Error(`Todo not found: TODO-${id}`);
		item = items[index];
		if (args.action === "get") return structuredClone(item);
		if (args.action === "delete") items.splice(index, 1);
		if (args.action === "update") {
			for (const key of ["title", "status", "tags", "body"] as const)
				if (args[key] !== undefined) Object.assign(item, { [key]: args[key] });
		}
		if (args.action === "append") {
			if (args.body === undefined) throw new Error("append requires body");
			item.body += `${item.body && args.body ? "\n\n" : ""}${args.body}`;
		}
		if (args.action === "claim" || args.action === "release") {
			if (item.assigned_to_session && item.assigned_to_session !== actor && !args.force)
				throw new Error("Todo is assigned to another agent; use force to override");
			if (args.action === "claim") {
				if (todoClosed(item.status)) throw new Error("Reopen a closed todo before claiming it");
				item.assigned_to_session = actor;
			} else delete item.assigned_to_session;
		}
	}
	if (todoClosed(item.status)) delete item.assigned_to_session;
	bounded(item.body, "Body", TODO_BODY_BYTES);
	if (Buffer.byteLength(JSON.stringify(items)) > TODO_STORE_BYTES)
		throw new Error("Todo storage limit (1 MiB) reached; shorten or delete obsolete items first");
	return structuredClone(item);
}
