import type { Context, Tool } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { controlBlocks, controlContext, markControlCache } from "@pilot/kernel/control-context";
import type { ControlMemory } from "./control-memory.ts";
import type { ControlJob, ControlMessageInput } from "./control-memory-disk.ts";
import type { ControlLine } from "./control-view.ts";

export type ControlCompletion = (job: ControlJob, lines: ControlLine[], signal: AbortSignal) => Promise<string>;
export function controlCompactionTask(job: ControlJob): string {
	const task =
		job.n === 1
			? `compress message ${job.id} into one line`
			: `merge lines ${job.id}+${job.n / 2} and ${job.id + job.n / 2}+${job.n / 2}, adjacent, into one line`;
	return `Compaction: ${task} of at most 512 bytes (about 70 words), the length of this ruler:\n${"-".repeat(512)}\n${job.n > 1 ? `<chat> may hold messages ${job.id} to ${job.id + job.n - 1} in more detail: take details of them from there too.\n` : ""}<input>\n${job.source}\n</input>`;
}
function firstBytes(text: string, limit: number): string {
	const bytes = Buffer.from(text);
	let end = Math.min(limit, bytes.length);
	while (end && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}
/** Same prefix as a turn. Tool declarations share cache, but calls are never executed. */
export async function compactControlNode(
	runtime: Pick<ModelRuntime, "completeSimple">,
	model: Parameters<ModelRuntime["completeSimple"]>[0],
	tools: Tool[],
	job: ControlJob,
	lines: ControlLine[],
	signal: AbortSignal,
): Promise<string> {
	const context: Context = controlContext(lines, controlCompactionTask(job), tools);
	let shortest: string | undefined;
	for (let attempt = 0; attempt <= 5; attempt++) {
		signal.throwIfAborted();
		const result = await runtime.completeSimple(model, context, {
			signal,
			maxRetries: 0,
			maxTokens: 1024,
			reasoning: undefined,
			toolChoice: "none",
			onPayload: (payload) =>
				model.api === "anthropic-messages" ? markControlCache(payload, controlBlocks(lines).lastWhole) : payload,
		});
		signal.throwIfAborted();
		if (result.stopReason !== "stop" || result.content.some((block) => block.type === "toolCall"))
			throw new Error(
				`Control compaction failed or attempted a tool call (${result.stopReason})${result.errorMessage ? `: ${result.errorMessage}` : ""}`,
			);
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("")
			.replace(/\s+/gu, " ")
			.trim();
		if (!text || text.includes("\0")) throw new Error("Control compaction returned an empty or invalid line");
		if (shortest === undefined || Buffer.byteLength(text) < Buffer.byteLength(shortest)) shortest = text;
		if (Buffer.byteLength(shortest) <= 512) return shortest;
		// Do not retain thoughts/signatures or provider-specific hidden state in the correction loop.
		context.messages.push({ ...result, content: [{ type: "text", text }] });
		context.messages.push({
			role: "user",
			timestamp: 0,
			content: `Too long: your line is ${Buffer.byteLength(text)} bytes, over the 512-byte limit. Write the whole line again for the same <input>, cutting just enough of the least valuable items to fit before this cut:\n${firstBytes(text, 512)}| ← LIMIT`,
		});
	}
	// Never truncate a semantic summary. Keep the original job for retry on the next message.
	throw new Error(`Control compaction shortest line was ${Buffer.byteLength(shortest!)} bytes after 5 retries`);
}

/** Ready queues live in the storage worker. One pump admits at most eight cancellable calls. */
export class ControlCompactor {
	private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
	private pumping?: Promise<void>;
	private requested = false;
	private stopped = false;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private readonly listeners = new Set<() => void>();
	private readonly memory: ControlMemory;
	private readonly complete: ControlCompletion;
	constructor(memory: ControlMemory, complete: ControlCompletion) {
		this.memory = memory;
		this.complete = complete;
	}
	async append(message: ControlMessageInput) {
		const messages = await this.memory.append(message);
		this.wake();
		return messages;
	}
	wake(): void {
		this.requested = true;
		if (this.stopped || this.pumping) return;
		this.requested = false;
		this.pumping = this.pump()
			.catch(() => {})
			.finally(() => {
				this.pumping = undefined;
				if (this.requested) this.wake();
				this.emit();
				void this.scheduleRetry().catch(() => {});
			});
	}
	private async scheduleRetry(): Promise<void> {
		if (this.stopped) return;
		const { retryAt } = await this.memory.state();
		if (this.stopped) return;
		clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		if (retryAt === undefined) return;
		this.retryTimer = setTimeout(
			() => {
				this.retryTimer = undefined;
				if (!this.stopped)
					void this.memory
						.retry()
						.then(() => this.wake())
						.catch(() => {});
			},
			Math.max(1, retryAt - Date.now()),
		);
		this.retryTimer.unref();
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private emit(): void {
		for (const listener of this.listeners) listener();
	}
	private async pump(): Promise<void> {
		while (!this.stopped && this.running.size < 8) {
			const job = await this.memory.next();
			if (!job) break;
			if (this.stopped) {
				await this.memory.fail(job.id, job.n);
				break;
			}
			const key = `${job.id}+${job.n}`,
				controller = new AbortController();
			const done = this.run(job, controller).finally(() => {
				this.running.delete(key);
				this.wake();
				this.emit();
			});
			this.running.set(key, { controller, done });
		}
	}
	private async run(job: ControlJob, controller: AbortController): Promise<void> {
		let onAbort: (() => void) | undefined;
		const timer = setTimeout(() => controller.abort(), 60_000);
		timer.unref();
		try {
			const lines = await this.memory.context(job.id, job.n);
			if (this.stopped) throw new Error("Control compactor stopped");
			const abort = new Promise<never>((_, reject) => {
				onAbort = () => reject(new Error("Control compaction cancelled"));
				controller.signal.addEventListener("abort", onAbort, { once: true });
				if (controller.signal.aborted) onAbort();
			});
			const text = await Promise.race([this.complete(job, lines, controller.signal), abort]);
			controller.signal.throwIfAborted();
			await this.memory.put(job.id, job.n, text);
		} catch (error) {
			await this.memory
				.fail(job.id, job.n, {
					errorClass: error instanceof Error ? error.name : "Error",
					reason: error instanceof Error ? error.message : "Unknown compaction error",
				})
				.catch(() => {});
		} finally {
			clearTimeout(timer);
			if (onAbort) controller.signal.removeEventListener("abort", onAbort);
		}
	}
	/** Only the service owner closes storage, after all compactor calls have drained. */
	async settled(): Promise<void> {
		if (!this.pumping && !this.running.size) return;
		await new Promise<void>((resolve) => {
			const remove = this.onChange(() => {
				if (!this.pumping && !this.running.size) {
					remove();
					resolve();
				}
			});
		});
	}
	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.retryTimer);
		for (const { controller } of this.running.values()) controller.abort();
		await this.pumping;
		await Promise.all([...this.running.values()].map(({ done }) => done));
		this.listeners.clear();
	}
}
