/** Group-only cleanup evidence. Deliberately NOT a subtree-safe update receipt. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface JobGroupEvidence {
	schema: 1;
	scope: "process-group";
	session: string;
	incarnation: string;
	admission: string;
	toolCallId: string;
	jobId?: string;
	pgid?: number;
	state: "intent" | "owned" | "draining" | "kill-entered" | "group-empty" | "unknown";
	shellExit?: number | null;
}

type Slot = {
	evidence: JobGroupEvidence;
	token: string;
	command?: string;
	channel?: Socket;
	bound: boolean;
	ran: boolean;
	ready: Promise<void>;
	connected(): void;
	closed: Promise<void>;
	disconnected(): void;
	events: Promise<void>;
	draining?: Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const states = ["intent", "owned", "draining", "kill-entered", "group-empty", "unknown"];
const worker = fileURLToPath(new URL("./job-group-worker.mjs", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const validText = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");

/** Null signal only. No caller may turn a persisted/reused PGID into kill authority. */
export function groupAbsent(pgid: number): boolean {
	if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error("Invalid owned process group");
	try {
		process.kill(-pgid, 0);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		// Darwin can report EPERM while only exiting/zombie group members remain.
		// Permission denial is never absence; the bounded caller can retry inspection.
		if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
		throw error;
	}
}

/** No command, token or credential is stored. Reopen reads evidence; it never replays or signals. */
export class OwnedJobGroups {
	private readonly incarnation = randomUUID();
	private readonly context = new AsyncLocalStorage<Slot>();
	private readonly slots = new Map<string, Slot>();
	private readonly tokens = new Map<string, Slot>();
	private readonly retained = new Map<string, JobGroupEvidence>();
	private readonly starting = new Set<Promise<unknown>>();
	private server?: Server;
	private socketRoot?: string;
	private socket?: string;
	private listening?: Promise<void>;
	private writes: Promise<void> = Promise.resolve();
	private frozen = false;
	private invalid = false;

	private readonly session: string;
	private readonly directory?: string;
	private constructor(session: string, directory?: string) {
		this.session = session;
		this.directory = directory;
	}

	static async open(session: string, directory?: string): Promise<OwnedJobGroups> {
		const groups = new OwnedJobGroups(session, directory);
		if (!validText(session)) groups.invalid = true;
		if (!directory) return groups;
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const parent = await open(dirname(directory), constants.O_RDONLY);
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
		const names = await readdir(directory);
		if (names.length > 4096) groups.invalid = true;
		for (const name of names.slice(0, 4096)) {
			// Interrupted atomic writes and malformed/foreign rows stay uncertain.
			if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) {
				groups.invalid = true;
				continue;
			}
			try {
				const fd = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
				let value: JobGroupEvidence;
				try {
					const stat = await fd.stat();
					if (!stat.isFile() || stat.size > 8192) throw new Error("Invalid group evidence");
					value = JSON.parse(await fd.readFile("utf8"));
				} finally {
					await fd.close();
				}
				if (
					value.schema !== 1 ||
					value.scope !== "process-group" ||
					value.session !== session ||
					value.admission !== name.slice(0, -5) ||
					!UUID.test(value.incarnation) ||
					!validText(value.toolCallId) ||
					!states.includes(value.state) ||
					(value.pgid !== undefined && (!Number.isSafeInteger(value.pgid) || value.pgid <= 1)) ||
					(value.jobId !== undefined && !validText(value.jobId)) ||
					(value.shellExit !== undefined &&
						value.shellExit !== null &&
						(!Number.isInteger(value.shellExit) || value.shellExit < 0 || value.shellExit > 255)) ||
					(value.state !== "intent" &&
						value.state !== "unknown" &&
						(!Number.isSafeInteger(value.pgid) || value.pgid! <= 1 || typeof value.jobId !== "string"))
				)
					throw new Error("Invalid group evidence");
				groups.retained.set(value.admission, value);
			} catch {
				groups.invalid = true;
			}
		}
		return groups;
	}

	readonly native: ExtensionFactory = (pi) => {
		pi.events.on("pilot:job-group:wrap", (value) => {
			const request = value as { command: string; result?: Promise<string> };
			const slot = this.context.getStore();
			request.result = slot
				? this.wrap(slot, request.command)
				: Promise.reject(new Error("Job group requires pre-admission ownership"));
		});
	};

	/** Called inside the shared definition, before either direct or nested provider entry. */
	execute<T extends { structuredContent?: unknown; isError?: boolean }>(
		toolCallId: string,
		delegate: () => Promise<T>,
	): Promise<T> {
		if (this.frozen || this.invalid || !validText(toolCallId) || this.retained.size + this.slots.size >= 4096)
			return Promise.reject(new Error("Job group admission is unavailable"));
		const admission = randomUUID();
		let connected!: () => void;
		let disconnected!: () => void;
		const slot: Slot = {
			evidence: {
				schema: 1,
				scope: "process-group",
				session: this.session,
				incarnation: this.incarnation,
				admission,
				toolCallId,
				state: "intent",
			},
			token: randomUUID(),
			bound: false,
			ran: false,
			ready: new Promise<void>((resolve) => {
				connected = resolve;
			}),
			closed: new Promise<void>((resolve) => {
				disconnected = resolve;
			}),
			connected: () => connected(),
			disconnected: () => disconnected(),
			events: Promise.resolve(),
		};
		this.slots.set(admission, slot); // Synchronous intent also fences concurrent drain.
		this.tokens.set(slot.token, slot);
		const running = this.context.run(slot, async () => {
			await this.save(slot);
			const result = await delegate();
			const id = (result.structuredContent as { id?: unknown } | undefined)?.id;
			if (result.isError || !validText(id)) {
				slot.evidence.state = "unknown";
				await this.save(slot);
				return result;
			}
			slot.evidence.jobId = id;
			slot.bound = true;
			await this.save(slot);
			await this.run(slot);
			return result;
		});
		this.starting.add(running);
		void running.finally(() => this.starting.delete(running)).catch(() => {});
		return running;
	}

	private async wrap(slot: Slot, command: string): Promise<string> {
		if (slot.command !== undefined || typeof command !== "string") throw new Error("Invalid job group wrap");
		this.listening ??= this.listen();
		await this.listening;
		slot.command = command;
		return `exec ${quote(process.execPath)} ${quote(worker)} client ${quote(this.socket!)} ${quote(slot.token)}`;
	}

	private async listen(): Promise<void> {
		// Short private path also works within Darwin's small sockaddr_un limit.
		this.socketRoot = await mkdtemp(join(tmpdir(), "pjg-"));
		this.socket = join(this.socketRoot, "s");
		this.server = createServer((channel) => {
			let buffer = "";
			let slot: Slot | undefined;
			channel.setTimeout(5000, () => {
				if (!slot) channel.destroy();
			});
			channel.on("error", () => {});
			channel.on("data", (chunk) => {
				buffer += chunk.toString();
				if (buffer.length > 8192) return channel.destroy();
				for (;;) {
					const end = buffer.indexOf("\n");
					if (end < 0) return;
					let message: { type?: unknown; token?: unknown; pgid?: unknown; code?: unknown };
					try {
						message = JSON.parse(buffer.slice(0, end));
					} catch {
						return channel.destroy();
					}
					if (!message || typeof message !== "object" || Array.isArray(message)) return channel.destroy();
					buffer = buffer.slice(end + 1);
					if (!slot) {
						const candidate = typeof message.token === "string" ? this.tokens.get(message.token) : undefined;
						if (
							message.type !== "hello" ||
							!candidate ||
							candidate.channel ||
							!Number.isSafeInteger(message.pgid) ||
							(message.pgid as number) <= 1
						)
							return channel.destroy();
						slot = candidate;
						this.tokens.delete(slot.token); // One connection, never reconnect/replay.
						slot.channel = channel;
						slot.evidence.pgid = message.pgid as number;
						slot.connected();
						channel.setTimeout(0);
					} else {
						const current = slot;
						current.events = current.events
							.then(async () => {
								if (message.type === "shell-exit") {
									if (message.code !== null && !Number.isInteger(message.code))
										throw new Error("Invalid shell result");
									current.evidence.shellExit = message.code as number | null;
									await this.save(current);
									void this.drainSlot(current).catch(() => {});
								} else if (message.type === "draining") {
									current.evidence.state = "draining";
									await this.save(current);
									void this.drainSlot(current).catch(() => {});
								} else if (message.type === "kill-ready") {
									current.evidence.state = "kill-entered";
									await this.save(current); // durable intent, not an exit receipt
									channel.write('{"type":"kill"}\n');
								} else throw new Error("Invalid job group message");
							})
							.catch(() => {
								current.evidence.state = "unknown";
								channel.destroy();
							});
					}
					const current = slot;
					void this.run(current).catch(() => channel.destroy());
				}
			});
			channel.on("close", () => slot?.disconnected());
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.socket!, resolve);
		});
	}

	private async run(slot: Slot): Promise<void> {
		if (!slot.bound || !slot.channel || slot.ran || this.frozen) return;
		slot.ran = true;
		slot.evidence.state = "owned";
		await this.save(slot); // exact job + incarnation + group before command effects
		if (this.frozen) return;
		slot.channel.write(`${JSON.stringify({ type: "run", command: slot.command })}\n`);
	}

	private save(slot: Slot): Promise<void> {
		const value = JSON.stringify(slot.evidence);
		this.writes = this.writes.then(async () => {
			if (!this.directory) return;
			const path = join(this.directory, `${slot.evidence.admission}.json`);
			const temporary = `${path}.${this.incarnation}.tmp`;
			const fd = await open(
				temporary,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await fd.writeFile(value);
				await fd.sync();
			} finally {
				await fd.close();
			}
			await rename(temporary, path);
			const parent = await open(this.directory, constants.O_RDONLY);
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		});
		return this.writes;
	}

	evidence(): JobGroupEvidence[] {
		return [...this.retained.values(), ...[...this.slots.values()].map((slot) => slot.evidence)].map((value) =>
			structuredClone(value),
		);
	}

	/** Freeze admissions and join groups, including finished/pruned provider leaders. Never a safe-update proof. */
	async drain(): Promise<void> {
		this.frozen = true;
		await Promise.allSettled([...this.starting]);
		const results = await Promise.allSettled([...this.slots.values()].map((slot) => this.drainSlot(slot)));
		await this.writes;
		if (this.invalid || [...this.retained.values()].some((value) => value.state !== "group-empty"))
			throw new Error("Historical job group ownership is unknown");
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}

	private drainSlot(slot: Slot): Promise<void> {
		slot.draining ??= (async () => {
			if (slot.evidence.state === "group-empty") return;
			if (slot.command === undefined) throw new Error("Owned job group admission has no group proof");
			await deadline(slot.ready, 5000);
			slot.channel!.write('{"type":"drain"}\n');
			await deadline(slot.closed, 5000);
			await slot.events;
			if (slot.evidence.state !== "kill-entered") throw new Error("Owned job group exit is unconfirmed");
			await this.joinGroup(slot.evidence.pgid!);
			if (!slot.bound) {
				slot.evidence.state = "unknown";
				await this.save(slot);
				throw new Error("Owned job result identity is unknown");
			}
			slot.evidence.state = "group-empty";
			await this.save(slot);
		})();
		return slot.draining;
	}

	private async joinGroup(pgid: number): Promise<void> {
		const end = Date.now() + 3000;
		while (!groupAbsent(pgid)) {
			if (Date.now() >= end) throw new Error("Owned job group remains or identity was reused");
			await delay(10);
		}
	}

	async close(): Promise<void> {
		const drained = await this.drain().then(
			() => undefined,
			(error: unknown) => ({ error }),
		);
		for (const slot of this.slots.values()) slot.channel?.destroy();
		if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
		// Lost storage/transport proof still triggers exact live-anchor cleanup.
		// Join its actual group exit separately, without manufacturing a receipt.
		const exits = await Promise.allSettled(
			[...this.slots.values()].flatMap((slot) =>
				slot.evidence.pgid && slot.evidence.state !== "group-empty" ? [this.joinGroup(slot.evidence.pgid)] : [],
			),
		);
		await Promise.allSettled([...this.slots.values()].map((slot) => slot.events));
		await this.writes.catch(() => {});
		if (this.socketRoot) await rm(this.socketRoot, { recursive: true, force: true });
		if (drained) throw drained.error;
		const failure = exits.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}
}

async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Owned job group drain timed out")), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
