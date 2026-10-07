/** Display-only reader for pi-extensions/extensions/todos. The extension owns all writes. */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionTodo, TodosUpdateEvent } from "@pilot/protocol";

export function todosDirectory(cwd: string, override = process.env.PI_TODO_PATH): string {
	return resolve(cwd, override?.trim() || ".pi/todos");
}

/** Find the JSON object's end without confusing braces in titles with front matter. */
export function parseTodo(content: string, id: string): SessionTodo | undefined {
	const source = content.trimStart();
	if (!source.startsWith("{")) return undefined;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
		} else if (char === '"') quoted = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) {
			try {
				const value = JSON.parse(source.slice(0, i + 1));
				if (typeof value.title !== "string" || typeof value.status !== "string") return undefined;
				return {
					id: `TODO-${id.toLowerCase()}`,
					title: value.title,
					status: value.status,
					createdAt: typeof value.created_at === "string" ? value.created_at : "",
					...(typeof value.assigned_to_session === "string" && value.assigned_to_session
						? { assignedToSession: value.assigned_to_session }
						: {}),
				};
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/** Poll only while a chat is subscribed, including during long-running codemode calls. */
export class TodosWatch {
	#items = new Map<string, SessionTodo>();
	#listeners = new Set<(event: TodosUpdateEvent) => void>();
	#timer?: ReturnType<typeof setInterval>;
	#refresh?: Promise<void>;

	readonly directory: string;
	private readonly intervalMs: number;

	constructor(directory: string, intervalMs = 1_000) {
		this.directory = directory;
		this.intervalMs = intervalMs;
	}

	get current(): TodosUpdateEvent {
		return {
			type: "todos_update",
			items: [...this.#items.values()].sort(
				(a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
			),
		};
	}

	subscribe(listener: (event: TodosUpdateEvent) => void): () => void {
		this.#listeners.add(listener);
		listener(this.current);
		this.#timer ??= setInterval(() => void this.refresh(), this.intervalMs);
		this.#timer.unref();
		// Display-only I/O must never block the worker's serialized input/Stop command queue.
		void this.refresh();
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size === 0) {
				clearInterval(this.#timer);
				this.#timer = undefined;
			}
		};
	}

	refresh(): Promise<void> {
		this.#refresh ??= this.#read().finally(() => {
			this.#refresh = undefined;
		});
		return this.#refresh;
	}

	async #read(): Promise<void> {
		let files: Dirent[];
		try {
			files = await readdir(this.directory, { withFileTypes: true });
		} catch (error) {
			// A missing directory means no TODOs yet. Other read failures retain the last good state.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
			files = [];
		}
		const before = JSON.stringify(this.current);
		const next = new Map<string, SessionTodo>();
		await Promise.all(
			files
				.filter((file) => file.isFile() && /^[a-f0-9]{8}\.md$/i.test(file.name))
				.map(async ({ name: file }) => {
					const previous = this.#items.get(file);
					let todo = previous;
					try {
						todo =
							parseTodo(await readFile(resolve(this.directory, file), "utf8"), file.slice(0, -3)) ?? previous;
					} catch {
						// A file may be mid-write or temporarily unreadable. Retry on the next poll.
					}
					if (todo) next.set(file, todo);
				}),
		);
		this.#items = next;
		if (JSON.stringify(this.current) !== before) {
			for (const listener of this.#listeners) listener(this.current);
		}
	}
}
