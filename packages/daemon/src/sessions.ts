/** Session registry and kernel worker supervision. */
import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type KernelCommand, type KernelPacket, type WorkspaceContext, workerEntry } from "@pilot/kernel";
import type {
	AgentEvent,
	DeliveryMode,
	SessionState,
	SessionSummary,
	SessionUsage,
	SpawnRequest,
	UpdatePreparation,
} from "@pilot/protocol";
import { NotFound } from "./errors.ts";
import { type ProjectStore, requireDirectory } from "./projects.ts";
import { UpdateGate } from "./update-gate.ts";
import { WorkerActivity } from "./worker-activity.ts";
import { branchSlug, createWorkspace, type Workspace } from "./workspaces.ts";

export { NotFound } from "./errors.ts";

type PendingCommand = Extract<KernelCommand, { type: "input" | "abort" }>;
type WorkerSpec = Extract<KernelCommand, { type: "start" }>["spec"];

/** An explicit kernel rejection, unlike a disconnect with uncertain durable admission. */
export class CommandRejected extends Error {}

/** Injectable daemon boundaries for deterministic startup tests. */
export interface SessionWorker {
	readonly ready: Promise<void>;
	/** Includes outstanding acknowledgements and accepted input not yet observed in the event stream. */
	readonly busy?: boolean;
	state: SessionState;
	error?: string;
	usage?: SessionUsage;
	send(command: KernelCommand): void;
	request(command: Extract<KernelCommand, { requestId: string }>): Promise<void>;
	close(): Promise<void>;
}

export interface SessionFactories {
	workspace?: typeof createWorkspace;
	worker?: (
		spec: WorkerSpec,
		onPacket: (packet: KernelPacket) => void,
		onExit: (worker: SessionWorker, code: number | null) => void,
	) => SessionWorker;
}

interface SessionMeta {
	id: string;
	title: string;
	cwd: string;
	projectId?: string;
	/** Private clone the session works in (its cwd), and where it came from. */
	workspace?: WorkspaceContext;
	createdAt: number;
	updatedAt: number;
	model?: string;
	thinking?: string;
	/** Last known activity, so the daemon can resume interrupted work after a restart. */
	working?: boolean;
	/** Cleared only after initialization and durable input admission. */
	initializing?: boolean;
	preparing?: { source: string; branch: string };
	pending?: PendingCommand[];
	/** A stopped, unopened workspace has no conversation history to load yet. */
	cancelled?: boolean;
	/** A recoverable input/admission error, not a failed worker initialization. */
	inputError?: string;
	failure?: string;
}

type EventListener = (events: AgentEvent[]) => void;

const emptySnapshot: AgentEvent = {
	type: "snapshot",
	entries: [],
	tools: [],
	compactions: [],
	inbox: [],
	agent: {},
	usage: { models: {}, tools: {} },
};

const ID_PATTERN = /^[0-9a-f-]{36}$/;

function titleFrom(message: string): string {
	const line = message.trim().split("\n")[0] ?? "";
	return line.length > 60 ? `${line.slice(0, 57)}...` : line || "Untitled session";
}

class Worker implements SessionWorker {
	private exited = false;
	private initialized = false;
	readonly child: ChildProcess;
	readonly ready: Promise<void>;
	state: SessionState = "starting";
	error?: string;
	/** Ephemeral. Never persist provider quota windows as current after a daemon restart. */
	usage?: SessionUsage;
	private readonly pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
	private readonly activity = new WorkerActivity();
	private activityWatchId?: string;

	get busy(): boolean {
		return (
			this.pending.size !== 0 ||
			this.state === "starting" ||
			this.state === "working" ||
			(this.state === "idle" && this.activity.busy)
		);
	}

	constructor(
		spec: Extract<KernelCommand, { type: "start" }>["spec"],
		private readonly onPacket: (packet: KernelPacket) => void,
		onExit: (worker: SessionWorker, code: number | null) => void,
	) {
		this.child = fork(fileURLToPath(workerEntry), [], {
			execArgv: ["--import", import.meta.resolve("tsx")],
			serialization: "advanced",
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		let markReady!: () => void;
		let markFailed!: (error: Error) => void;
		this.ready = new Promise<void>((resolve, reject) => {
			markReady = resolve;
			markFailed = reject;
		});
		this.ready.catch(() => undefined);
		this.child.on("message", (message) => {
			const packet = message as KernelPacket;
			if (packet.type === "events" && packet.watchId === this.activityWatchId) {
				this.activity.observe(packet.events);
				return;
			}
			if (packet.type === "ready") {
				this.usage = packet.usage;
				this.initialized = true;
				this.state = packet.working ? "working" : "idle";
				markReady();
			} else if (packet.type === "usage") {
				this.usage = packet.usage;
			} else if (packet.type === "working") {
				this.state = packet.working ? "working" : "idle";
			} else if (packet.type === "accepted" || packet.type === "aborted") {
				// IPC acceptance can precede working=true. A fresh committed snapshot is the idle barrier,
				// including idempotent retries which produce no new run/inbox events.
				if (packet.type === "accepted") this.refreshActivity();
				this.settle(packet.requestId);
			} else if (packet.type === "error") {
				if (packet.requestId) this.settle(packet.requestId, new CommandRejected(packet.message));
				else if (!this.initialized) {
					this.state = "failed";
					this.error = packet.message;
					markFailed(new Error(packet.message));
				} else this.error = packet.message;
			}
			this.onPacket(packet);
		});
		this.child.on("error", (error) => {
			this.error = error.message;
			if (!this.initialized) {
				this.state = "failed";
				markFailed(error);
			}
			for (const id of [...this.pending.keys()]) this.settle(id, error);
		});
		this.child.on("exit", (code) => {
			this.exited = true;
			const error = new Error(`Kernel exited with code ${code}`);
			markFailed(error);
			for (const id of [...this.pending.keys()]) this.settle(id, error);
			onExit(this, code);
		});
		this.send({ type: "start", spec });
		this.refreshActivity();
	}

	private refreshActivity(): void {
		const previous = this.activityWatchId;
		this.activityWatchId = randomUUID();
		this.activity.reset();
		if (previous) this.send({ type: "unwatch", watchId: previous });
		this.send({ type: "watch", watchId: this.activityWatchId });
	}

	send(command: KernelCommand): void {
		if (this.child.connected) this.child.send(command);
	}

	/** Send a command and wait for its accepted/aborted/error acknowledgement. */
	request(command: Extract<KernelCommand, { requestId: string }>): Promise<void> {
		if (!this.child.connected) return Promise.reject(new Error("Kernel is disconnected"));
		return new Promise((resolve, reject) => {
			this.pending.set(command.requestId, { resolve, reject });
			this.send(command);
		});
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			if (this.exited || this.child.exitCode !== null) return resolve();
			const timer = setTimeout(() => {
				this.child.kill("SIGKILL");
				resolve();
			}, 8_000);
			timer.unref();
			this.child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			this.send({ type: "shutdown" });
		});
	}

	private settle(requestId: string, error?: Error): void {
		const waiter = this.pending.get(requestId);
		if (!waiter) return;
		this.pending.delete(requestId);
		if (error) waiter.reject(error);
		else waiter.resolve();
	}
}

export class SessionManager {
	private readonly metas = new Map<string, SessionMeta>();
	private readonly workers = new Map<string, SessionWorker>();
	/** sessionId -> watchId -> listener */
	private readonly watchers = new Map<string, Map<string, EventListener>>();
	private readonly changeListeners = new Set<(session: SessionSummary) => void>();
	/** Serialized metadata writes per session; the latest in-memory state always wins. */
	private readonly saving = new Map<string, Promise<void>>();
	private readonly starting = new Map<string, Promise<Map<string, Error>>>();
	private readonly preparations = new Set<Promise<Workspace>>();
	private readonly shutdownSignal = new AbortController();
	private readonly updateGate = new UpdateGate();
	private closing = false;

	constructor(
		private readonly home: string,
		private readonly projects: ProjectStore,
		private readonly agentDir?: string,
		private readonly factories: SessionFactories = {},
	) {}

	private get sessionsDir(): string {
		return join(this.home, "sessions");
	}

	async load(): Promise<void> {
		const end = this.updateGate.begin();
		try {
			await this.loadAdmitted();
		} finally {
			end();
		}
	}

	private async loadAdmitted(): Promise<void> {
		await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
		for (const id of await readdir(this.sessionsDir)) {
			if (!ID_PATTERN.test(id)) continue;
			try {
				const meta = JSON.parse(await readFile(join(this.sessionsDir, id, "meta.json"), "utf8")) as SessionMeta;
				if (meta.id !== id) throw new Error("Session metadata ID does not match its directory");
				this.metas.set(meta.id, meta);
			} catch (error) {
				console.warn(`pilotd: skipping unreadable session ${id}: ${error}`);
			}
		}
		// Durable work interrupted by a restart continues as soon as its kernel reopens.
		for (const meta of this.metas.values())
			if (!meta.failure && (meta.initializing || meta.pending?.length || meta.working))
				void this.start(meta.id, true);
	}

	onChange(listener: (session: SessionSummary) => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	list(): SessionSummary[] {
		return [...this.metas.values()].map((meta) => this.summary(meta)).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	get(id: string): SessionSummary | undefined {
		const meta = this.metas.get(id);
		return meta && this.summary(meta);
	}

	/** Where the session's changes start: its workspace base, else the folder's HEAD. */
	changeBase(id: string): { cwd: string; base?: string } {
		const meta = this.require(id);
		if (meta.preparing) throw new Error("Session workspace is still preparing");
		return { cwd: meta.cwd, ...(meta.workspace ? { base: meta.workspace.base } : {}) };
	}

	async spawn(request: SpawnRequest): Promise<SessionSummary> {
		const end = this.updateGate.begin();
		try {
			return await this.spawnAdmitted(request);
		} finally {
			end();
		}
	}

	/** Acquire a bounded update lease only after every durable and in-memory admission settles. */
	prepareUpdate(): UpdatePreparation {
		const busy =
			this.closing ||
			this.starting.size !== 0 ||
			this.preparations.size !== 0 ||
			this.saving.size !== 0 ||
			[...this.metas.values()].some(
				(meta) =>
					meta.working ||
					// Terminal initialization failure cannot replay these commands. Uncertain admission
					// uses inputError instead, so its durable outbox continues to block an update.
					(!meta.failure && (meta.preparing || meta.initializing || meta.pending?.length)),
			) ||
			[...this.workers.values()].some(
				(worker) =>
					worker.state === "starting" ||
					worker.state === "working" ||
					// Injectable workers without an activity barrier cannot prove an idle inbox.
					(worker.busy ?? worker.state !== "failed"),
			);
		return { ready: this.updateGate.prepare(busy) };
	}

	private async spawnAdmitted(request: SpawnRequest): Promise<SessionSummary> {
		if (typeof request.message !== "string" || !request.message.trim()) throw new Error("message is required");
		const project = request.projectId ? this.projects.require(request.projectId) : undefined;
		const directory = request.cwd?.trim() || project?.path;
		if (!directory) throw new Error("projectId or cwd is required");
		if (this.closing) throw new Error("pilotd is shutting down");
		let cwd = await requireDirectory(directory);
		const model = request.model?.trim() || project?.model;
		const now = Date.now();
		const id = randomUUID();
		const title = request.title?.trim() || titleFrom(request.message);
		await mkdir(this.dir(id), { recursive: true, mode: 0o700 });
		// Persist the clone recipe and destination, never a runnable source-project cwd.
		let preparing: SessionMeta["preparing"];
		if (project && !request.cwd?.trim() && project.workspace !== "direct") {
			preparing = { source: project.path, branch: `pilot/${branchSlug(title)}-${id.slice(0, 6)}` };
			cwd = join(this.dir(id), "workspace");
		}
		const meta: SessionMeta = {
			id,
			title,
			cwd,
			...(project ? { projectId: project.id } : {}),
			...(preparing ? { preparing } : {}),
			initializing: true,
			pending: [{ type: "input", requestId: randomUUID(), content: request.message, mode: "followUp" }],
			createdAt: now,
			updatedAt: now,
			...(model ? { model } : {}),
			...(request.thinking ? { thinking: request.thinking } : {}),
		};
		await this.save(meta);
		const summary = this.summary(meta);
		this.emit(meta);
		void this.start(id, true);
		return summary;
	}

	async send(
		id: string,
		message: string,
		mode: DeliveryMode = "followUp",
		requestId: string = randomUUID(),
	): Promise<void> {
		const end = this.updateGate.begin();
		try {
			await this.sendAdmitted(id, message, mode, requestId);
		} finally {
			end();
		}
	}

	private async sendAdmitted(id: string, message: string, mode: DeliveryMode, requestId: string): Promise<void> {
		const meta = this.require(id);
		if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
		if (this.closing) throw new Error("pilotd is shutting down");
		if (meta.failure) throw new Error(meta.failure);
		delete meta.cancelled;
		// Pending duplicates retain their original payload; accepted retries are deduped by the kernel.
		if (!meta.pending?.some((command) => command.requestId === requestId)) {
			meta.pending ??= [];
			meta.pending.push({ type: "input", requestId, content: message, mode });
		}
		meta.updatedAt = Date.now();
		await this.save(meta);
		this.emit(meta);
		const starting = meta.initializing;
		const admission = this.start(id, true);
		if (!starting) {
			const rejected = await admission;
			if (rejected.has(requestId)) throw rejected.get(requestId);
			if (meta.failure) throw new Error(meta.failure);
		}
	}

	async stop(id: string): Promise<void> {
		const meta = this.require(id);
		if (this.closing) throw new Error("pilotd is shutting down");
		if (meta.failure) return;
		if (!meta.initializing && !this.workers.has(id) && !meta.pending?.length) return;
		// Stop is allowed for an existing worker, but must not reopen a parked worker during a lease.
		if (!this.workers.has(id)) this.updateGate.assertOpen();
		// Drop queued input, and abort anything whose acknowledgement was in flight.
		const requestId = randomUUID();
		meta.pending = [{ type: "abort", requestId }];
		if (meta.preparing) meta.cancelled = true;
		await this.save(meta);
		if (meta.preparing) for (const listener of this.watchers.get(id)?.values() ?? []) listener([emptySnapshot]);
		const starting = meta.initializing;
		const admission = this.start(id);
		if (!starting) {
			const rejected = await admission;
			if (rejected.has(requestId)) throw rejected.get(requestId);
		}
	}

	async editQueuedMessage(id: string, submissionId: number, message: string): Promise<void> {
		const end = this.updateGate.begin();
		try {
			const meta = this.require(id);
			if (!Number.isSafeInteger(submissionId) || submissionId <= 0) throw new Error("Invalid queued message ID");
			if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
			const worker = this.ensureWorker(id);
			await worker.ready;
			await worker.request({ type: "editQueuedMessage", requestId: randomUUID(), submissionId, content: message });
			meta.updatedAt = Date.now();
			await this.save(meta);
			this.emit(meta);
		} finally {
			end();
		}
	}

	/** Attach a live event stream. The first batch is always a snapshot. */
	subscribe(id: string, listener: EventListener): () => void {
		const meta = this.require(id);
		if (this.closing) throw new Error("pilotd is shutting down");
		const worker = this.workers.get(id);
		// Reject reopening before registering a listener or emitting a snapshot. Existing live
		// subscriptions and terminal failed-session snapshots do not start new work.
		if (!worker && !meta.failure) this.updateGate.assertOpen();
		const watchId = randomUUID();
		let watchers = this.watchers.get(id);
		if (!watchers) {
			watchers = new Map();
			this.watchers.set(id, watchers);
		}
		watchers.set(watchId, listener);
		if (meta.failure || (meta.preparing && meta.cancelled)) listener([emptySnapshot]);
		if (worker) worker.send({ type: "watch", watchId });
		else if (!meta.failure)
			void this.start(id)
				.then(
					() => {
						// Demand can arrive while a crashed worker's old drain is still settling.
						if (!this.closing && !meta.failure && !this.workers.has(id) && watchers.has(watchId))
							void this.start(id);
					},
					() => undefined,
				)
				.catch(() => undefined);
		return () => {
			watchers.delete(watchId);
			this.workers.get(id)?.send({ type: "unwatch", watchId });
		};
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		this.shutdownSignal.abort();
		await Promise.allSettled([...this.preparations]);
		await Promise.all([...this.workers.values()].map((worker) => worker.close()));
		await Promise.all([...this.saving.values()]);
	}

	/** One initializer/outbox drain per session. Save before IPC; remove only after acknowledgement. */
	private start(id: string, admitted = false): Promise<Map<string, Error>> {
		const existing = this.starting.get(id);
		if (existing) return existing;
		const meta = this.require(id);
		if (this.closing || meta.failure) return Promise.resolve(new Map());
		// An existing drain owns its admission. Do not recheck its gate after any await.
		if (!admitted && !this.workers.has(id)) this.updateGate.assertOpen();
		const rejected = new Map<string, Error>();
		const run = async () => {
			try {
				if (meta.preparing) {
					const plan = meta.preparing;
					if (meta.cwd !== join(this.dir(id), "workspace"))
						throw new Error("Invalid session workspace destination");
					// A restart can leave a partial clone. No worker used it before the recipe was cleared.
					await rm(meta.cwd, { recursive: true, force: true });
					if (this.closing) return;
					const preparation = (this.factories.workspace ?? createWorkspace)(
						plan.source,
						meta.cwd,
						plan.branch,
						undefined,
						this.shutdownSignal.signal,
					);
					this.preparations.add(preparation);
					const created = await preparation.finally(() => this.preparations.delete(preparation));
					if (this.closing) return;
					meta.workspace = {
						source: plan.source,
						branch: created.branch,
						base: created.base,
						jj: created.jj,
						...(created.upstream ? { upstream: created.upstream } : {}),
					};
					delete meta.preparing;
					await this.save(meta);
				}
				if (this.closing) return;
				const worker = this.ensureWorker(id);
				await worker.ready;
				while (!this.closing) {
					while (!this.closing && meta.pending?.length) {
						const command = meta.pending[0];
						await this.save(meta);
						if (this.closing) return;
						// Stop can replace the queue while this write is in flight.
						if (meta.pending[0] !== command) continue;
						try {
							await worker.request(command);
							if (command.type === "input") delete meta.inputError;
						} catch (error) {
							if (this.closing) return;
							const failure = error instanceof Error ? error : new Error(String(error));
							rejected.set(command.requestId, failure);
							meta.inputError = failure.message;
							if (!(error instanceof CommandRejected)) {
								// Admission is uncertain. Keep the command and stable ID for retry/restart.
								delete meta.initializing;
								await this.save(meta);
								this.emit(meta);
								return;
							}
							// Explicitly rejected input is removed, but other queued work and abort stay usable.
						}
						if (this.closing) return;
						meta.pending = meta.pending.filter((pending) => pending !== command);
						await this.save(meta);
						this.emit(meta);
					}
					if (this.closing) return;
					delete meta.initializing;
					await this.save(meta);
					// Input can arrive during the final metadata write.
					if (meta.pending?.length) continue;
					this.emit(meta);
					return;
				}
			} catch (error) {
				if (this.closing) return;
				meta.failure = error instanceof Error ? error.message : String(error);
				meta.updatedAt = Date.now();
				await this.save(meta);
				this.emit(meta);
				for (const listener of this.watchers.get(id)?.values() ?? []) listener([emptySnapshot]);
			}
		};
		// Publish the drain before factories/listeners can reenter prepareUpdate.
		const task = Promise.resolve()
			.then(run)
			.then(() => rejected)
			.finally(() => this.starting.delete(id));
		this.starting.set(id, task);
		task.catch((error) => console.error(`pilotd: session ${id} startup failed: ${error}`));
		return task;
	}

	private ensureWorker(id: string): SessionWorker {
		const existing = this.workers.get(id);
		if (existing) return existing;
		if (this.closing) throw new Error("pilotd is shutting down");
		const meta = this.require(id);
		if (meta.preparing) throw new Error("Session workspace is still preparing");
		const createWorker = this.factories.worker ?? ((spec, onPacket, onExit) => new Worker(spec, onPacket, onExit));
		const worker = createWorker(
			{
				sessionId: id,
				storageDir: join(this.dir(id), "durable"),
				cwd: meta.cwd,
				model: meta.model,
				thinking: meta.thinking,
				agentDir: this.agentDir,
				...(meta.workspace ? { trustDirectory: meta.workspace.source } : {}),
				pilot: meta.workspace ? { workspace: meta.workspace } : {},
			},
			(packet) => this.onPacket(meta, worker, packet),
			(exited, code) => {
				if (this.workers.get(id) === exited) this.workers.delete(id);
				if (exited.state === "failed") {
					// ready rejection is handled by startup. Runtime transport failures remain retryable.
					meta.inputError = exited.error ?? `Kernel exited with code ${code}`;
					void this.save(meta);
				}
				if (!this.closing && code !== 0) console.warn(`pilotd: kernel for ${id} exited with code ${code}`);
				this.emit(meta);
			},
		);
		this.workers.set(id, worker);
		// Reattach existing subscribers, for example after a kernel restart.
		for (const watchId of this.watchers.get(id)?.keys() ?? []) worker.send({ type: "watch", watchId });
		this.emit(meta);
		return worker;
	}

	private onPacket(meta: SessionMeta, worker: SessionWorker, packet: KernelPacket): void {
		if (packet.type === "events") {
			this.watchers.get(meta.id)?.get(packet.watchId)?.(packet.events);
			return;
		}
		if (packet.type === "ready" || packet.type === "working") {
			const working = packet.type === "ready" ? packet.working : packet.working;
			if (packet.type === "ready") meta.model = packet.model;
			if (meta.working !== working || packet.type === "ready") {
				meta.working = working;
				meta.updatedAt = Date.now();
				void this.save(meta);
			}
		}
		this.emit(meta, worker);
	}

	private summary(meta: SessionMeta, worker = this.workers.get(meta.id)): SessionSummary {
		return {
			id: meta.id,
			title: meta.title,
			cwd: meta.cwd,
			...(meta.projectId ? { projectId: meta.projectId } : {}),
			...(meta.workspace ? { branch: meta.workspace.branch } : {}),
			createdAt: meta.createdAt,
			updatedAt: meta.updatedAt,
			state: meta.failure
				? "failed"
				: meta.initializing
					? "starting"
					: meta.inputError && (!meta.working || !worker)
						? "failed"
						: (worker?.state ?? "parked"),
			...(meta.model ? { model: meta.model } : {}),
			...(worker?.usage ? { usage: worker.usage } : {}),
			...(meta.failure || meta.inputError || worker?.error
				? { error: meta.failure || meta.inputError || worker?.error }
				: {}),
		};
	}

	private emit(meta: SessionMeta, worker?: SessionWorker): void {
		const summary = this.summary(meta, worker ?? this.workers.get(meta.id));
		for (const listener of this.changeListeners) listener(summary);
	}

	private require(id: string): SessionMeta {
		const meta = this.metas.get(id);
		if (!meta) throw new NotFound(`Unknown session: ${id}`);
		return meta;
	}

	private dir(id: string): string {
		return join(this.sessionsDir, id);
	}

	private save(meta: SessionMeta): Promise<void> {
		this.metas.set(meta.id, meta);
		const write = async () => {
			const file = join(this.dir(meta.id), "meta.json");
			const temp = `${file}.${randomUUID()}.tmp`;
			await writeFile(temp, `${JSON.stringify(meta, null, "\t")}\n`, { mode: 0o600 });
			await rename(temp, file);
		};
		const next = (this.saving.get(meta.id) ?? Promise.resolve())
			.catch(() => undefined)
			.then(write)
			.finally(() => {
				if (this.saving.get(meta.id) === next) this.saving.delete(meta.id);
			});
		this.saving.set(meta.id, next);
		return next;
	}
}
