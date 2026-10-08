/**
 * Bridge to the pi-extensions subagents host events (`extensions/subagents/host-events.ts`).
 * Display data and user commands only: the model keeps using the `subagent` tool.
 */
import { randomUUID } from "node:crypto";
import type { DeliveryMode } from "@pilot/protocol";
import type { KernelSubagent } from "./protocol.ts";

export const SUBAGENTS_SNAPSHOT_EVENT = "subagents:snapshot";
export const SUBAGENTS_REQUEST_SNAPSHOT_EVENT = "subagents:request-snapshot";
export const SUBAGENTS_COMMAND_EVENT = "subagents:command";
export const SUBAGENTS_COMMAND_RESULT_EVENT = "subagents:command-result";

/** The subset of pi's extension event bus this bridge needs. */
export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export type SubagentCommand =
	| { action: "send"; name: string; message: string; mode?: DeliveryMode; requestId?: string }
	| { action: "stop"; name: string; requestId?: string };

const COMMAND_TIMEOUT_MS = 60_000;
const TASK_LIMIT = 4_000;

const text = (value: unknown, limit = 1_000): string | undefined =>
	typeof value === "string" ? value.slice(0, limit) : undefined;

/** Validate untrusted event data into kernel entries. Malformed entries are dropped. */
export function parseSubagents(data: unknown): KernelSubagent[] {
	const agents = (data as { agents?: unknown } | undefined)?.agents;
	if (!Array.isArray(agents)) return [];
	return agents.flatMap((value): KernelSubagent[] => {
		if (!value || typeof value !== "object") return [];
		const entry = value as Record<string, unknown>;
		const name = text(entry.name, 128);
		const storage = text(entry.storage, 4_096);
		if (!name || !storage || (entry.state !== "working" && entry.state !== "idle")) return [];
		const model = text(entry.model, 256);
		const lastAnswerId = text(entry.lastAnswerId, 256);
		const error = text(entry.error, 2_000);
		const conversationId = text(entry.conversationId, 256);
		return [
			{
				name,
				state: entry.state,
				task: text(entry.task, TASK_LIMIT) ?? "",
				createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
				cwd: text(entry.cwd, 4_096) ?? "",
				storage,
				...(model ? { model } : {}),
				...(lastAnswerId ? { lastAnswerId } : {}),
				...(error ? { error } : {}),
				...(conversationId ? { conversationId } : {}),
				...(entry.retired === true ? { retired: true } : {}),
			},
		];
	});
}

export class SubagentBridge {
	#events?: EventBus;
	#offs: Array<() => void> = [];
	#current: KernelSubagent[] = [];
	#seen = false;
	readonly #pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	readonly #onChange?: (subagents: KernelSubagent[]) => void;

	constructor(onChange?: (subagents: KernelSubagent[]) => void) {
		this.#onChange = onChange;
	}

	get current(): KernelSubagent[] {
		return this.#current;
	}

	/** Called from a native extension factory; the subagents extension may load before or after it. */
	attach(events: EventBus): void {
		this.detach();
		this.#events = events;
		this.#offs = [
			events.on(SUBAGENTS_SNAPSHOT_EVENT, (data) => this.#receive(data)),
			events.on(SUBAGENTS_COMMAND_RESULT_EVENT, (data) => this.#settle(data)),
		];
	}

	detach(): void {
		for (const off of this.#offs) off();
		this.#offs = [];
		this.#events = undefined;
		for (const [id, waiter] of this.#pending) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("Subagents are unavailable"));
			this.#pending.delete(id);
		}
	}

	/** Ask the extension for a fresh snapshot, for example once its session has started. */
	refresh(): void {
		this.#events?.emit(SUBAGENTS_REQUEST_SNAPSHOT_EVENT, undefined);
	}

	command(command: SubagentCommand): Promise<void> {
		const events = this.#events;
		if (!events || !this.#seen) return Promise.reject(new Error("The subagents extension is not loaded"));
		if (!this.#current.some((agent) => agent.name === command.name))
			return Promise.reject(new Error(`No subagent named ${command.name}.`));
		const requestId = command.requestId ?? randomUUID();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(requestId);
				reject(new Error("The subagents extension did not answer"));
			}, COMMAND_TIMEOUT_MS);
			timer.unref();
			this.#pending.set(requestId, { resolve, reject, timer });
			events.emit(
				SUBAGENTS_COMMAND_EVENT,
				command.action === "send"
					? {
							requestId,
							action: "send",
							name: command.name,
							message: command.message,
							followUp: command.mode === "followUp",
						}
					: { requestId, action: "stop", name: command.name },
			);
		});
	}

	#receive(data: unknown): void {
		this.#seen = true;
		const next = parseSubagents(data);
		if (JSON.stringify(next) === JSON.stringify(this.#current)) return;
		this.#current = next;
		this.#onChange?.(next);
	}

	#settle(data: unknown): void {
		const result = data as { requestId?: unknown; ok?: unknown; error?: unknown } | undefined;
		if (typeof result?.requestId !== "string") return;
		const waiter = this.#pending.get(result.requestId);
		if (!waiter) return;
		this.#pending.delete(result.requestId);
		clearTimeout(waiter.timer);
		if (result.ok === true) waiter.resolve();
		else waiter.reject(new Error(typeof result.error === "string" ? result.error : "Subagent command failed"));
	}
}
