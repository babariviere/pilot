/** Shared, reference-counted live transcripts of subagents, one long-lived reader thread each. */
import { Worker } from "node:worker_threads";
import { subagentWatchWorkerEntry } from "@pilot/kernel";
import type { AgentEvent } from "@pilot/protocol";
import { ServiceUnavailable } from "./errors.ts";

export type SubagentWatchUpdate = { full: boolean; events: AgentEvent[] } | { error: string };
/** Starts one watcher and returns its stop function. Injectable for tests. */
export type SubagentWatchStarter = (
	directory: string,
	conversationId: string,
	onUpdate: (update: SubagentWatchUpdate) => void,
) => () => void;

export interface SubagentWatchListener {
	/** A snapshot (or empty list) replaces the transcript; `entry_appended` events extend it. */
	events(events: AgentEvent[]): void;
	error(message: string): void;
}

export const startSubagentWatchWorker: SubagentWatchStarter = (directory, conversationId, onUpdate) => {
	const worker = new Worker(subagentWatchWorkerEntry, { workerData: { directory, conversationId }, execArgv: [] });
	let stopped = false;
	worker.on("message", (update: SubagentWatchUpdate) => {
		if (!stopped) onUpdate(update);
	});
	worker.on("error", (error) => {
		if (!stopped) onUpdate({ error: error.message });
	});
	worker.unref();
	return () => {
		stopped = true;
		void worker.terminate();
	};
};

type SnapshotEvent = Extract<AgentEvent, { type: "snapshot" }>;
type EntryRecord = Extract<AgentEvent, { type: "entry_appended" }>["entry"];

interface Watch {
	listeners: Set<SubagentWatchListener>;
	/** Merged state for late subscribers: undefined until the first read, null before storage exists. */
	snapshot?: SnapshotEvent | null;
	/** Entries appended since the last full read, merged into the snapshot for late subscribers. */
	appended: EntryRecord[];
	stop: () => void;
}

export class SubagentWatches {
	readonly #watches = new Map<string, Watch>();
	readonly #start: SubagentWatchStarter;
	readonly #limit: number;

	constructor(start: SubagentWatchStarter = startSubagentWatchWorker, limit = 8) {
		this.#start = start;
		this.#limit = limit;
	}

	get size(): number {
		return this.#watches.size;
	}

	watch(directory: string, conversationId: string, listener: SubagentWatchListener): () => void {
		const key = `${directory}\0${conversationId}`;
		let watch = this.#watches.get(key);
		if (!watch) {
			if (this.#watches.size >= this.#limit)
				throw new ServiceUnavailable("Too many subagent transcripts are open. Close one and retry.");
			const created: Watch = { listeners: new Set(), appended: [], stop: () => {} };
			created.stop = this.#start(directory, conversationId, (update) => this.#update(created, update));
			this.#watches.set(key, created);
			watch = created;
		} else if (watch.snapshot !== undefined) {
			listener.events(
				watch.snapshot ? [{ ...watch.snapshot, entries: [...watch.snapshot.entries, ...watch.appended] }] : [],
			);
		}
		watch.listeners.add(listener);
		const owned = watch;
		return () => {
			if (!owned.listeners.delete(listener) || owned.listeners.size) return;
			owned.stop();
			if (this.#watches.get(key) === owned) this.#watches.delete(key);
		};
	}

	close(): void {
		for (const watch of this.#watches.values()) watch.stop();
		this.#watches.clear();
	}

	#update(watch: Watch, update: SubagentWatchUpdate): void {
		if ("error" in update) {
			for (const listener of [...watch.listeners]) listener.error(update.error);
			return;
		}
		if (update.full) {
			const snapshot = update.events.find((event): event is SnapshotEvent => event.type === "snapshot");
			watch.snapshot = snapshot ?? null;
			watch.appended = [];
		} else if (watch.snapshot) {
			for (const event of update.events) if (event.type === "entry_appended") watch.appended.push(event.entry);
		}
		for (const listener of [...watch.listeners]) listener.events(update.events);
	}
}
