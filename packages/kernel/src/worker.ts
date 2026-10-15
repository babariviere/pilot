/** Kernel worker entry: one process per session, driven over Node IPC by pilotd. */

import { randomUUID } from "node:crypto";
import { serialize } from "node:v8";
import type { JsonValue } from "@earendil-works/chord";
import { ConversationBusy } from "@earendil-works/pi-durable";
import { closePreviewBrowser } from "@pilot/artifacts";
import { formatFailure } from "./failure.ts";
import type { MissionCall } from "./mission-tools.ts";
import type { MissionContext, WorkspaceContext } from "./policy.ts";
import type { KernelCommand, KernelPacket } from "./protocol.ts";
import { KernelSession } from "./session.ts";

const errorText = formatFailure;

export interface IpcChannel {
	readonly connected: boolean;
	send(packet: KernelPacket, callback: (error: Error | null) => void): boolean;
}

type SendJob = { packet: KernelPacket; bytes: number; resolve(): void; reject(error: Error): void };

/** One in-flight write, bounded FIFO retention. Never silently drop ordered state deltas. */
export class IpcSender {
	private readonly waiting: SendJob[] = [];
	private inFlight?: SendJob;
	private failure?: Error;
	private timer?: ReturnType<typeof setTimeout>;
	private bytes = 0;
	private readonly channel: IpcChannel;
	private readonly onFailure: (error: Error) => void;
	private readonly options: { maxBytes: number; maxPacketBytes: number; maxPackets: number; timeoutMs: number };

	constructor(
		channel: IpcChannel,
		onFailure: (error: Error) => void,
		options = { maxBytes: 128 * 1024 * 1024, maxPacketBytes: 64 * 1024 * 1024, maxPackets: 256, timeoutMs: 30_000 },
	) {
		this.channel = channel;
		this.onFailure = onFailure;
		this.options = options;
	}

	get pendingBytes(): number {
		return this.bytes;
	}

	get pendingPackets(): number {
		return this.waiting.length + (this.inFlight ? 1 : 0);
	}

	send(packet: KernelPacket): Promise<void> {
		if (this.failure) return Promise.reject(this.failure);
		let bytes: number;
		try {
			bytes = serialize(packet).byteLength;
		} catch (error) {
			this.fail(new Error(`Kernel IPC serialization failed: ${errorText(error)}`));
			return Promise.reject(this.failure);
		}
		if (
			!this.channel.connected ||
			bytes > this.options.maxPacketBytes ||
			this.bytes + bytes > this.options.maxBytes ||
			this.pendingPackets >= this.options.maxPackets
		) {
			this.fail(
				new Error(this.channel.connected ? "Kernel IPC queue exceeded its limit" : "Kernel IPC disconnected"),
			);
			return Promise.reject(this.failure);
		}
		return new Promise((resolve, reject) => {
			this.bytes += bytes;
			this.waiting.push({ packet, bytes, resolve, reject });
			this.drain();
		});
	}

	close(error = new Error("Kernel IPC closed")): void {
		this.fail(error, false);
	}

	private fail(error: Error, report = true): void {
		if (this.failure) return;
		this.failure = error;
		clearTimeout(this.timer);
		this.inFlight?.reject(error);
		this.inFlight = undefined;
		for (const job of this.waiting.splice(0)) job.reject(error);
		this.bytes = 0;
		if (report) this.onFailure(error);
	}

	/** A live peer may be CPU-starved indefinitely. Time alone is not transport failure. */
	private checkChannel(): void {
		this.timer = setTimeout(() => {
			if (!this.channel.connected) this.fail(new Error("Kernel IPC disconnected"));
			else this.checkChannel();
		}, this.options.timeoutMs);
		this.timer.unref();
	}

	private drain(): void {
		if (this.failure || this.inFlight || !this.waiting.length) return;
		const job = this.waiting.shift()!;
		this.inFlight = job;
		this.checkChannel();
		try {
			// A false return is pressure, not failure. Await the callback before sending the next packet.
			this.channel.send(job.packet, (error) => {
				if (this.inFlight !== job) return;
				if (error) return this.fail(error);
				clearTimeout(this.timer);
				this.inFlight = undefined;
				this.bytes -= job.bytes;
				job.resolve();
				this.drain();
			});
		} catch (error) {
			this.fail(new Error(`Kernel IPC send failed: ${errorText(error)}`));
		}
	}
}

/** Explicit invocation keeps sender tests from installing process handlers or starting a kernel. */
export function runKernelWorker(): void {
	let session: KernelSession | undefined;
	let initialization: Promise<void> | undefined;
	let commands: Promise<void> = Promise.resolve();
	let updateRevision = 0;
	/** Latest context sent while the kernel was still starting. */
	let pendingMission: { context?: MissionContext } | undefined;
	const daemonCalls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
	const workspaceCalls = new Map<string, (workspace?: WorkspaceContext) => void>();
	const prepareWorkspace = () =>
		new Promise<WorkspaceContext | undefined>((resolve) => {
			const callId = randomUUID();
			// Do not time out into a model request while the daemon might still be changing files.
			workspaceCalls.set(callId, resolve);
			void send({ type: "workspace.prepare", callId }).catch(() => {
				workspaceCalls.delete(callId);
				void shutdown(1);
			});
		});
	/** Subagent commands may wait on a child worker; they never block session commands. */
	const subagentCommands = new Set<Promise<void>>();
	let exiting = false;
	const sender = new IpcSender(
		{
			get connected() {
				return !!process.send && process.connected;
			},
			send: (packet, callback) => process.send!(packet, callback),
		},
		(error) => {
			console.error(`pilot: ${error.message}`);
			void shutdown(1);
		},
	);
	const send = (packet: KernelPacket) => sender.send(packet);
	// Notification hooks cannot await. Their retention is still bounded by the same FIFO.
	const notify = (packet: KernelPacket) => void send(packet).catch(() => undefined);
	const callDaemon = <T>(packet: (callId: string) => KernelPacket): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const callId = randomUUID();
			const timer = setTimeout(() => {
				daemonCalls.delete(callId);
				reject(new Error("pilotd did not answer the tool call"));
			}, 60_000);
			timer.unref();
			daemonCalls.set(callId, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			send(packet(callId)).catch((error: unknown) => {
				daemonCalls.get(callId)?.reject(error instanceof Error ? error : new Error(String(error)));
				daemonCalls.delete(callId);
			});
		});
	const callMission: MissionCall = (action, args) =>
		callDaemon<JsonValue>((callId) => ({ type: "mission.call", callId, action, args }));
	const callMemory = (action: "wake" | "note" | "recall" | "zoom", args: Record<string, JsonValue>) =>
		callDaemon<JsonValue>((callId) => ({ type: "memory.call", callId, action, args }));

	async function shutdown(code = 0): Promise<void> {
		if (exiting) return;
		exiting = true;
		const watchdog = setTimeout(() => process.exit(1), 5_000);
		watchdog.unref();
		try {
			await initialization?.catch(() => undefined);
			await commands;
			await Promise.allSettled(subagentCommands);
			await session?.close();
			// The warm artifact preview browser would otherwise outlive a graceful exit until Playwright's exit hook.
			await closePreviewBrowser();
		} catch (error) {
			await send({ type: "error", message: `Shutdown failed: ${errorText(error)}` }).catch(() => undefined);
			code = 1;
		}
		sender.close();
		process.exit(code);
	}

	async function execute(
		command: Exclude<
			KernelCommand,
			{ type: "start" | "shutdown" | "subagent" | "inspectJobs" | "update.pause" | "update.resume" }
		>,
	): Promise<void> {
		await initialization;
		if (!session) throw new Error("Kernel has not started");
		switch (command.type) {
			case "systemMessageState.ack":
				await session.acknowledgeSystemMessageState(command.id);
				break;
			case "sendHeldMessages":
				await session.sendHeldMessages();
				await send({ type: "accepted", requestId: command.requestId });
				break;
			case "discardHeldMessages":
				await session.discardHeldMessages(command.submissionId);
				await send({ type: "accepted", requestId: command.requestId });
				break;
			case "activity":
				await session.recordActivity(command.requestId, command.text);
				await send({ type: "accepted", requestId: command.requestId });
				break;
			case "input": {
				const delivery = await session.submit(
					command.requestId,
					command.content,
					command.mode,
					command.onlyIfIdle,
					command.reportDelivery,
					command.event,
				);
				await send({ type: "accepted", requestId: command.requestId, ...delivery });
				break;
			}
			case "abort": {
				const withdrawn = await session.abort();
				await send({ type: "aborted", requestId: command.requestId, ...(withdrawn.length ? { withdrawn } : {}) });
				break;
			}
			case "rewind":
			case "activateAttempt": {
				const result =
					command.type === "rewind"
						? await session.rewind(command.action, command.entryId)
						: await session.activateAttempt(command.attemptId);
				await send({ type: "rewound", requestId: command.requestId, ...result });
				break;
			}
			case "editQueuedMessage":
				await session.editQueuedMessage(command.submissionId, command.content, command.mode);
				await send({ type: "accepted", requestId: command.requestId });
				break;
			case "changeModel":
				await session.changeModel(command.model, command.thinking);
				await send({
					type: "modelChanged",
					requestId: command.requestId,
					model: session.model,
					thinking: session.thinkingLevel,
					usage: session.usage,
				});
				break;
			case "continuation.pause":
				await session.pauseForUpdate();
				await send({ type: "accepted", requestId: command.requestId });
				break;
			case "removeQueuedMessage":
				await session.removeQueuedMessage(command.submissionId);
				await send({ type: "accepted", requestId: command.requestId });
				break;
			case "compact":
				await session.compact(command.instructions);
				await send({ type: "accepted", requestId: command.requestId });
				break;
			case "inspectChildren":
				await send({ type: "children", requestId: command.requestId, hasChildren: await session.hasChildren() });
				break;
			case "watch":
				await session.watch(
					command.watchId,
					(events) => send({ type: "events", watchId: command.watchId, events }),
					command.includeTodos,
					command.activityOnly,
				);
				break;
			case "unwatch":
				await session.unwatch(command.watchId);
				break;
		}
	}

	process.on("message", (message: unknown) => {
		if (exiting || !message || typeof message !== "object") return;
		const command = message as KernelCommand;
		if (command.type === "shutdown") {
			void shutdown();
			return;
		}
		if (
			command.type === "mission.result" ||
			command.type === "memory.result" ||
			command.type === "artifact.reference.result"
		) {
			const call = daemonCalls.get(command.callId);
			daemonCalls.delete(command.callId);
			if (command.error !== undefined) call?.reject(new Error(command.error));
			else
				call?.resolve(
					command.result ??
						(command.type === "mission.result" || command.type === "memory.result" ? null : undefined),
				);
			return;
		}
		if (command.type === "workspace.prepared") {
			workspaceCalls.get(command.callId)?.(command.workspace);
			workspaceCalls.delete(command.callId);
			return;
		}
		if (command.type === "mission.context") {
			if (session) session.setMission(command.context);
			else pendingMission = { ...(command.context ? { context: command.context } : {}) };
			return;
		}
		if (command.type === "start") {
			if (initialization) return;
			initialization = (async () => {
				// Extensions resolve pi's agent directory from the environment, e.g. for the shared usage cache.
				if (command.spec.agentDir) process.env.PI_CODING_AGENT_DIR = command.spec.agentDir;
				if (command.spec.subscriptionPolicy)
					process.env.PILOT_SUBSCRIPTION_POLICY = command.spec.subscriptionPolicy;
				else delete process.env.PILOT_SUBSCRIPTION_POLICY;
				const opened = await KernelSession.open(command.spec, {
					onSystemMessageState: (event) => {
						void send({ type: "systemMessageState", event });
					},
					onWorking: (working, completion) =>
						notify({ type: "working", working, ...(completion ? { completion } : {}) }),
					onJobsChanged: (jobs) => notify({ type: "jobs.changed", jobs }),
					onTodosChanged: (openCount) => notify({ type: "todos.changed", openCount }),
					onUsageChanged: (usage) => notify({ type: "usage", usage }),
					onArtifactsChanged: () => notify({ type: "artifacts.changed" }),
					onPullRequestCreated: (url) => notify({ type: "pullRequest.created", url }),
					onRefsChanged: () => notify({ type: "refs.changed" }),
					onGitHubAction: (action) => notify({ type: "github.action", action }),
					onSubagentsChanged: (subagents) => notify({ type: "subagents", subagents }),
					callMission,
					callMemory,
					readArtifactReference: (id, revision) =>
						callDaemon((callId) => ({ type: "artifact.reference.get", callId, id, revision })),
					prepareWorkspace,
				});
				if (pendingMission) opened.setMission(pendingMission.context);
				session = opened;
				await send({
					type: "ready",
					model: session.model,
					thinking: session.thinkingLevel,
					working: session.working,
					usage: session.usage,
					openTodoCount: session.openTodoCount,
					...(session.completion ? { completion: session.completion } : {}),
					commands: session.commands,
					...(session.attempts ? { attempts: session.attempts } : {}),
				});
			})();
			void initialization.catch(async (error) => {
				await send({ type: "error", message: `Kernel failed to start: ${errorText(error)}` }).catch(
					() => undefined,
				);
				await shutdown(1);
			});
			return;
		}
		if (command.type === "update.resume") {
			updateRevision++;
			session?.resumeAfterUpdate();
			return;
		}
		if (command.type === "update.pause") {
			const revision = ++updateRevision;
			void (async () => {
				await initialization;
				await commands;
				if (revision !== updateRevision) return;
				if (!session) throw new Error("Kernel has not started");
				await session.pauseForUpdate();
				if (revision === updateRevision) await send({ type: "update.paused", id: command.id });
			})().catch((error) =>
				send({ type: "update.paused", id: command.id, error: errorText(error) }).catch(() => undefined),
			);
			return;
		}
		if (command.type === "inspectJobs") {
			void (async () => {
				await initialization;
				if (!session) throw new Error("Kernel has not started");
				await send({ type: "jobs", requestId: command.requestId, jobs: await session.jobs() });
			})().catch((error) =>
				send({ type: "error", requestId: command.requestId, message: errorText(error) }).catch(() => undefined),
			);
			return;
		}
		if (command.type === "stopJob") {
			void (async () => {
				await initialization;
				if (!session) throw new Error("Kernel has not started");
				await session.stopJob(command.jobId);
				await send({ type: "accepted", requestId: command.requestId });
			})().catch((error) =>
				send({ type: "error", requestId: command.requestId, message: errorText(error) }).catch(() => undefined),
			);
			return;
		}
		if (command.type === "subagent") {
			const running = (async () => {
				await initialization;
				if (!session) throw new Error("Kernel has not started");
				await session.subagentCommand(
					command.action === "send"
						? {
								action: "send",
								name: command.name,
								message: command.message ?? "",
								mode: command.mode,
								requestId: command.requestId,
							}
						: { action: "stop", name: command.name, requestId: command.requestId },
				);
				await send({ type: "accepted", requestId: command.requestId });
			})().catch((error) =>
				send({
					type: "error",
					requestId: command.requestId,
					message: formatFailure(error, "Command subagent"),
				}).catch(() => undefined),
			);
			subagentCommands.add(running);
			void running.finally(() => subagentCommands.delete(running));
			return;
		}
		commands = commands
			.then(() => execute(command))
			.catch((error) =>
				send({
					type: "error",
					requestId: "requestId" in command ? command.requestId : undefined,
					message: formatFailure(error, `Command ${command.type}`),
					...(error instanceof ConversationBusy ? { code: "busy" as const } : {}),
				}).catch(() => undefined),
			);
	});
	process.on("disconnect", () => {
		sender.close(new Error("Kernel IPC disconnected"));
		void shutdown();
	});
	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());
}
