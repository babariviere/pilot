/** Session registry and kernel worker supervision. */
import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type KernelCommand, type KernelPacket, type WorkspaceContext, workerEntry } from "@pilot/kernel";
import type { AgentEvent, DeliveryMode, SessionState, SessionSummary, SpawnRequest } from "@pilot/protocol";
import { NotFound } from "./errors.ts";
import { type ProjectStore, requireDirectory } from "./projects.ts";
import { branchSlug, createWorkspace } from "./workspaces.ts";

export { NotFound } from "./errors.ts";

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
}

type EventListener = (events: AgentEvent[]) => void;

const ID_PATTERN = /^[0-9a-f-]{36}$/;

function titleFrom(message: string): string {
	const line = message.trim().split("\n")[0] ?? "";
	return line.length > 60 ? `${line.slice(0, 57)}...` : line || "Untitled session";
}

class Worker {
	readonly child: ChildProcess;
	readonly ready: Promise<void>;
	state: SessionState = "starting";
	error?: string;
	private readonly pending = new Map<string, { resolve(): void; reject(error: Error): void }>();

	constructor(
		spec: Extract<KernelCommand, { type: "start" }>["spec"],
		private readonly onPacket: (packet: KernelPacket) => void,
		onExit: (worker: Worker, code: number | null) => void,
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
			if (packet.type === "ready") {
				this.state = packet.working ? "working" : "idle";
				markReady();
			} else if (packet.type === "working") {
				this.state = packet.working ? "working" : "idle";
			} else if (packet.type === "accepted" || packet.type === "aborted") {
				this.settle(packet.requestId);
			} else if (packet.type === "error") {
				if (packet.requestId) this.settle(packet.requestId, new Error(packet.message));
				else if (this.state === "starting") {
					this.state = "failed";
					this.error = packet.message;
					markFailed(new Error(packet.message));
				} else this.error = packet.message;
			}
			this.onPacket(packet);
		});
		this.child.on("exit", (code) => {
			const error = new Error(`Kernel exited with code ${code}`);
			markFailed(error);
			for (const id of [...this.pending.keys()]) this.settle(id, error);
			onExit(this, code);
		});
		this.send({ type: "start", spec });
	}

	send(command: KernelCommand): void {
		if (this.child.connected) this.child.send(command);
	}

	/** Send a command and wait for its accepted/aborted/error acknowledgement. */
	request(command: Extract<KernelCommand, { requestId: string }>): Promise<void> {
		return new Promise((resolve, reject) => {
			this.pending.set(command.requestId, { resolve, reject });
			this.send(command);
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
	private readonly workers = new Map<string, Worker>();
	/** sessionId -> watchId -> listener */
	private readonly watchers = new Map<string, Map<string, EventListener>>();
	private readonly changeListeners = new Set<(session: SessionSummary) => void>();
	/** Serialized metadata writes per session; the latest in-memory state always wins. */
	private readonly saving = new Map<string, Promise<void>>();
	private closing = false;

	constructor(
		private readonly home: string,
		private readonly projects: ProjectStore,
		private readonly agentDir?: string,
	) {}

	private get sessionsDir(): string {
		return join(this.home, "sessions");
	}

	async load(): Promise<void> {
		await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
		for (const id of await readdir(this.sessionsDir)) {
			if (!ID_PATTERN.test(id)) continue;
			try {
				const meta = JSON.parse(await readFile(join(this.sessionsDir, id, "meta.json"), "utf8")) as SessionMeta;
				this.metas.set(meta.id, meta);
			} catch (error) {
				console.warn(`pilotd: skipping unreadable session ${id}: ${error}`);
			}
		}
		// Durable work interrupted by a restart continues as soon as its kernel reopens.
		for (const meta of this.metas.values()) if (meta.working) this.ensureWorker(meta.id);
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
		return { cwd: meta.cwd, ...(meta.workspace ? { base: meta.workspace.base } : {}) };
	}

	async spawn(request: SpawnRequest): Promise<SessionSummary> {
		if (typeof request.message !== "string" || !request.message.trim()) throw new Error("message is required");
		const project = request.projectId ? this.projects.require(request.projectId) : undefined;
		const directory = request.cwd?.trim() || project?.path;
		if (!directory) throw new Error("projectId or cwd is required");
		let cwd = await requireDirectory(directory);
		const model = request.model?.trim() || project?.model;
		const now = Date.now();
		const id = randomUUID();
		const title = request.title?.trim() || titleFrom(request.message);
		await mkdir(this.dir(id), { recursive: true, mode: 0o700 });
		// Project sessions get a private clone unless the project opts out or a cwd override is given.
		let workspace: WorkspaceContext | undefined;
		if (project && !request.cwd?.trim() && project.workspace !== "direct") {
			const branch = `pilot/${branchSlug(title)}-${id.slice(0, 6)}`;
			try {
				const created = await createWorkspace(project.path, join(this.dir(id), "workspace"), branch);
				workspace = {
					source: project.path,
					branch: created.branch,
					base: created.base,
					jj: created.jj,
					...(created.upstream ? { upstream: created.upstream } : {}),
				};
				cwd = created.path;
			} catch (error) {
				await rm(this.dir(id), { recursive: true, force: true });
				throw new Error(
					`Could not create a workspace for ${project.name}: ${error instanceof Error ? error.message : error}`,
				);
			}
		}
		const meta: SessionMeta = {
			id,
			title,
			cwd,
			...(project ? { projectId: project.id } : {}),
			...(workspace ? { workspace } : {}),
			createdAt: now,
			updatedAt: now,
			...(model ? { model } : {}),
			...(request.thinking ? { thinking: request.thinking } : {}),
		};
		await this.save(meta);
		await this.send(meta.id, request.message, "followUp");
		return this.summary(meta);
	}

	async send(
		id: string,
		message: string,
		mode: DeliveryMode = "followUp",
		requestId: string = randomUUID(),
	): Promise<void> {
		const meta = this.require(id);
		if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
		const worker = this.ensureWorker(id);
		await worker.ready;
		await worker.request({ type: "input", requestId, content: message, mode });
		meta.updatedAt = Date.now();
		await this.save(meta);
		this.emit(meta);
	}

	async stop(id: string): Promise<void> {
		this.require(id);
		const worker = this.workers.get(id);
		if (!worker) return;
		await worker.ready;
		await worker.request({ type: "abort", requestId: randomUUID() });
	}

	/** Attach a live event stream. The first batch is always a snapshot. */
	subscribe(id: string, listener: EventListener): () => void {
		this.require(id);
		const watchId = randomUUID();
		let watchers = this.watchers.get(id);
		if (!watchers) {
			watchers = new Map();
			this.watchers.set(id, watchers);
		}
		watchers.set(watchId, listener);
		const worker = this.ensureWorker(id);
		worker.send({ type: "watch", watchId });
		return () => {
			watchers.delete(watchId);
			this.workers.get(id)?.send({ type: "unwatch", watchId });
		};
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		await Promise.all(
			[...this.workers.values()].map(
				(worker) =>
					new Promise<void>((resolve) => {
						if (worker.child.exitCode !== null) return resolve();
						worker.child.once("exit", () => resolve());
						worker.send({ type: "shutdown" });
						setTimeout(() => {
							worker.child.kill("SIGKILL");
							resolve();
						}, 8_000).unref();
					}),
			),
		);
	}

	private ensureWorker(id: string): Worker {
		const existing = this.workers.get(id);
		if (existing) return existing;
		if (this.closing) throw new Error("pilotd is shutting down");
		const meta = this.require(id);
		const worker = new Worker(
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
				if (!this.closing && code !== 0) console.warn(`pilotd: kernel for ${id} exited with code ${code}`);
				this.emit(meta, exited);
			},
		);
		this.workers.set(id, worker);
		// Reattach existing subscribers, for example after a kernel restart.
		for (const watchId of this.watchers.get(id)?.keys() ?? []) worker.send({ type: "watch", watchId });
		this.emit(meta);
		return worker;
	}

	private onPacket(meta: SessionMeta, worker: Worker, packet: KernelPacket): void {
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
		const exited = worker && worker.child.exitCode !== null;
		return {
			id: meta.id,
			title: meta.title,
			cwd: meta.cwd,
			...(meta.projectId ? { projectId: meta.projectId } : {}),
			...(meta.workspace ? { branch: meta.workspace.branch } : {}),
			createdAt: meta.createdAt,
			updatedAt: meta.updatedAt,
			state: !worker || (exited && worker.state !== "failed") ? "parked" : worker.state,
			...(meta.model ? { model: meta.model } : {}),
			...(worker?.error ? { error: worker.error } : {}),
		};
	}

	private emit(meta: SessionMeta, worker?: Worker): void {
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
		const next = (this.saving.get(meta.id) ?? Promise.resolve()).catch(() => undefined).then(write);
		this.saving.set(meta.id, next);
		return next;
	}
}
