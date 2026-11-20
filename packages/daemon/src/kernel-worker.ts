/** Kernel worker process transport: fork, warm pool, IPC requests and live packet state. */

import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type KernelCommand, type KernelPacket, type KernelUsage, workerEntry } from "@pilot/kernel";
import { credentialEnvironment } from "@pilot/kernel/credential-client";
import type { SessionJob, SessionState, ToolActivitySnapshot } from "@pilot/protocol";
import { operations } from "./event-loop-watchdog.ts";
import { isJobsInspection, jobsInspectionRequestId } from "./input-requests.ts";
import { WorkerActivity } from "./worker-activity.ts";
import { workspaceCommandEnvironment } from "./workspace-environment.ts";

type WorkerSpec = Extract<KernelCommand, { type: "start" }>["spec"];

/** An explicit kernel rejection, unlike a disconnect with uncertain durable admission. */
export class CommandRejected extends Error {
	readonly code?: "busy" | "stopped" | "stale_question";

	constructor(message: string, code?: "busy" | "stopped" | "stale_question") {
		super(message);
		if (code) this.code = code;
	}
}

/** Transport loss is uncertain admission, never an explicit durable rejection. */
export class WorkerUnavailable extends Error {}

export interface WorkerOptions {
	/** Startup channel check cadence. A connected, live worker is allowed to be slow. Defaults to two minutes. */
	startupTimeoutMs?: number;
	/** Admission channel check cadence, not model/tool execution. Defaults to one minute. */
	commandTimeoutMs?: number;
	/** Injectable IPC process for deterministic supervision tests. */
	child?: ChildProcess;
}

/** Injectable daemon boundaries for deterministic startup tests. */
export interface SessionWorker {
	readonly ready: Promise<void>;
	modelConfiguration?: 1;
	questionClarification?: 1;
	/** Includes outstanding acknowledgements and accepted input not yet observed in the event stream. */
	readonly busy?: boolean;
	state: SessionState;
	error?: string;
	usage?: KernelUsage;
	send(command: KernelCommand): void;
	request(command: Extract<KernelCommand, { requestId: string }>): Promise<void>;
	close(): Promise<void>;
	/** Whether the kernel has live subprocesses (background jobs, subagents). Such workers are never parked. */
	hasChildren?(): Promise<boolean>;
	jobs?(): Promise<SessionJob[]>;
	/** Stop one running job for the user. The kernel tells the agent, whose follow-up turn ends the wait. */
	stopJob?(jobId: string): Promise<void>;
	runningJobs?: SessionJob[];
	toolsRunning?: boolean;
	toolActivity?: ToolActivitySnapshot;
	toolStallKey?: string;
	/** Committed chat todo count, supplied on ready and after every mutation. */
	openTodoCount?: number;
	/** Epoch ms when this worker last reported a run start. Absent while idle. */
	workingSince?: number;
	/** The live run awaits this blocking ask_user question. Presentation only; cleared with the worker. */
	awaitedQuestion?: { text: string; at: number };
	/** Live-worker work continues between the last job ending and its result turn completing. */
	awaitingJobFollowUp?: boolean;
	/** Stop holds automatic follow-ups (job and subagent results) until the next run starts. */
	followUpsHeld?: boolean;
	/** A compaction is summarizing the conversation. Shown as work without starting a turn. */
	compacting?: boolean;
}

function forkWorker(spec?: WorkerSpec): ChildProcess {
	const view = spec?.pilot?.coordinatorView;
	if (view) throw new Error("Coordinator workers require a fresh, validated isolated child; refusing warm-pool reuse");
	return fork(fileURLToPath(workerEntry), [], {
		// The worker runs the project's own tools: they must load the project config, and nothing may prompt.
		env: workspaceCommandEnvironment({ ...process.env, ...credentialEnvironment(spec?.credentials) }),
		execArgv: [],
		serialization: "advanced",
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	});
}

/**
 * Live state the kernel reports in packets. Worker applies each packet here before the session manager sees it, and
 * test fakes use the same function, so the manager only reads these fields.
 */
export function applyLivePacket(worker: SessionWorker, packet: KernelPacket): void {
	if (packet.type === "todos.changed") worker.openTodoCount = packet.openCount;
	else if (packet.type === "tool.activity") worker.toolActivity = packet.activity;
	else if (packet.type === "tools.running") worker.toolsRunning = packet.running;
	else if (packet.type === "compacting") worker.compacting = packet.compacting;
	else if (packet.type === "usage") worker.usage = packet.usage;
}

/** One pre-forked kernel process, so a session can skip Node startup and module loading. */
export class WorkerPool {
	private spare?: ChildProcess;
	private timer?: ReturnType<typeof setTimeout>;
	private closed = false;

	take(): ChildProcess {
		const spare = this.spare;
		this.spare = undefined;
		// Do not compete with the session that is starting right now.
		this.refill(5_000);
		if (spare?.connected && spare.exitCode === null && spare.signalCode === null) {
			spare.ref();
			spare.channel?.ref();
			return spare;
		}
		spare?.kill();
		return forkWorker();
	}

	refill(delayMs: number): void {
		if (this.closed || this.spare || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.closed || this.spare) return;
			const child = forkWorker();
			// An unused spare must not keep the daemon (or a test) alive.
			child.unref();
			child.channel?.unref();
			child.once("exit", () => {
				if (this.spare === child) this.spare = undefined;
			});
			this.spare = child;
		}, delayMs);
		this.timer.unref();
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.timer);
		this.spare?.kill();
		this.spare = undefined;
	}
}

export class Worker implements SessionWorker {
	modelConfiguration?: 1;
	questionClarification?: 1;
	private exited = false;
	private initialized = false;
	readonly child: ChildProcess;
	readonly ready: Promise<void>;
	state: SessionState = "starting";
	error?: string;
	workingSince?: number;
	/** Ephemeral context estimate and physical provider, reported by the live kernel. */
	usage?: KernelUsage;
	runningJobs?: SessionJob[];
	toolsRunning?: boolean;
	toolActivity?: ToolActivitySnapshot;
	toolStallKey?: string;
	openTodoCount?: number;
	awaitingJobFollowUp?: boolean;
	followUpsHeld?: boolean;
	awaitedQuestion?: { text: string; at: number };
	compacting = false;
	private readonly pending = new Map<
		string,
		{
			resolve(): void;
			reject(error: Error): void;
			timer: ReturnType<typeof setTimeout>;
			onlyIfIdle?: boolean;
			inspection?: boolean;
			checkpoint?: boolean;
		}
	>();
	private startupTimer?: ReturnType<typeof setTimeout>;
	private killTimer?: ReturnType<typeof setTimeout>;
	private unavailable?: WorkerUnavailable;
	private failReady!: (error: Error) => void;
	private readonly commandTimeoutMs: number;
	private children = true;
	private checkingChildren?: Promise<boolean>;
	private checkingJobs?: Promise<SessionJob[]>;
	private readonly jobResults = new Map<string, SessionJob[]>();
	private closing?: Promise<void>;
	private shutdownRequested = false;
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

	get transportUnavailable(): boolean {
		return this.unavailable !== undefined;
	}

	/** Keeps when the current run started, for passive activity reads. */
	private setWorking(working: boolean): void {
		if (!working) this.workingSince = undefined;
		else if (this.state !== "working") this.workingSince = Date.now();
		this.state = working ? "working" : "idle";
	}

	private readonly onPacket: (packet: KernelPacket) => void;

	constructor(
		spec: Extract<KernelCommand, { type: "start" }>["spec"],
		onPacket: (packet: KernelPacket) => void,
		onExit: (worker: SessionWorker, code: number | null, signal?: NodeJS.Signals | null) => void,
		pool?: WorkerPool,
		options: WorkerOptions = {},
	) {
		this.onPacket = onPacket;
		this.child = operations.time(
			"worker.acquire",
			() => options.child ?? (spec.pilot?.coordinatorView ? forkWorker(spec) : (pool?.take() ?? forkWorker())),
		);
		this.commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
		let markReady!: () => void;
		let markFailed!: (error: Error) => void;
		this.ready = new Promise<void>((resolve, reject) => {
			markReady = resolve;
			markFailed = reject;
		});
		this.ready.catch(() => undefined);
		this.failReady = markFailed;
		this.startupTimer = this.checkChannel(options.startupTimeoutMs ?? 120_000);
		const handle = (message: unknown) => {
			if (this.unavailable || this.exited) return;
			const packet = message as KernelPacket;
			applyLivePacket(this, packet);
			if (packet.type === "events" && packet.watchId === this.activityWatchId) {
				this.activity.observe(packet.events);
				return;
			}
			if (packet.type === "ready") {
				this.modelConfiguration = packet.modelConfiguration;
				this.questionClarification = packet.questionClarification;
				clearTimeout(this.startupTimer);
				this.usage = packet.usage;
				this.toolsRunning = packet.toolsRunning;
				this.openTodoCount = packet.openTodoCount;
				this.initialized = true;
				this.setWorking(packet.working);
				this.compacting = packet.compacting === true;
				markReady();
			} else if (packet.type === "working") {
				this.setWorking(packet.working);
			} else if (packet.type === "modelChanged") {
				this.usage = packet.usage;
				this.settle(packet.requestId);
			} else if (packet.type === "piReloaded") {
				this.error = undefined;
				this.settle(packet.requestId);
			} else if (packet.type === "rewound") {
				this.settle(packet.requestId);
			} else if (packet.type === "children") {
				this.children = packet.hasChildren !== false;
				this.settle(packet.requestId);
			} else if (packet.type === "jobs") {
				if (this.pending.has(packet.requestId)) this.jobResults.set(packet.requestId, packet.jobs);
				this.settle(packet.requestId);
				return;
			} else if (packet.type === "accepted" || packet.type === "aborted") {
				// IPC acceptance can precede working=true. A fresh committed snapshot is the idle barrier,
				// including idempotent retries which produce no new run/inbox events.
				if (packet.type === "accepted" && !this.pending.get(packet.requestId)?.checkpoint) this.refreshActivity();
				this.settle(packet.requestId);
			} else if (packet.type === "error") {
				const inspection =
					packet.requestId &&
					(this.pending.get(packet.requestId)?.inspection || isJobsInspection(packet.requestId));
				const idleRejection =
					packet.code === "busy" && packet.requestId && this.pending.get(packet.requestId)?.onlyIfIdle;
				if (packet.requestId) this.settle(packet.requestId, new CommandRejected(packet.message, packet.code));
				else if (!this.initialized) {
					clearTimeout(this.startupTimer);
					markFailed(new Error(packet.message));
					this.state = "failed";
				}
				if (!idleRejection && !inspection) this.error = packet.message;
				if (inspection) return;
			}
			if ((packet.type === "ready" || packet.type === "working") && packet.working) this.error = undefined;
			this.onPacket(packet);
		};
		// Large snapshots and their listeners run synchronously here. Attribute them if the event loop stalls.
		this.child.on("message", (message) =>
			operations.time(
				() => `kernel ${(message as KernelPacket).type} packet for ${spec.sessionId}`,
				() => handle(message),
				250,
			),
		);
		this.child.on("error", (error) => {
			this.failTransport(new WorkerUnavailable(error.message, { cause: error }));
		});
		this.child.on("disconnect", () => this.failTransport(new WorkerUnavailable("Kernel IPC disconnected")));
		this.child.on("exit", (code, signal) => {
			this.exited = true;
			clearTimeout(this.startupTimer);
			clearTimeout(this.killTimer);
			this.killTimer = undefined;
			const error =
				this.unavailable ??
				new WorkerUnavailable(signal ? `Kernel exited with signal ${signal}` : `Kernel exited with code ${code}`);
			markFailed(error);
			for (const id of [...this.pending.keys()]) this.settle(id, error);
			onExit(this, code, signal);
		});
		this.send({ type: spec.configurationOnly ? "startConfiguration" : "start", spec });
		this.refreshActivity();
	}

	/** Only OS/channel evidence can retire a writer. Starvation cannot revoke its storage lease. */
	private checkChannel(intervalMs: number): ReturnType<typeof setTimeout> {
		const timer = setTimeout(() => {
			if (this.unavailable || this.exited || this.shutdownRequested) return;
			if (!this.child.connected || this.child.exitCode !== null || this.child.signalCode != null)
				this.failTransport(new WorkerUnavailable("Kernel IPC disconnected"));
			else timer.refresh();
		}, intervalMs);
		timer.unref();
		return timer;
	}

	private refreshActivity(): void {
		const previous = this.activityWatchId;
		this.activityWatchId = randomUUID();
		this.activity.reset();
		if (previous) this.send({ type: "unwatch", watchId: previous });
		this.send({ type: "watch", watchId: this.activityWatchId, includeTodos: false, activityOnly: true });
	}

	send(command: KernelCommand): void {
		if (this.unavailable || this.exited) return;
		if (!this.child.connected) {
			queueMicrotask(() => this.failTransport(new WorkerUnavailable("Kernel IPC disconnected")));
			return;
		}
		try {
			// Includes synchronous IPC serialization, not the asynchronous acknowledgement or provider work.
			operations.time("worker.send", () =>
				this.child.send(command, (error: Error | null) => {
					if (error)
						queueMicrotask(() => this.failTransport(new WorkerUnavailable(error.message, { cause: error })));
				}),
			);
		} catch (error) {
			queueMicrotask(() => this.failTransport(new WorkerUnavailable("Kernel IPC send failed", { cause: error })));
		}
	}

	hasChildren(): Promise<boolean> {
		// The kernel owns exact MCP transport identities. Unknown children still protect jobs/subagents.
		this.checkingChildren ??= this.request({ type: "inspectChildren", requestId: randomUUID() })
			.then(
				() => this.children,
				() => true,
			)
			.finally(() => {
				this.checkingChildren = undefined;
			});
		return this.checkingChildren;
	}

	/** Coalesce concurrent viewers without retaining snapshots after the read. */
	jobs(): Promise<SessionJob[]> {
		if (this.checkingJobs) return this.checkingJobs;
		const requestId = jobsInspectionRequestId(randomUUID());
		this.checkingJobs = this.request({ type: "inspectJobs", requestId })
			.then(() => {
				const jobs = this.jobResults.get(requestId);
				if (!jobs) throw new Error("Kernel did not return a jobs list");
				return jobs;
			})
			.finally(() => {
				this.jobResults.delete(requestId);
				this.checkingJobs = undefined;
			});
		return this.checkingJobs;
	}

	stopJob(jobId: string): Promise<void> {
		return this.request({ type: "stopJob", requestId: `stopJob:${randomUUID()}`, jobId });
	}

	/** Send a command and wait for its accepted/aborted/error acknowledgement. */
	request(command: Extract<KernelCommand, { requestId: string }>): Promise<void> {
		if (this.unavailable) return Promise.reject(this.unavailable);
		if (this.exited || !this.child.connected) return Promise.reject(new WorkerUnavailable("Kernel is disconnected"));
		return new Promise((resolve, reject) => {
			// Job-stop errors and delays belong to that job, not the session transport.
			const inspection =
				command.type === "inspectChildren" || command.type === "inspectJobs" || command.type === "stopJob";
			// Inspections and job controls retain their bounded deadline and conservative busy fallback.
			// Mutations must retain their waiter/ID until acknowledged or the peer actually dies.
			const timer = inspection
				? setTimeout(
						() => {
							this.settle(
								command.requestId,
								new WorkerUnavailable(`Kernel ${command.type} acknowledgement timed out`),
							);
						},
						Math.min(this.commandTimeoutMs, 10_000),
					)
				: this.checkChannel(this.commandTimeoutMs);
			timer.unref();
			this.pending.set(command.requestId, {
				resolve,
				reject,
				timer,
				...(inspection ? { inspection: true } : {}),
				...(command.type === "checkpointLifecycle" ? { checkpoint: true } : {}),
				...(command.type === "reloadPi" || (command.type === "input" && command.onlyIfIdle)
					? { onlyIfIdle: true }
					: {}),
			});
			this.send(command);
		});
	}

	close(): Promise<void> {
		// Set before sending: disconnect or a send failure can arrive synchronously.
		this.shutdownRequested = true;
		this.closing ??= new Promise((resolve) => {
			if (this.exited || this.child.exitCode !== null) return resolve();
			this.armKillDeadline();
			this.child.once("exit", () => {
				resolve();
			});
			this.send({ type: "shutdown" });
		});
		return this.closing;
	}

	private armKillDeadline(): void {
		if (this.killTimer || this.exited) return;
		this.killTimer = setTimeout(() => {
			if (!this.exited) this.child.kill("SIGKILL");
			// Still await confirmed exit before another worker may acquire the storage lease.
		}, 8_000);
		this.killTimer.unref();
	}

	private failTransport(error: WorkerUnavailable): void {
		// Expected IPC teardown must not turn an intentional close into a session failure.
		// The close deadline still waits for confirmed exit and escalates if necessary.
		if (this.unavailable || this.exited || this.shutdownRequested) return;
		// The kernel reports its own startup failure, then exits. Keep that reason, not the IPC teardown after it.
		const reported = !this.initialized && this.state === "failed" ? this.error : undefined;
		this.unavailable = reported ? new WorkerUnavailable(reported, { cause: error }) : error;
		this.error = this.unavailable.message;
		this.state = "failed";
		clearTimeout(this.startupTimer);
		this.failReady(this.unavailable);
		for (const id of [...this.pending.keys()]) this.settle(id, this.unavailable);
		this.armKillDeadline();
		this.onPacket({ type: "error", message: this.unavailable.message });
		// Give SDK shutdown/process-exit hooks a chance to reap detached MCP transport groups.
		if (!this.exited) this.child.kill("SIGTERM");
	}

	private settle(requestId: string, error?: Error): void {
		const waiter = this.pending.get(requestId);
		if (!waiter) return;
		this.pending.delete(requestId);
		clearTimeout(waiter.timer);
		if (error) waiter.reject(error);
		else waiter.resolve();
	}
}
