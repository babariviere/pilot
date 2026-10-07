/** Session registry and kernel worker supervision. */
import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactNotFound, ArtifactStore } from "@pilot/artifacts";
import { type KernelCommand, type KernelPacket, type WorkspaceContext, workerEntry } from "@pilot/kernel";
import type {
	AgentEvent,
	ArtifactRevision,
	ArtifactSummary,
	DeliveryMode,
	SessionPullRequest,
	SessionListQuery,
	SessionState,
	SessionSummary,
	SessionUsage,
	SpawnRequest,
	UpdatePreparation,
} from "@pilot/protocol";
import { Conflict, NotFound } from "./errors.ts";
import { type ProjectStore, requireDirectory } from "./projects.ts";
import { UpdateGate } from "./update-gate.ts";
import { WorkerActivity } from "./worker-activity.ts";
import { type PullRequestOptions, type PullRequestResult, PullRequestTracker } from "./pull-requests.ts";
import { applyActivity, applyFailure, type OutcomeMeta } from "./session-outcomes.ts";
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
		onExit: (worker: SessionWorker, code: number | null, signal?: NodeJS.Signals | null) => void,
	) => SessionWorker;
}

interface SessionMeta extends OutcomeMeta {
	id: string;
	title: string;
	cwd: string;
	projectId?: string;
	/** Private clone the session works in (its cwd), and where it came from. */
	workspace?: WorkspaceContext;
	createdAt: number;
	updatedAt: number;
	archivedAt?: number;
	/** Remember successful merge archives so restoring a chat survives polling and restarts. */
	autoArchivedPullRequest?: string;
	model?: string;
	thinking?: string;
	/** Cleared only after initialization and durable input admission. */
	initializing?: boolean;
	preparing?: { source: string; branch: string };
	pending?: PendingCommand[];
	/** A stopped, unopened workspace has no conversation history to load yet. */
	cancelled?: boolean;
	/** A recoverable input/admission error, not a failed worker initialization. */
	inputError?: string;
	failure?: string;
	pullRequest?: SessionPullRequest;
	pullRequestError?: string;
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
		onExit: (worker: SessionWorker, code: number | null, signal?: NodeJS.Signals | null) => void,
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
					markFailed(new Error(packet.message));
					this.state = "failed";
				}
				this.error = packet.message;
			}
			if ((packet.type === "ready" || packet.type === "working") && packet.working) this.error = undefined;
			this.onPacket(packet);
		});
		this.child.on("error", (error) => {
			this.error = error.message;
			this.state = "failed";
			if (!this.initialized) {
				markFailed(error);
			}
			for (const id of [...this.pending.keys()]) this.settle(id, error);
			this.onPacket({ type: "error", message: error.message });
		});
		this.child.on("exit", (code, signal) => {
			this.exited = true;
			const error = new Error(signal ? `Kernel exited with signal ${signal}` : `Kernel exited with code ${code}`);
			markFailed(error);
			for (const id of [...this.pending.keys()]) this.settle(id, error);
			onExit(this, code, signal);
		});
		this.send({ type: "start", spec });
		this.refreshActivity();
	}

	private refreshActivity(): void {
		const previous = this.activityWatchId;
		this.activityWatchId = randomUUID();
		this.activity.reset();
		if (previous) this.send({ type: "unwatch", watchId: previous });
		this.send({ type: "watch", watchId: this.activityWatchId, includeTodos: false });
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
	private readonly artifactListeners = new Set<(sessionId: string, artifacts: ArtifactSummary[]) => void>();
	private readonly artifactNotifications = new Map<string, Promise<void>>();
	/** Serialized, immutable metadata snapshots per session. */
	private readonly saving = new Map<string, Promise<void>>();
	private readonly starting = new Map<string, Promise<Map<string, Error>>>();
	private readonly preparations = new Set<Promise<Workspace>>();
	private readonly shutdownSignal = new AbortController();
	private readonly updateGate = new UpdateGate();
	/** Admissions waiting for acknowledgement must not race archiving. */
	private readonly sending = new Map<string, number>();
	/** Same-target retries share the durable result; opposite transitions execute in order. */
	private readonly archiveTransitions = new Map<string, { archived: boolean; promise: Promise<SessionSummary> }>();
	private closing = false;
	private readonly pullRequests: PullRequestTracker;

	constructor(
		private readonly home: string,
		private readonly projects: ProjectStore,
		private readonly agentDir?: string,
		private readonly factories: SessionFactories = {},
		pullRequests: PullRequestOptions = {},
	) {
		this.pullRequests = new PullRequestTracker(
			() => this.metas.values(),
			(session, result) => this.applyPullRequest(this.require(session.id), result),
			pullRequests,
		);
	}

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
			if (
				meta.archivedAt === undefined &&
				!meta.failure &&
				(meta.initializing || meta.pending?.length || meta.working)
			)
				void this.start(meta.id, true);
		this.pullRequests.start();
	}

	onChange(listener: (session: SessionSummary) => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	onArtifactsChanged(listener: (sessionId: string, artifacts: ArtifactSummary[]) => void): () => void {
		this.artifactListeners.add(listener);
		return () => this.artifactListeners.delete(listener);
	}

	/** Read committed artifacts without creating or waking a kernel worker. */
	async artifacts(id: string): Promise<ArtifactSummary[]> {
		return this.artifactStore(id).list();
	}

	async artifact(id: string, artifactId: string, revision?: number): Promise<ArtifactRevision> {
		const store = this.artifactStore(id);
		if (revision !== undefined && (!Number.isSafeInteger(revision) || revision <= 0))
			throw new Error("revision must be a positive integer");
		try {
			return await store.get(artifactId, revision);
		} catch (error) {
			if (error instanceof ArtifactNotFound) throw new NotFound(error.message);
			throw error;
		}
	}

	async projectArtifacts(projectId: string): Promise<ArtifactSummary[]> {
		this.projects.require(projectId);
		const lists = await Promise.all(
			[...this.metas.values()].filter((meta) => meta.projectId === projectId).map((meta) => this.artifacts(meta.id)),
		);
		return lists.flat().sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private artifactStore(id: string): ArtifactStore {
		const meta = this.require(id);
		return new ArtifactStore(this.dir(id), {
			sessionId: id,
			...(meta.projectId ? { projectId: meta.projectId } : {}),
		});
	}

	list(query: SessionListQuery = {}): SessionSummary[] {
		return [...this.metas.values()]
			.filter((meta) => {
				const archived = meta.archivedAt !== undefined;
				return (
					(query.archived === "all" || archived === (query.archived === "true")) &&
					(query.projectId === undefined || meta.projectId === query.projectId)
				);
			})
			.map((meta) => this.summary(meta))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Non-destructive: keep the transcript, branch and workspace available for viewing and restoration. */
	async archive(id: string): Promise<SessionSummary> {
		const end = this.updateGate.begin();
		try {
			return await this.setArchived(id, true);
		} finally {
			end();
		}
	}

	async restore(id: string): Promise<SessionSummary> {
		const end = this.updateGate.begin();
		try {
			return await this.setArchived(id, false);
		} finally {
			end();
		}
	}

	private setArchived(id: string, archived: boolean, autoArchivedPullRequest?: string): Promise<SessionSummary> {
		if (this.closing) throw new Error("pilotd is shutting down");
		this.require(id);
		const previous = this.archiveTransitions.get(id);
		if (previous?.archived === archived) return previous.promise;
		const promise = (previous?.promise ?? Promise.resolve())
			.catch(() => undefined)
			.then(async () => {
				const meta = this.require(id);
				if (autoArchivedPullRequest && meta.autoArchivedPullRequest === autoArchivedPullRequest)
					return this.summary(meta);
				if ((meta.archivedAt !== undefined) === archived) return this.summary(meta);
				const worker = this.workers.get(id);
				if (
					archived &&
					(meta.working ||
						meta.initializing ||
						meta.preparing ||
						meta.pending?.length ||
						worker?.state === "starting" ||
						worker?.state === "working" ||
						worker?.busy ||
						this.sending.has(id))
				)
					throw new Conflict("Stop the session before archiving it");
				// Stage only this write. Concurrent lifecycle saves and summaries keep the committed state.
				await this.save(meta, { timestamp: archived ? Date.now() : undefined, autoArchivedPullRequest });
				this.emit(meta);
				return this.summary(meta);
			});
		this.archiveTransitions.set(id, { archived, promise });
		const clear = () => {
			if (this.archiveTransitions.get(id)?.promise === promise) this.archiveTransitions.delete(id);
		};
		void promise.then(clear, clear);
		return promise;
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
		const transition = this.archiveTransitions.get(id);
		if (transition) await transition.promise;
		if (meta.archivedAt !== undefined) throw new Conflict("Restore the archived session before sending a message");
		this.sending.set(id, (this.sending.get(id) ?? 0) + 1);
		try {
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
		} finally {
			const count = (this.sending.get(id) ?? 1) - 1;
			if (count) this.sending.set(id, count);
			else this.sending.delete(id);
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
			const transition = this.archiveTransitions.get(id);
			if (transition) await transition.promise;
			if (meta.archivedAt !== undefined) throw new Conflict("Restore the archived session before editing messages");
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
		const drainPullRequests = this.pullRequests.stop();
		this.shutdownSignal.abort();
		await Promise.allSettled([...this.preparations]);
		await Promise.all([...this.workers.values()].map((worker) => worker.close()));
		await Promise.all([...this.artifactNotifications.values()]);
		await drainPullRequests;
		await Promise.allSettled([...this.archiveTransitions.values()].map((transition) => transition.promise));
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
					void this.pullRequests.refresh(meta);
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
				const now = Date.now();
				applyFailure(meta, meta.failure, now);
				meta.updatedAt = now;
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
				...(meta.projectId ? { projectId: meta.projectId } : {}),
				storageDir: join(this.dir(id), "durable"),
				cwd: meta.cwd,
				model: meta.model,
				thinking: meta.thinking,
				agentDir: this.agentDir,
				...(meta.workspace ? { trustDirectory: meta.workspace.source } : {}),
				pilot: meta.workspace ? { workspace: meta.workspace } : {},
			},
			(packet) => this.onPacket(meta, worker, packet),
			(exited, code, signal) => this.onExit(meta, exited, code, signal),
		);
		this.workers.set(id, worker);
		// Reattach existing subscribers, for example after a kernel restart.
		for (const watchId of this.watchers.get(id)?.keys() ?? []) worker.send({ type: "watch", watchId });
		this.emit(meta);
		return worker;
	}

	private onExit(
		meta: SessionMeta,
		exited: SessionWorker,
		code: number | null,
		signal: NodeJS.Signals | null = null,
	): void {
		if (this.workers.get(meta.id) === exited) this.workers.delete(meta.id);
		if (!this.closing) {
			if (exited.state === "failed") {
				// Preserve performance recovery: transport failures do not permanently disable the session.
				meta.inputError =
					exited.error ?? (signal ? `Kernel exited with signal ${signal}` : `Kernel exited with code ${code}`);
				void this.save(meta);
			}
			if (code !== 0 || signal !== null || exited.state === "working" || exited.state === "starting") {
				const reason =
					exited.error ?? (signal ? `Kernel exited with signal ${signal}` : `Kernel exited with code ${code}`);
				// Retain a kernel error's original completion version and specific reason.
				if (meta.outcome !== "failed" || meta.working) this.fail(meta, reason);
				if (code !== 0 || signal !== null) console.warn(`pilotd: kernel for ${meta.id} exited with code ${code}`);
			}
		}
		// Never publish the exited worker's stale lifecycle state or usage.
		this.emit(meta);
	}

	private fail(meta: SessionMeta, reason: string): void {
		const now = Date.now();
		if (applyFailure(meta, reason, now)) {
			meta.updatedAt = now;
			void this.save(meta);
		}
	}

	private onPacket(meta: SessionMeta, worker: SessionWorker, packet: KernelPacket): void {
		if (packet.type === "artifacts.changed") {
			const next = (this.artifactNotifications.get(meta.id) ?? Promise.resolve())
				.then(async () => {
					const artifacts = await this.artifacts(meta.id);
					for (const listener of this.artifactListeners) listener(meta.id, artifacts);
				})
				.catch((error: unknown) => console.warn(`pilotd: could not read artifacts for ${meta.id}: ${error}`))
				.finally(() => {
					if (this.artifactNotifications.get(meta.id) === next) this.artifactNotifications.delete(meta.id);
				});
			this.artifactNotifications.set(meta.id, next);
			return;
		}
		if (packet.type === "events") {
			this.watchers.get(meta.id)?.get(packet.watchId)?.(packet.events);
			return;
		}
		if (packet.type === "ready" || packet.type === "working") {
			const wasWorking = Boolean(meta.working);
			const changed = applyActivity(meta, packet.working, packet.completion);
			if (packet.type === "ready") {
				// Opening a transcript or restarting its worker is not new chat activity.
				meta.model = packet.model;
				void this.save(meta);
			} else if (wasWorking !== packet.working || (changed && packet.completion)) {
				meta.updatedAt = Date.now();
				void this.save(meta);
			}
			if (!packet.working && (wasWorking || (changed && packet.completion))) void this.pullRequests.refresh(meta);
		} else if (packet.type === "error" && !packet.requestId && worker.state === "failed" && !this.closing) {
			this.fail(meta, packet.message);
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
			...(meta.archivedAt !== undefined ? { archivedAt: meta.archivedAt } : {}),
			state: meta.failure
				? "failed"
				: meta.initializing
					? "starting"
					: meta.inputError && (!meta.working || !worker)
						? "failed"
						: (worker?.state ?? "parked"),
			...(meta.model ? { model: meta.model } : {}),
			...(worker?.usage ? { usage: worker.usage } : {}),
			...(meta.outcome ? { outcome: meta.outcome } : {}),
			...(meta.outcomeAt !== undefined ? { outcomeAt: meta.outcomeAt } : {}),
			...(meta.outcomeReason !== undefined ? { outcomeReason: meta.outcomeReason } : {}),
			...(meta.pullRequest ? { pullRequest: meta.pullRequest } : {}),
			...(meta.pullRequestError ? { pullRequestError: meta.pullRequestError } : {}),
			...(meta.failure || meta.inputError || worker?.error
				? { error: meta.failure || meta.inputError || worker?.error }
				: {}),
		};
	}

	private async applyPullRequest(meta: SessionMeta, result: PullRequestResult): Promise<void> {
		const previous = meta.pullRequest;
		const previousError = meta.pullRequestError;
		const next = result.pullRequest;
		const changed =
			previousError !== result.error ||
			(next !== undefined &&
				(previous?.number !== next.number ||
					previous.url !== next.url ||
					previous.title !== next.title ||
					previous.state !== next.state));
		if (next) meta.pullRequest = next;
		if (result.error) meta.pullRequestError = result.error;
		else delete meta.pullRequestError;
		// PR freshness is not agent activity. Keep ordering and completion versions unchanged.
		if (next || changed) {
			try {
				await this.save(meta);
			} catch (error) {
				// Publish only persisted PR updates, and let the next check retry the same error.
				// Other activity/outcome fields may have changed during I/O. Never roll those back.
				if (previous) meta.pullRequest = previous;
				else delete meta.pullRequest;
				if (previousError !== undefined) meta.pullRequestError = previousError;
				else delete meta.pullRequestError;
				throw error;
			}
		}
		if (next || changed) this.emit(meta);
		// Only a fresh merge result can archive a chat. Busy chats retry on the next lookup.
		if (
			next?.state === "merged" &&
			!result.error &&
			!this.closing &&
			meta.archivedAt === undefined &&
			meta.autoArchivedPullRequest !== next.url
		) {
			try {
				await this.setArchived(meta.id, true, next.url);
			} catch (error) {
				if (!(error instanceof Conflict)) throw error;
			}
		}
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

	private save(meta: SessionMeta, archive?: { timestamp?: number; autoArchivedPullRequest?: string }): Promise<void> {
		this.metas.set(meta.id, meta);
		// Capture before joining the queue. The live meta can change while an earlier write awaits I/O.
		const snapshot = `${JSON.stringify(meta, null, "\t")}\n`;
		const write = async () => {
			const file = join(this.dir(meta.id), "meta.json");
			const temp = `${file}.${randomUUID()}.tmp`;
			const persisted = JSON.parse(snapshot) as SessionMeta;
			// Archive state commits only after rename, unlike captured lifecycle transitions.
			const archivedAt = archive ? archive.timestamp : meta.archivedAt;
			if (archivedAt === undefined) delete persisted.archivedAt;
			else persisted.archivedAt = archivedAt;
			// Like archivedAt, the merge marker must not be lost to queued lifecycle snapshots.
			const autoArchivedPullRequest = archive?.autoArchivedPullRequest ?? meta.autoArchivedPullRequest;
			if (autoArchivedPullRequest !== undefined) persisted.autoArchivedPullRequest = autoArchivedPullRequest;
			await writeFile(temp, `${JSON.stringify(persisted, null, "\t")}\n`, { mode: 0o600 });
			await rename(temp, file);
			// Commit in memory before the next queued save can read the metadata.
			if (archive) {
				if (archive.timestamp === undefined) delete meta.archivedAt;
				else meta.archivedAt = archive.timestamp;
				if (archive.autoArchivedPullRequest !== undefined)
					meta.autoArchivedPullRequest = archive.autoArchivedPullRequest;
			}
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
