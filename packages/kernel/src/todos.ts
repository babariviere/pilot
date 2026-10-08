/** Display-only reader for pi-extensions/extensions/todos. The extension owns all writes. */

import { constants, type BigIntStats, type Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SessionTodo, TodosUpdateEvent } from "@pilot/protocol";

const MAX_CONCURRENT_READS = 4;
const MAX_HEADER_BYTES = 64 * 1024;
const io = { open, readdir, stat };

function metadata(stats: BigIntStats): string {
	return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

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
	#metadata = new Map<string, string>();
	#event: TodosUpdateEvent = { type: "todos_update", items: [] };
	#serialized = JSON.stringify(this.#event);
	#listeners = new Set<(event: TodosUpdateEvent) => void>();
	#timer?: ReturnType<typeof setInterval>;
	#refresh?: Promise<void>;

	readonly directory: string;
	private readonly intervalMs: number;
	private readonly fs: typeof io;

	constructor(directory: string, intervalMs = 1_000, fs = io) {
		this.directory = directory;
		this.intervalMs = intervalMs;
		this.fs = fs;
	}

	get current(): TodosUpdateEvent {
		return {
			type: "todos_update",
			items: this.#event.items.map((todo) => ({ ...todo })),
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
			files = await this.fs.readdir(this.directory, { withFileTypes: true });
		} catch (error) {
			// A missing directory means no TODOs yet. Other read failures retain the last good state.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
			files = [];
		}
		const next = new Map<string, SessionTodo>();
		const nextMetadata = new Map<string, string>();
		const pending = files.filter((file) => file.isFile() && /^[a-f0-9]{8}\.md$/i.test(file.name));
		let index = 0;
		await Promise.all(
			Array.from({ length: Math.min(MAX_CONCURRENT_READS, pending.length) }, async () => {
				while (index < pending.length) {
					const file = pending[index++].name;
					const previous = this.#items.get(file);
					let todo = previous;
					try {
						const path = resolve(this.directory, file);
						const version = metadata(await this.fs.stat(path, { bigint: true }));
						if (previous && this.#metadata.get(file) === version) nextMetadata.set(file, version);
						else {
							const result = await this.#header(path, file.slice(0, -3));
							if (result) {
								todo = result.todo;
								nextMetadata.set(file, result.version);
							}
						}
					} catch {
						// A file may be mid-write or temporarily unreadable. Retry on the next poll.
					}
					if (todo) next.set(file, todo);
				}
			}),
		);
		this.#items = next;
		this.#metadata = nextMetadata;
		const event: TodosUpdateEvent = {
			type: "todos_update",
			items: [...next.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
		};
		const serialized = JSON.stringify(event);
		if (serialized !== this.#serialized) {
			this.#event = event;
			this.#serialized = serialized;
			for (const listener of this.#listeners) listener(this.current);
		}
	}

	/** Read front matter only. A huge body or malformed header must not make polling unbounded. */
	async #header(path: string, id: string): Promise<{ todo: SessionTodo; version: string } | undefined> {
		const handle = await this.fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
		try {
			const stats = await handle.stat({ bigint: true });
			if (!stats.isFile()) return undefined;
			const version = metadata(stats);
			const buffer = Buffer.alloc(4096);
			const decoder = new StringDecoder("utf8");
			let source = "";
			for (let offset = 0; offset < MAX_HEADER_BYTES; ) {
				const { bytesRead } = await handle.read(
					buffer,
					0,
					Math.min(buffer.length, MAX_HEADER_BYTES - offset),
					offset,
				);
				if (!bytesRead) return undefined;
				offset += bytesRead;
				source += decoder.write(buffer.subarray(0, bytesRead));
				const todo = parseTodo(source, id);
				if (todo) {
					// Do not cache a header observed across a concurrent write.
					if (metadata(await handle.stat({ bigint: true })) !== version) return undefined;
					return { todo, version };
				}
				if (source.trimStart() && !source.trimStart().startsWith("{")) return undefined;
			}
			return undefined;
		} finally {
			await handle.close();
		}
	}
}
