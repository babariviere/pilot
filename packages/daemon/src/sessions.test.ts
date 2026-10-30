// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access tests private supervision seams.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { JsonValue } from "@earendil-works/chord";
import type { KernelCommand, KernelPacket, KernelSubagent, KernelUsage } from "@pilot/kernel";
import type {
	AgentEvent,
	DiagnosticHistoryPage,
	McpStatus,
	SessionCompletion,
	SessionDiagnostics,
	SessionPullRequest,
	SessionState,
	SessionSummary,
	SessionTrackedSource,
} from "@pilot/protocol";
import { WebSocket } from "ws";
import { DATABASE_CONFIG_FILE, DatabaseService } from "./databases.ts";
import { diagnosticContextResponse } from "./diagnostic-context.ts";
import { Conflict, NotFound } from "./errors.ts";
import { DaemonOperations, EventLoopWatchdog, operations } from "./event-loop-watchdog.ts";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import {
	CommandRejected,
	Worker as KernelWorker,
	type SessionFactories,
	SessionManager,
	type SessionManagerOptions,
	type SessionWorker,
	WorkerUnavailable,
} from "./sessions.ts";
import type { SubagentWatchUpdate } from "./subagent-watches.ts";
import type { TerminalManager } from "./terminals.ts";

type Command = Extract<KernelCommand, { type: "input" | "abort" | "pauseInputs" | "resumeInputs" }>;
type Spec = Extract<KernelCommand, { type: "start" }>["spec"];
const diagnosticHost = { hostId: "local", daemonId: "daemon", lineageId: "lineage" } as const;
const diagnosticTarget = (
	sessionId: string,
	host: { hostId: string; daemonId: string; lineageId: string } = diagnosticHost,
) => ({
	host,
	sessionId,
	chatUrl: `pilot://chat/${sessionId}`,
});

class IpcProcess extends EventEmitter {
	connected = true;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly sent: KernelCommand[] = [];
	readonly killed: NodeJS.Signals[] = [];
	send(command: KernelCommand, callback?: (error: Error | null) => void): boolean {
		this.sent.push(command);
		callback?.(null);
		return true;
	}
	kill(signal: NodeJS.Signals): boolean {
		this.killed.push(signal);
		this.connected = false;
		this.signalCode = signal;
		this.emit("exit", null, signal);
		return true;
	}
}

function supervisedWorker(t: TestContext, commandTimeoutMs = 1_000) {
	const child = new IpcProcess();
	const packets: KernelPacket[] = [];
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const worker = new KernelWorker(
		{ sessionId: "supervision", cwd: "/unused", storageDir: "/unused" },
		(packet) => packets.push(packet),
		() => {},
		undefined,
		{ child: child as unknown as ChildProcess, startupTimeoutMs: 1_000, commandTimeoutMs },
	);
	t.after(() => child.emit("exit", 0, null));
	const ready = () => {
		child.emit("message", { type: "ready", model: "test/model", working: false, usage: {} });
		const watch = child.sent.findLast((command) => command.type === "watch");
		assert.ok(watch?.type === "watch");
		child.emit("message", { type: "events", watchId: watch.watchId, events: [snapshot] });
	};
	return { child, worker, ready, packets };
}

test("todo counts arrive on readiness and committed mutations without starting extra work", async (t) => {
	const { child, worker, ready } = supervisedWorker(t);
	ready();
	await worker.ready;
	child.emit("message", { type: "ready", model: "test/model", working: false, usage: {}, openTodoCount: 7 });
	assert.equal(worker.openTodoCount, 7);
	const sent = child.sent.length;
	child.emit("message", { type: "todos.changed", openCount: 6 });
	assert.equal(worker.openTodoCount, 6);
	assert.equal(child.sent.length, sent);
	assert.equal(worker.state, "idle");
});

test("worker acquisition and IPC serialization timings do not capture command content", (t) => {
	const tracker = new DaemonOperations();
	t.mock.method(operations, "time", <T>(label: string | (() => string), run: () => T) => tracker.time(label, run, 0));
	const { worker, ready } = supervisedWorker(t);
	ready();
	worker.send({ type: "input", requestId: "private-request", content: "private-command-content", mode: "followUp" });
	const labels = tracker.snapshot().slowByKind.map((entry) => entry.label);
	assert.ok(labels.includes("worker.acquire"));
	assert.ok(labels.includes("worker.send"));
	assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /private-request|private-command-content|unused/);
});

test("unexpected disconnect still fails an idle worker", async (t) => {
	const { child, worker, ready, packets } = supervisedWorker(t);
	ready();
	child.connected = false;
	child.emit("disconnect");
	assert.equal(worker.state, "failed");
	assert.equal(worker.transportUnavailable, true);
	assert.deepEqual(packets.at(-1), { type: "error", message: "Kernel IPC disconnected" });
	assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("intentional close ignores disconnect but waits for confirmed exit", async (t) => {
	const { child, worker, ready, packets } = supervisedWorker(t);
	ready();
	const send = child.send.bind(child);
	child.send = (command, callback) => {
		if (command.type === "shutdown") {
			child.connected = false;
			child.emit("disconnect");
			callback?.(new Error("IPC channel closed"));
			return true;
		}
		return send(command, callback);
	};
	let closed = false;
	const closing = worker.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	assert.equal(closed, false);
	assert.equal(worker.state, "idle");
	assert.equal(worker.error, undefined);
	assert.equal(worker.transportUnavailable, false);
	assert.ok(packets.every((packet) => packet.type !== "error"));
	assert.deepEqual(child.killed, []);
	t.mock.timers.tick(8_000);
	await closing;
	assert.deepEqual(child.killed, ["SIGKILL"], "close retains its shutdown deadline");
});

test("startup tolerates starvation while the IPC channel and process remain alive", async (t) => {
	const { child, worker, ready } = supervisedWorker(t);
	t.mock.timers.tick(120_000);
	assert.deepEqual(child.killed, []);
	assert.equal(worker.state, "starting");
	assert.equal(worker.busy, true);
	assert.equal(worker.transportUnavailable, false);
	ready();
	await worker.ready;
	t.mock.timers.tick(120_000);
	assert.equal(worker.state, "idle");
	assert.deepEqual(child.killed, []);
});

test("command acknowledgements tolerate starvation without clearing uncertain admissions", async (t) => {
	const { child, worker, ready } = supervisedWorker(t);
	ready();
	await worker.ready;
	const input = worker.request({ type: "input", requestId: "stable-id", content: "work", mode: "followUp" });
	const abort = worker.request({ type: "abort", requestId: "abort-id" });
	t.mock.timers.tick(120_000);
	assert.deepEqual(child.killed, []);
	assert.equal(worker["pending"].size, 2);
	assert.equal(worker.busy, true, "a slow acknowledgement must still block idle-only work");
	child.emit("message", { type: "accepted", requestId: "stable-id" });
	child.emit("message", { type: "aborted", requestId: "abort-id" });
	await Promise.all([input, abort]);
	assert.equal(worker["pending"].size, 0);
});

test("a dead channel rejects readiness and every uncertain command", async (t) => {
	const { child, worker } = supervisedWorker(t);
	const input = worker.request({ type: "input", requestId: "stable-id", content: "work", mode: "followUp" });
	const rejected = Promise.all([
		assert.rejects(worker.ready, WorkerUnavailable),
		assert.rejects(input, WorkerUnavailable),
	]);
	child.connected = false; // Also covered by the periodic check if a disconnect event was missed.
	t.mock.timers.tick(1_000);
	await rejected;
	assert.deepEqual(child.killed, ["SIGTERM"]);
	assert.equal(worker.state, "failed");
	assert.equal(worker["pending"].size, 0);
	assert.equal(worker["killTimer"], undefined);
	child.emit("message", { type: "ready", model: "late/model", working: false, usage: {} });
	assert.equal(worker.state, "failed");
});

test("process exit without a disconnect rejects startup as recoverable transport loss", async (t) => {
	const { child, worker } = supervisedWorker(t);
	const rejected = assert.rejects(worker.ready, WorkerUnavailable);
	child.emit("exit", 1, null);
	await rejected;
	await assert.rejects(worker.request({ type: "abort", requestId: "after-exit" }), WorkerUnavailable);
	t.mock.timers.tick(120_000);
	assert.deepEqual(child.killed, [], "an exited process does not need a kill deadline");
});

test("inspection deadline protects the worker without killing it or clearing unrelated admissions", async (t) => {
	const { child, worker, ready } = supervisedWorker(t, 60_000);
	ready();
	await worker.ready;
	const input = worker.request({ type: "input", requestId: "unrelated", content: "work", mode: "followUp" });
	const children = worker.hasChildren();
	t.mock.timers.tick(10_000);
	assert.equal(await children, true);
	assert.deepEqual(child.killed, []);
	assert.equal(worker["pending"].has("unrelated"), true);
	assert.equal(worker["pending"].size, 1);
	child.emit("message", { type: "accepted", requestId: "unrelated" });
	await input;
	assert.equal(worker["pending"].size, 0);
});

test("jobs reads coalesce, correlate replies and release snapshots without activity updates", async (t) => {
	const { child, worker, ready, packets } = supervisedWorker(t);
	ready();
	await worker.ready;
	const before = packets.length;
	const first = worker.jobs();
	assert.equal(worker.jobs(), first);
	const command = child.sent.find((item) => item.type === "inspectJobs")!;
	assert.ok(command.type === "inspectJobs");
	const jobs = [{ id: "one", name: "Tests", state: "running", startedAt: 1, outputPath: "/tmp/tests.log" }];
	child.emit("message", { type: "jobs", requestId: "unrelated", jobs: [] });
	assert.equal(worker["pending"].has(command.requestId), true);
	child.emit("message", { type: "jobs", requestId: command.requestId, jobs });
	assert.deepEqual(await first, jobs);
	assert.equal(worker["jobResults"].size, 0);
	assert.equal(packets.length, before, "read results never broadcast session updates");
	const second = worker.jobs();
	const next = child.sent.filter((item) => item.type === "inspectJobs").at(-1)!;
	assert.notEqual(next.requestId, command.requestId);
	child.emit("message", { type: "jobs", requestId: next.requestId, jobs: [] });
	assert.deepEqual(await second, []);
});

test("jobs failures and deadlines do not fail or stop the worker, including late errors", async (t) => {
	const { child, worker, ready } = supervisedWorker(t, 60_000);
	ready();
	await worker.ready;
	const read = worker.jobs();
	const command = child.sent.find((item) => item.type === "inspectJobs")!;
	assert.ok(command.type === "inspectJobs");
	const rejected = assert.rejects(read, /timed out/);
	t.mock.timers.tick(10_000);
	await rejected;
	child.emit("message", { type: "error", requestId: command.requestId, message: "Late read error" });
	assert.equal(worker.error, undefined);
	assert.equal(worker.state, "idle");
	assert.deepEqual(child.killed, []);
	const retry = worker.jobs();
	const next = child.sent.filter((item) => item.type === "inspectJobs").at(-1)!;
	const failed = assert.rejects(retry, /Registry unavailable/);
	child.emit("message", { type: "error", requestId: next.requestId, message: "Registry unavailable" });
	await failed;
	assert.equal(worker.error, undefined);
	assert.equal(worker["jobResults"].size, 0);
});

test("job stop commands correlate replies and never fail the worker", async (t) => {
	const { child, worker, ready } = supervisedWorker(t, 60_000);
	ready();
	await worker.ready;
	const stop = worker.stopJob("tests");
	const command = child.sent.find((item) => item.type === "stopJob")!;
	assert.ok(command.type === "stopJob");
	assert.equal(command.jobId, "tests");
	child.emit("message", { type: "accepted", requestId: command.requestId });
	await stop;
	const missing = assert.rejects(worker.stopJob("gone"), /No running job gone/);
	const next = child.sent.filter((item) => item.type === "stopJob").at(-1)!;
	child.emit("message", { type: "error", requestId: next.requestId, message: "No running job gone" });
	await missing;
	const slow = assert.rejects(worker.stopJob("slow"), /timed out/);
	t.mock.timers.tick(10_000);
	await slow;
	assert.equal(worker.error, undefined, "a job command never becomes the session's error");
	assert.equal(worker.state, "idle");
	assert.deepEqual(child.killed, []);
});

test("transport retirement sends SIGTERM first, escalates once after eight seconds, and waits for confirmed exit", async (t) => {
	const { child, worker } = supervisedWorker(t);
	child.kill = (signal) => {
		child.killed.push(signal);
		return true;
	};
	const rejected = assert.rejects(worker.ready, WorkerUnavailable);
	child.connected = false;
	child.emit("disconnect");
	await rejected;
	assert.deepEqual(child.killed, ["SIGTERM"]);
	let closed = false;
	const closing = worker.close().then(() => {
		closed = true;
	});
	t.mock.timers.tick(7_999);
	assert.deepEqual(child.killed, ["SIGTERM"]);
	t.mock.timers.tick(1);
	assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
	await Promise.resolve();
	assert.equal(closed, false, "sending SIGKILL is not proof that the writer lease has been released");
	child.emit("exit", null, "SIGKILL");
	await closing;
	assert.equal(worker["killTimer"], undefined);
	t.mock.timers.tick(10_000);
	assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"], "retirement has only one shared fallback timer");
});

test("acknowledged commands cancel their deadline and idle-child inspection does not reset activity", async (t) => {
	const { child, worker, ready } = supervisedWorker(t);
	ready();
	const inspection = worker.hasChildren();
	const command = child.sent.at(-1)!;
	assert.equal(command.type, "inspectChildren");
	assert.ok("requestId" in command);
	child.emit("message", { type: "children", requestId: command.requestId, hasChildren: false });
	assert.equal(await inspection, false);
	t.mock.timers.tick(5_000);
	assert.deepEqual(child.killed, []);
	assert.equal(worker.busy, false);
});

test("automatic idle-guard rejection does not leave a visible worker error", async (t) => {
	const { child, worker, ready } = supervisedWorker(t);
	ready();
	const input = worker.request({
		type: "input",
		requestId: "automatic",
		content: "Check the PR",
		mode: "followUp",
		onlyIfIdle: true,
	});
	const rejected = assert.rejects(input, CommandRejected);
	child.emit("message", { type: "error", requestId: "automatic", message: "Conversation is busy", code: "busy" });
	await rejected;
	assert.equal(worker.error, undefined);
	assert.equal(worker.state, "idle");
	assert.equal(worker.busy, false);
	// Ordinary rejected user commands still expose their error.
	const user = worker.request({ type: "input", requestId: "user", content: "User work", mode: "followUp" });
	const userRejected = assert.rejects(user, CommandRejected);
	child.emit("message", { type: "error", requestId: "user", message: "User input failed", code: "busy" });
	await userRejected;
	assert.equal(worker.error, "User input failed");
});
function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

for (const phase of ["startup", "ack"] as const) {
	for (const recovery of ["demand", "automatic"] as const) {
		test(`${phase} disconnect retains durable IDs and ${recovery} recovery waits for exit without duplicates`, async (t) => {
			const f = await fixture(t);
			t.mock.timers.enable({ apis: ["setTimeout"] });
			let attempts = 0;
			let executions = 0;
			const committed = new Set<string>();
			const blocked = deferred();
			let firstChild!: IpcProcess;
			const sessions = await f.manager(
				{
					worker: (spec, onPacket, onExit) => {
						const attempt = ++attempts;
						const child = new IpcProcess();
						if (attempt === 1) {
							firstChild = child;
							// Model the gap between SIGTERM and OS-confirmed exit/storage lease release.
							child.kill = (signal) => {
								child.killed.push(signal);
								return true;
							};
						}
						const send = child.send.bind(child);
						child.send = (command, callback) => {
							const result = send(command, callback);
							queueMicrotask(() => {
								if (command.type === "start") {
									if (attempt === 1 && phase === "startup") {
										blocked.resolve();
										return;
									}
									child.emit("message", { type: "ready", model: "test/model", working: false, usage: {} });
								} else if (command.type === "watch") {
									child.emit("message", { type: "events", watchId: command.watchId, events: [snapshot] });
								} else if (command.type === "input") {
									if (!committed.has(command.requestId)) {
										committed.add(command.requestId);
										executions++;
									}
									if (attempt === 1) {
										blocked.resolve();
										return;
									}
									child.emit("message", { type: "accepted", requestId: command.requestId });
								} else if (command.type === "shutdown") child.emit("exit", 0, null);
							});
							return result;
						};
						return new KernelWorker(spec, onPacket, onExit, undefined, {
							child: child as unknown as ChildProcess,
							startupTimeoutMs: 1_000,
							commandTimeoutMs: 1_000,
						});
					},
				},
				{ idleParkMs: Number.POSITIVE_INFINITY },
			);
			const created = await sessions.spawn({ cwd: f.source, message: "durable work" });
			await blocked.promise;
			const drain = sessions["starting"].get(created.id)!;
			const original = (await f.stored(created.id)).pending[0]!;
			t.mock.timers.tick(120_000);
			assert.deepEqual(firstChild.killed, [], "a slow live writer retains its storage lease");
			assert.equal(attempts, 1);
			firstChild.connected = false;
			firstChild.emit("disconnect");
			await drain;
			assert.deepEqual(firstChild.killed, ["SIGTERM"]);
			const timedOut = await f.stored(created.id);
			assert.equal(timedOut.failure, undefined, "transport failures must not permanently disable recovery");
			assert.deepEqual(timedOut.pending, [original], "uncertain admission preserves ID and payload");
			assert.match(timedOut.inputError!, /disconnected/);
			const resuming =
				recovery === "automatic"
					? Promise.resolve()
					: sessions.send(created.id, "retry payload must not replace original", "followUp", original.requestId);
			await Promise.resolve();
			assert.equal(attempts, 1, "a replacement cannot open while the old process still owns storage");
			firstChild.connected = false;
			firstChild.emit("exit", null, "SIGTERM");
			if (recovery === "automatic") t.mock.timers.tick(20_000);
			await resuming;
			await until(() => attempts === 2);
			await sessions["starting"].get(created.id);
			assert.equal(attempts, 2);
			assert.equal(executions, 1, "a lost acknowledgement retries the durable ID, not a new input");
			assert.deepEqual((await f.stored(created.id)).pending, []);
		});
	}
}

async function waitFor(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	let abort!: () => void;
	const interrupted = new Promise<void>((_resolve, reject) => {
		abort = () => reject(new Error("preparation aborted"));
		signal?.addEventListener("abort", abort, { once: true });
	});
	try {
		await Promise.race([promise, interrupted]);
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
const snapshot: AgentEvent = {
	type: "snapshot",
	entries: [],
	tools: [],
	nestedTools: [],
	compactions: [],
	inbox: [],
	agent: {},
	usage: { models: {}, tools: {} },
};

class FakeWorker implements SessionWorker {
	readonly gate = deferred();
	readonly ready = this.gate.promise;
	state: SessionState = "starting";
	usage?: KernelUsage;
	error?: string;
	readonly sent: KernelCommand[] = [];
	readonly requests: Command[] = [];
	readonly subagentRequests: Extract<KernelCommand, { type: "subagent" }>[] = [];
	children = false;
	closed = false;
	closeGate?: Promise<void>;

	get busy(): boolean {
		return this.state === "starting" || this.state === "working";
	}

	readonly spec: Spec;
	private readonly onPacket: (packet: KernelPacket) => void;
	private readonly onExit: (worker: SessionWorker, code: number | null) => void;
	private readonly admit: (command: Command) => Promise<void>;

	constructor(
		spec: Spec,
		onPacket: (packet: KernelPacket) => void,
		onExit: (worker: SessionWorker, code: number | null) => void,
		admit: (command: Command) => Promise<void> = async () => {},
	) {
		this.spec = spec;
		this.onPacket = onPacket;
		this.onExit = onExit;
		this.admit = admit;
		this.ready.catch(() => undefined);
	}

	open(): void {
		this.state = "idle";
		this.onPacket({ type: "ready", model: "test/model", working: false, usage: this.usage ?? {} });
		this.gate.resolve();
	}

	reportUsage(usage: KernelUsage): void {
		this.usage = usage;
		this.onPacket({ type: "usage", usage });
	}

	reportSubagents(subagents: KernelSubagent[]): void {
		this.onPacket({ type: "subagents", subagents });
	}

	publishRepairProposal(
		callId: string,
		proposal: Extract<KernelPacket, { type: "diagnostics.proposal" }>["proposal"],
	): void {
		this.onPacket({ type: "diagnostics.proposal", callId, proposal });
	}

	readDiagnosticLogs(
		callId: string,
		request: Extract<KernelPacket, { type: "diagnostics.logs.call" }>["request"],
	): void {
		this.onPacket({ type: "diagnostics.logs.call", callId, request });
	}

	finish(completion?: SessionCompletion): void {
		this.state = "idle";
		this.onPacket({ type: "working", working: false, ...(completion ? { completion } : {}) });
	}

	send(command: KernelCommand): void {
		this.sent.push(command);
		if (command.type === "watch") this.onPacket({ type: "events", watchId: command.watchId, events: [snapshot] });
	}

	async request(command: Command | Extract<KernelCommand, { type: "subagent" }>): Promise<void> {
		if (command.type === "subagent") {
			this.subagentRequests.push(command);
			return;
		}
		this.requests.push(command);
		await this.admit(command);
		this.state = command.type === "input" ? "working" : "idle";
		this.onPacket({ type: "working", working: this.state === "working" });
	}

	async hasChildren(): Promise<boolean> {
		return this.children;
	}

	async jobs() {
		return [{ id: "tests", name: "Tests", state: "running" as const, startedAt: 1, outputPath: "/tmp/tests.log" }];
	}

	readonly stoppedJobs: string[] = [];
	async stopJob(jobId: string) {
		this.stoppedJobs.push(jobId);
		if (jobId === "ended") throw new CommandRejected("No running job ended");
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.closeGate;
		this.gate.reject(new Error("closed"));
		this.onExit(this, 0);
	}

	crash(): void {
		this.state = "failed";
		this.error = "IPC connection failed";
		this.gate.reject(new Error(this.error));
		this.onExit(this, 1);
	}
}

for (const phase of ["clone", "ready", "ack"] as const) {
	test(`update refuses background ${phase} after spawn returns, then allows settled idle`, async (t) => {
		const f = await fixture(t);
		const gate = deferred();
		const sessions = await f.manager({
			worker: f.workerFactory(phase !== "ready", async () => {
				if (phase === "ack") await gate.promise;
			}),
			workspace: async (_source, path, _runner, signal) => {
				if (phase === "clone") await waitFor(gate.promise, signal);
				return { path, base: "HEAD", jj: false };
			},
		});
		const created = await sessions.spawn({ projectId: f.project.id, message: "admitted" });
		if (phase !== "clone") await until(() => f.workers.length === 1);
		if (phase === "ack") await until(() => f.workers[0]!.requests.length === 1);
		assert.deepEqual(sessions.prepareUpdate(), { ready: false });
		// Refused preparations must not pause additional already-admitted startup input.
		await sessions.send(created.id, "queued", "followUp", "queued-id");
		gate.resolve();
		if (phase === "ready") f.workers[0]!.open();
		await until(() => sessions.get(created.id)?.state === "working");
		assert.deepEqual(sessions.prepareUpdate(), { ready: false });
		const stopping = sessions.stop(created.id);
		assert.deepEqual(sessions.prepareUpdate(), { ready: false });
		await stopping;
		const settled = await f.stored(created.id);
		assert.deepEqual(settled.pending, []);
		assert.equal(settled.initializing, undefined);
		assert.equal(sessions.get(created.id)?.state, "idle");
		// Idle workers can still have background metadata writes; the lease waits for those too.
		await until(() => sessions.prepareUpdate().ready);
		assert.deepEqual(sessions.prepareUpdate(), { ready: true });
		// Watching a live idle worker is permitted, without reopening or admitting input.
		const off = sessions.subscribe(created.id, () => {});
		off();
		await assert.rejects(sessions.send(created.id, "blocked"), /preparing for an update/);
		assert.equal(f.workers.length, 1);
	});
}

for (const phase of ["clone", "factory", "ready"] as const) {
	test(`terminal ${phase} failure does not hold the update lease forever`, async (t) => {
		const f = await fixture(t);
		const sessions = await f.manager({
			workspace: async (_source, path) => {
				if (phase === "clone") throw new Error("terminal clone failure");
				return { path, base: "HEAD", jj: false };
			},
			worker:
				phase === "factory"
					? () => {
							throw new Error("terminal factory failure");
						}
					: f.workerFactory(false),
		});
		const created = await sessions.spawn({ projectId: f.project.id, message: "unrunnable" });
		if (phase === "ready") {
			await until(() => f.workers.length === 1);
			// Model the real Worker's initialization error packet, which marks it failed.
			f.workers[0]!.state = "failed";
			f.workers[0]!.gate.reject(new Error("terminal ready failure"));
		}
		await until(() => sessions.get(created.id)?.state === "failed");
		await until(() => sessions.prepareUpdate().ready);
		assert.equal((await f.stored(created.id)).pending.length, 1);
		const before = f.workers.length;
		sessions.subscribe(created.id, () => {});
		assert.equal(f.workers.length, before);
	});
}

test("uncertain durable admission stays busy after an idle drain has settled", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({
		worker: f.workerFactory(true, async () => {
			throw new Error("lost acknowledgement");
		}),
	});
	const created = await sessions.spawn({ cwd: f.source, message: "uncertain" });
	await until(() => sessions.get(created.id)?.state === "failed");
	assert.equal(f.workers[0]!.busy, false);
	assert.equal((await f.stored(created.id)).pending.length, 1);
	assert.deepEqual(sessions.prepareUpdate(), { ready: false });
	await f.workers[0]!.close();
	assert.deepEqual(sessions.prepareUpdate(), { ready: false });
});

test("a new execution drain is busy even during a reentrant idle worker factory notification", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "initial" });
	await until(() => sessions.get(created.id)?.state === "working");
	await sessions.stop(created.id);
	await f.workers[0]!.close();
	const attempts: boolean[] = [];
	sessions.onChange(() => attempts.push(sessions.prepareUpdate().ready));
	const off = sessions.subscribe(created.id, () => {});
	const sending = sessions.send(created.id, "resume with new work");
	assert.deepEqual(sessions.prepareUpdate(), { ready: false });
	await sending;
	await sessions.stop(created.id);
	await until(() => sessions.get(created.id)?.state === "idle");
	await until(() => sessions.prepareUpdate().ready);
	assert.ok(attempts.length > 0);
	assert.ok(attempts.every((ready) => !ready));
	off();
});

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = performance.now() + 3_000;
	while (!(await check())) {
		assert.ok(performance.now() < deadline, "condition did not settle");
		await delay(1);
	}
}

test("latest user submission is exposed and persists independently of worker and PR updates", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "initial task" });
	assert.equal(created.lastUserMessageAt, created.createdAt);
	await until(() => sessions.get(created.id)?.state === "working");
	await sessions.stop(created.id);
	assert.equal(sessions.get(created.id)?.lastUserMessageAt, created.createdAt);
	await delay(2);
	await sessions.send(created.id, "follow-up", "followUp", "follow-up-id");
	const userAt = sessions.get(created.id)!.lastUserMessageAt!;
	assert.ok(userAt > created.createdAt);
	await sessions.stop(created.id);
	const meta = sessions["metas"].get(created.id)!;
	await sessions["applyPullRequest"](meta, {
		pullRequest: {
			number: 1,
			url: "https://github.com/a/b/pull/1",
			title: "PR",
			state: "closed",
			checkedAt: Date.now(),
		},
	});
	assert.equal(sessions.get(created.id)?.lastUserMessageAt, userAt);
	assert.equal((await f.stored(created.id)).lastUserMessageAt, userAt);
	await sessions.shutdown();
	const reopened = await f.manager();
	assert.equal(reopened.get(created.id)?.lastUserMessageAt, userAt);
});

test("PR observers receive persisted full chat heads and startup baselines, never streaming summaries", async (t) => {
	const f = await fixture(t);
	const releaseInspection = deferred();
	const inspectionStarted = deferred();
	let holdInspection = false;
	const commands: { file: string; args: string[]; cwd: string }[] = [];
	const runner: NonNullable<ConstructorParameters<typeof SessionManager>[4]>["runner"] = async (file, args, cwd) => {
		commands.push({ file, args, cwd });
		if (holdInspection) {
			inspectionStarted.resolve();
			await releaseInspection.promise;
		}
		throw new Error("Synthetic observer fixture has no Git origin");
	};
	// Bound PRs make the background scheduler eligible, even with a fake kernel. Never let
	// this observer/persistence test launch a real Git/gh subprocess that shutdown must drain.
	const sessions = await f.manager({}, {}, { runner });
	const created = await sessions.spawn({ cwd: f.source, message: "sample" });
	await until(() => sessions.get(created.id)?.state === "working");
	await sessions.stop(created.id);
	const meta = sessions["metas"].get(created.id)!;
	meta.projectId = f.project.id;
	const observed: import("./tracked-items-disk.ts").SlackPullRequestObservation[] = [];
	sessions.setPullRequestObserver(async (observation) => {
		assert.equal((await f.stored(created.id)).pullRequest?.state, observation.prs[0]?.state);
		observed.push(observation);
	});
	const pr: SessionPullRequest = {
		number: 42,
		url: "https://github.com/example/sample/pull/42",
		title: "Sample",
		state: "open",
		checkedAt: 10,
	};
	const earlier: SessionPullRequest = { ...pr, number: 41, url: "https://github.com/example/sample/pull/41" };
	meta.agentPullRequests = [pr.url, earlier.url];
	await sessions["applyPullRequest"](meta, { pullRequest: pr, others: [earlier] });
	assert.equal(observed.length, 1);
	assert.equal(observed[0]?.prs.length, 2);
	for (let i = 0; i < 100; i++) sessions["emit"](meta);
	assert.equal(observed.length, 1, "streaming/activity updates do not query tracking storage");
	meta.boundPullRequests = [pr.url, earlier.url, "https://github.com/example/sample/pull/43"];
	await sessions["applyPullRequest"](meta, { pullRequest: { ...pr, state: "merged", checkedAt: 20 } });
	assert.equal(observed.at(-1)?.pending, true);
	assert.equal(observed.at(-1)?.prs.find((head) => head.number === 41)?.state, "open");
	await sessions.shutdown();
	holdInspection = true;
	const reopened = new SessionManager(
		f.home,
		f.projects,
		undefined,
		{ worker: f.workerFactory(), title: async () => undefined },
		{ runner },
	);
	t.after(() => reopened.shutdown());
	const recovered: typeof observed = [];
	const baselineStarted = deferred();
	const releaseBaseline = deferred();
	reopened.setPullRequestObserver(async (observation) => {
		recovered.push(observation);
		baselineStarted.resolve();
		await releaseBaseline.promise;
	});
	try {
		const loading = reopened.load();
		await baselineStarted.promise;
		assert.deepEqual(commands, [], "startup baselines do not need Git or GitHub");
		assert.equal(reopened["pullRequests"]["started"], false, "baseline delivery precedes the scheduler");
		releaseBaseline.resolve();
		await loading;
		// Exercise the formerly timing-dependent overlap: startup baseline publication must
		// finish before background inspection, and shutdown owns the in-flight inspection.
		await inspectionStarted.promise;
		assert.equal(recovered[0]?.prs.find((head) => head.number === 42)?.state, "merged");
		assert.equal(recovered[0]?.pending, true);
		let closed = false;
		const closing = reopened.shutdown().then(() => {
			closed = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(closed, false, "shutdown must drain the owned background inspection");
		releaseInspection.resolve();
		await closing;
		assert.equal(closed, true);
		assert.equal(recovered.length, 1, "draining inspection cannot replace the persisted startup baseline");
		assert.ok(commands.length > 0);
		for (const command of commands)
			assert.deepEqual(command, { file: "git", args: ["remote", "get-url", "origin"], cwd: f.source });
	} finally {
		releaseBaseline.resolve();
		releaseInspection.resolve();
	}
});

test("title waits for a completed turn, uses the thread and generates only once", async (t) => {
	const f = await fixture(t);
	const gate = deferred();
	const task = "Please fix the branch naming and describe the result";
	let calls = 0;
	const sessions = await f.manager({
		historyRead: async () => ({
			entries: [
				{ id: 1, kind: "pi.user", model: [{ role: "user", content: task }] },
				{ id: 2, kind: "pi.user", model: [{ role: "user", content: "Use conventional prefixes" }] },
				{
					id: 3,
					kind: "pi.message",
					model: [{ role: "assistant", content: [{ type: "text", text: "Fixed branch naming" }] }],
				},
			] as never,
			more: false,
		}),
		title: async (cwd, message, signal) => {
			calls++;
			assert.equal(cwd, f.source);
			assert.ok(message.includes(task));
			assert.ok(message.includes("user: Use conventional prefixes"));
			assert.ok(message.includes("assistant: Fixed branch naming"));
			assert.equal(signal.aborted, false);
			await gate.promise;
			return "Fix branch naming";
		},
	});
	const titles: string[] = [];
	sessions.onChange((summary) => titles.push(summary.title));
	const created = await sessions.spawn({ cwd: f.source, message: task });
	assert.equal(created.title, task);
	await until(() => sessions.get(created.id)?.state === "working");
	assert.equal(sessions.get(created.id)?.title, task);
	assert.equal(calls, 0, "startup and active work do not start title generation");
	f.workers[0]!.finish();
	await Promise.resolve();
	assert.equal(calls, 0, "an idle transition without a completion is not a finished turn");
	f.workers[0]!.finish({ outcome: "done", outcomeAt: 100 });
	await until(() => calls === 1);
	f.workers[0]!.finish({ outcome: "done", outcomeAt: 100 });
	gate.resolve();
	await until(() => sessions.get(created.id)?.title === "Fix branch naming");
	await until(async () => (await f.stored(created.id)).title === "Fix branch naming");
	assert.ok(titles.includes("Fix branch naming"));
	assert.equal((await f.stored(created.id)).titlePending, undefined);
	f.workers[0]!.finish({ outcome: "done", outcomeAt: 200 });
	await Promise.resolve();
	assert.equal(calls, 1, "replayed completions and later turns do not retitle");
});

test("a manual diagnostic rename wins over a late reason-seeded title without mutating its devbox target", async (t) => {
	const f = await fixture(t);
	const reason = "Why does Pilot freeze after reconnecting?";
	let context = "";
	const started = deferred();
	const titleGate = deferred();
	const sessions = await f.manager(
		{
			historyRead: async () => ({
				entries: [
					{ id: 1, kind: "pi.user", model: [{ role: "user", content: reason }] },
					{
						id: 2,
						kind: "pi.assistant",
						model: [{ role: "assistant", content: [{ type: "text", text: "The reconnect loop is bounded." }] }],
					},
				] as never,
				more: false,
			}),
			title: async (_cwd, value) => {
				context = value;
				started.resolve();
				await titleGate.promise;
				return "Reconnect freeze investigation";
			},
		},
		{ diagnosticHost },
	);
	const target = await sessions.spawn({ cwd: f.source, message: "Target", title: "Linked target" });
	await until(() => f.workers.find((worker) => worker.spec.sessionId === target.id)?.state === "working");
	f.workers.find((worker) => worker.spec.sessionId === target.id)!.finish({ outcome: "done", outcomeAt: 50 });
	await until(() => sessions.get(target.id)?.outcomeAt === 50);
	const targetBefore = sessions.get(target.id)!;
	const reference = diagnosticTarget(target.id, { ...diagnosticHost, hostId: "remote-box" });
	const specialist = await sessions.spawn({
		message: reason,
		role: "diagnostics",
		diagnosticTarget: reference,
	});
	assert.equal(specialist.title, reason, "the readable fallback comes from the submitted reason");
	await until(() => f.workers.find((worker) => worker.spec.sessionId === specialist.id)?.state === "working");
	f.workers.find((worker) => worker.spec.sessionId === specialist.id)!.finish({ outcome: "done", outcomeAt: 100 });
	await started.promise;
	assert.match(context, /Opening request: Why does Pilot freeze after reconnecting\?/);
	assert.doesNotMatch(context, /Inspect Pilot using|Diagnose your admitted target/);
	await sessions.rename(specialist.id, "Reconnect notes");
	titleGate.resolve();
	await until(() => sessions["titleTasks"].size === 0);
	assert.equal(sessions.get(specialist.id)?.title, "Reconnect notes", "a late provider response cannot undo a rename");
	assert.equal((await f.stored(specialist.id)).titlePending, undefined);
	assert.equal(sessions.get(specialist.id)?.role, "diagnostics", "the specialist badge remains role-driven");
	assert.deepEqual(
		sessions.get(target.id),
		targetBefore,
		"title generation cannot rename or update the linked target",
	);
	await sessions["lifecycle"].flush();
	const lifecycle = await readFile(join(f.home, "sessions", specialist.id, "lifecycle.jsonl"), "utf8");
	assert.doesNotMatch(lifecycle, /Why does Pilot|Reconnect notes|Reconnect freeze investigation/);
});

test("reasonless diagnostic titles wait across reopen for the first substantive reply", async (t) => {
	const f = await fixture(t);
	const boilerplate =
		"Inspect Pilot using bounded operational evidence for your admitted target. Cite evidence references.";
	let includeReply = false;
	let calls = 0;
	let context = "";
	const factories: SessionFactories = {
		historyRead: async () => ({
			entries: [
				{ id: 1, kind: "pi.user", model: [{ role: "user", content: boilerplate }] },
				{
					id: 2,
					kind: "pi.tool-result",
					model: [{ role: "toolResult", content: [{ type: "text", text: "private tool output" }] }],
				},
				...(includeReply
					? [
							{
								id: 3,
								kind: "pi.assistant",
								model: [
									{ role: "assistant", content: [{ type: "text", text: "Reconnect loops after sleep" }] },
								],
							},
						]
					: []),
			] as never,
			more: false,
		}),
		title: async (_cwd, value) => {
			calls++;
			context = value;
			return "Reconnect loop after sleep";
		},
	};
	const sessions = await f.manager(factories, { diagnosticHost });
	const target = await sessions.spawn({ cwd: f.source, message: "Target", title: "Linked target" });
	await until(() => f.workers.find((worker) => worker.spec.sessionId === target.id)?.state === "working");
	f.workers.find((worker) => worker.spec.sessionId === target.id)!.finish({ outcome: "done", outcomeAt: 50 });
	const specialist = await sessions.spawn({
		message: boilerplate,
		role: "diagnostics",
		diagnosticTarget: diagnosticTarget(target.id, { ...diagnosticHost, hostId: "remote-box" }),
		diagnosticTitleFromReply: true,
	});
	assert.equal(specialist.title, "Pilot diagnostics");
	await until(() => f.workers.find((worker) => worker.spec.sessionId === specialist.id)?.state === "working");
	f.workers.find((worker) => worker.spec.sessionId === specialist.id)!.finish({ outcome: "done", outcomeAt: 100 });
	await until(
		() =>
			sessions["titleTasks"].size === 0 &&
			sessions["metas"].get(specialist.id)?.titlePending?.attemptedCompletionAt === 100 &&
			!sessions["metas"].get(specialist.id)?.titlePending?.ready,
	);
	assert.equal(calls, 0, "tool-only history does not call the title model");
	assert.equal(sessions.get(specialist.id)?.title, "Pilot diagnostics");

	await sessions.shutdown();
	includeReply = true;
	const reopened = await f.manager(factories, { diagnosticHost });
	await Promise.resolve();
	assert.equal(calls, 0, "reopen does not repeat the already-inspected completion");
	assert.equal(reopened.get(specialist.id)?.title, "Pilot diagnostics");
	await reopened.send(specialist.id, "Continue the diagnosis");
	await until(() => f.workers.findLast((worker) => worker.spec.sessionId === specialist.id)?.state === "working");
	f.workers.findLast((worker) => worker.spec.sessionId === specialist.id)!.finish({ outcome: "done", outcomeAt: 200 });
	await until(() => reopened.get(specialist.id)?.title === "Reconnect loop after sleep");
	await until(async () => (await f.stored(specialist.id)).titlePending === undefined);
	assert.equal(calls, 1);
	assert.match(context, /assistant: Reconnect loops after sleep/);
	assert.doesNotMatch(context, /Inspect Pilot using|private tool output|Opening request/);
	assert.equal(reopened.get(target.id)?.title, "Linked target");
	f.workers.findLast((worker) => worker.spec.sessionId === specialist.id)!.finish({ outcome: "done", outcomeAt: 300 });
	await Promise.resolve();
	assert.equal(calls, 1, "later replies do not retitle the specialist");
});

test("stack-only PR updates publish, persist and leave chat activity unchanged", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "initial" });
	await until(() => sessions.get(created.id)?.state === "working");
	await sessions.stop(created.id);
	const meta = sessions["metas"].get(created.id)!;
	const pr = {
		number: 1,
		url: "https://github.com/a/b/pull/1",
		title: "PR",
		state: "open" as const,
		checkedAt: Date.now(),
	};
	meta.agentPullRequests = [pr.url];
	await sessions["applyPullRequest"](meta, { pullRequest: pr });
	const activity = sessions.get(created.id)!.updatedAt;
	let changes = 0;
	const off = sessions.onChange(() => changes++);
	const stack = { number: 9, position: 2, size: 3, baseBranch: "main" };
	await sessions["applyPullRequest"](meta, { pullRequest: { ...pr, stack } });
	assert.equal(changes, 1);
	assert.deepEqual(sessions.get(created.id)?.pullRequest?.stack, stack);
	assert.deepEqual((await f.stored(created.id)).pullRequest?.stack, stack);
	assert.equal(sessions.get(created.id)?.updatedAt, activity);
	await sessions["applyPullRequest"](meta, { pullRequest: pr });
	assert.equal(changes, 2);
	assert.equal(sessions.get(created.id)?.pullRequest?.stack, undefined);
	off();
});

test("explicit titles bypass generation and provider failures keep the fallback", async (t) => {
	const f = await fixture(t);
	let calls = 0;
	const sessions = await f.manager(
		{
			title: async () => {
				calls++;
				throw new Error("unavailable");
			},
		},
		{ diagnosticHost },
	);
	const explicit = await sessions.spawn({ cwd: f.source, message: "task", title: " My title " });
	assert.equal(explicit.title, "My title");
	assert.equal(calls, 0);
	const fallback = await sessions.spawn({ cwd: f.source, message: "Fallback task\nDetails" });
	await until(() => f.workers.length === 2 && f.workers[1]!.state === "working");
	f.workers[0]!.finish({ outcome: "done", outcomeAt: 100 });
	f.workers[1]!.finish({ outcome: "question", outcomeAt: 100 });
	await until(async () => (await f.stored(fallback.id)).titlePending === undefined);
	assert.equal(calls, 1);
	assert.equal(sessions.get(fallback.id)?.title, "Fallback task");
	assert.equal(sessions.get(explicit.id)?.title, "My title");
	const target = await sessions.spawn({ cwd: f.source, message: "Target", title: "Linked target" });
	const diagnosticFallback = await sessions.spawn({
		message: "Why did reconnect fail?",
		role: "diagnostics",
		diagnosticTarget: diagnosticTarget(target.id),
	});
	await until(
		() =>
			f.workers.find((worker) => worker.spec.sessionId === target.id)?.state === "working" &&
			f.workers.find((worker) => worker.spec.sessionId === diagnosticFallback.id)?.state === "working",
	);
	f.workers.find((worker) => worker.spec.sessionId === target.id)!.finish({ outcome: "done", outcomeAt: 150 });
	f.workers
		.find((worker) => worker.spec.sessionId === diagnosticFallback.id)!
		.finish({ outcome: "done", outcomeAt: 150 });
	await until(async () => (await f.stored(diagnosticFallback.id)).titlePending === undefined);
	assert.equal(calls, 2);
	assert.equal(sessions.get(diagnosticFallback.id)?.title, "Why did reconnect fail?");
	assert.equal(sessions.get(target.id)?.title, "Linked target");
});

for (const pending of [{ titlePending: { ready: true } }, { lastCompletionAt: 100, titlePending: {} }])
	test("completed pending titles resume on load without waking an idle kernel", async (t) => {
		const f = await fixture(t);
		const id = randomUUID();
		await mkdir(join(f.home, "sessions", id), { recursive: true });
		await writeFile(
			join(f.home, "sessions", id, "meta.json"),
			JSON.stringify({
				id,
				cwd: f.source,
				title: "Fallback",
				createdAt: 1,
				updatedAt: 1,
				...pending,
				titlePending: { ...pending.titlePending, cwd: f.source, message: "Task details" },
			}),
		);
		const sessions = await f.manager({
			title: async (cwd, message) => {
				assert.equal(cwd, f.source);
				assert.ok(message.includes("Task details"));
				return "Recovered title";
			},
		});
		await until(async () => (await f.stored(id)).titlePending === undefined);
		assert.equal(sessions.get(id)?.title, "Recovered title");
		assert.equal(f.workers.length, 0);
	});

test("restart keeps uncompleted titles pending and a manual rename prevents later generation", async (t) => {
	const f = await fixture(t);
	const id = randomUUID();
	await mkdir(join(f.home, "sessions", id), { recursive: true });
	await writeFile(
		join(f.home, "sessions", id, "meta.json"),
		JSON.stringify({
			id,
			cwd: f.source,
			title: "Fallback",
			createdAt: 1,
			updatedAt: 1,
			titlePending: { cwd: f.source, message: "Task details" },
		}),
	);
	let calls = 0;
	const sessions = await f.manager({
		title: async () => {
			calls++;
			return "Should not be used";
		},
	});
	assert.equal(calls, 0);
	assert.equal(sessions["titleTasks"].size, 0);
	assert.equal(f.workers.length, 0);
	assert.ok((await f.stored(id)).titlePending);
	await sessions.send(id, "Continue");
	await until(() => f.workers[0]?.state === "working");
	assert.equal(calls, 0, "opening and starting a turn still do not generate a title");
	await sessions.rename(id, "My chosen title");
	f.workers[0]!.finish({ outcome: "done", outcomeAt: 100 });
	assert.equal(calls, 0);
	assert.equal(sessions.get(id)?.title, "My chosen title");
});

test("shutdown aborts title generation and leaves a durable retry", async (t) => {
	const f = await fixture(t);
	let started = false;
	const sessions = await f.manager({
		title: async (_cwd, _message, signal) => {
			started = true;
			await waitFor(new Promise<void>(() => {}), signal);
			return "Should not be written";
		},
	});
	const created = await sessions.spawn({ cwd: f.source, message: "Fallback" });
	await until(() => f.workers[0]?.state === "working");
	f.workers[0]!.finish({ outcome: "done", outcomeAt: 100 });
	await until(() => started);
	await sessions.shutdown();
	assert.equal(sessions.get(created.id)?.title, "Fallback");
	assert.ok((await f.stored(created.id)).titlePending);
});

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-startup-"));
	const home = join(root, "home");
	const source = join(root, "source");
	await mkdir(source);
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: source, model: "test/preferred" });
	const workers: FakeWorker[] = [];
	const managers: SessionManager[] = [];
	const workerFactory =
		(autoReady = true, admit?: (command: Command) => Promise<void>): SessionFactories["worker"] =>
		(spec, onPacket, onExit) => {
			const worker = new FakeWorker(spec, onPacket, onExit, admit);
			workers.push(worker);
			if (autoReady) queueMicrotask(() => worker.open());
			return worker;
		};
	const manager = async (
		factories: SessionFactories = {},
		options: SessionManagerOptions = {},
		pullRequests: ConstructorParameters<typeof SessionManager>[4] = {},
		beforeLoad?: (sessions: SessionManager) => void,
	) => {
		const sessions = new SessionManager(
			home,
			projects,
			undefined,
			{
				title: async () => undefined,
				worker: workerFactory(),
				...factories,
			},
			pullRequests,
			options,
		);
		managers.push(sessions);
		beforeLoad?.(sessions);
		await sessions.load();
		return sessions;
	};
	const stored = async (
		id: string,
	): Promise<{
		title: string;
		titlePending?: { cwd: string; message: string };
		cwd: string;
		lastUserMessageAt?: number;
		pullRequest?: SessionPullRequest;
		initializing?: boolean;
		preparing?: { source: string; baseBranch?: string };
		pending: Command[];
		cancelled?: boolean;
		inputError?: string;
		failure?: string;
		working?: boolean;
		role?: "diagnostics";
	}> => JSON.parse(await readFile(join(home, "sessions", id, "meta.json"), "utf8"));
	t.after(async () => {
		await Promise.all(managers.map((sessions) => sessions.shutdown()));
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
	});
	return { root, home, source, projects, project, workers, workerFactory, manager, stored };
}

test("a session whose worker failed on a stale credential endpoint recovers on the next daemon", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "Start" });
	await sessions["starting"].get(created.id);
	await sessions.shutdown();
	// A daemon restart leaves the credential endpoint behind, and the worker cannot reach it.
	const persisted = await f.stored(created.id);
	persisted.failure =
		"Session startup: Kernel failed to start: Credential broker stale. Sign in again if a refresh outcome is uncertain.";
	await writeFile(join(f.home, "sessions", created.id, "meta.json"), JSON.stringify(persisted));
	const restarted = await f.manager();
	const recovered = restarted["metas"].get(created.id)!;
	assert.equal(recovered.failure, undefined, "a stale credential endpoint must not keep a chat broken");
	assert.equal(recovered.kernelRestartPending, true);
});

test("a chat left broken by a daemon that lost its credential broker recovers on the next daemon", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "Start" });
	await sessions["starting"].get(created.id);
	await sessions.shutdown();
	const persisted = await f.stored(created.id);
	persisted.failure =
		"Session startup: Kernel failed to start: Credential broker unavailable. Sign in again if a refresh outcome is uncertain.";
	await writeFile(join(f.home, "sessions", created.id, "meta.json"), JSON.stringify(persisted));
	const restarted = await f.manager();
	const recovered = restarted["metas"].get(created.id)!;
	assert.equal(recovered.failure, undefined, "a chat must not stay broken because its broker was gone");
	assert.equal(recovered.kernelRestartPending, true);
});

test("todo count uses the live cache, ignores retired workers, and cold-reads without opening an agent", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "Start" });
	await sessions["starting"].get(created.id);
	const worker = f.workers[0];
	const meta = sessions["metas"].get(created.id)!;
	sessions["onPacket"](meta, worker, { type: "todos.changed", openCount: 3 });
	assert.equal(await sessions.openTodoCount(created.id), 3);
	const retired = { ...worker } as unknown as SessionWorker;
	sessions["onPacket"](meta, retired, { type: "todos.changed", openCount: 99 });
	assert.equal(await sessions.openTodoCount(created.id), 3);
	sessions["workers"].delete(created.id);
	assert.equal(await sessions.openTodoCount(created.id), 0, "unopened durable storage has no todos");
	assert.equal(f.workers.length, 1, "counting never reopens a parked agent");
});

test("Stop reopens a parked input-paused chat instead of incorrectly reporting an idle no-op", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "Start" });
	await sessions["starting"].get(created.id);
	// A legacy persisted pause remains stoppable after the producer is removed.
	sessions["metas"].get(created.id)!.inputsPaused = true;
	f.workers[0]!.finish();
	sessions["workers"].delete(created.id);
	await sessions.stop(created.id);
	await sessions["starting"].get(created.id);
	assert.equal(f.workers.at(-1)!.requests[0]?.type, "abort");
	assert.equal(sessions["metas"].get(created.id)!.inputsPaused, undefined);
});

test("Stop reaches a parked pending question instead of reporting an idle no-op", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "Start" });
	await sessions["starting"].get(created.id);
	f.workers[0]!.finish({ outcome: "question", outcomeAt: 42, outcomeReason: "Which?" });
	sessions["workers"].delete(created.id);
	await sessions.stop(created.id);
	await sessions["starting"].get(created.id);
	assert.equal(f.workers.at(-1)!.requests[0]?.type, "abort");
});

test("diagnostics reads a parked session without opening its worker or transcript", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager(
		{},
		{
			diagnosticHost,
		},
	);
	const created = await sessions.spawn({ cwd: f.source, message: "Start" });
	await sessions["starting"].get(created.id);
	f.workers[0]!.finish({ outcome: "done", outcomeAt: Date.now() });
	sessions["workers"].delete(created.id);
	const reads = t.mock.method(sessions["coldReader"], "read", async () => {
		throw new Error("transcript must not be read");
	});
	const meta = sessions["metas"].get(created.id)!;
	meta.working = true;
	sessions.setConnectivity(false);
	const offline = await sessions.diagnostics(created.id);
	assert.equal(offline.host.daemonId, "daemon");
	assert.equal(offline.current.state, "parked");
	assert.deepEqual(offline.current.pauses, ["connectivity"]);
	assert.equal(offline.connectivity.state, "offline");
	assert.equal(offline.ai?.efficiency?.relaunch.reasons.initial, 1);
	meta.working = false;
	meta.failure = "raw startup error with a secret";
	const failed = await sessions.diagnostics(created.id);
	assert.equal(failed.current.state, "failed");
	assert.equal(failed.current.errorCode, "startup_failure");
	assert.equal(failed.sessionId, created.id);
	const encoded = JSON.stringify(failed);
	assert.equal(encoded.includes("raw startup error"), false);
	assert.equal(encoded.includes(created.sessionPath!), false, "clipboard-only session roots never enter diagnostics");
	assert.equal(encoded.includes(created.cwd), false, "workspaces never enter diagnostics");
	assert.equal(f.workers.length, 1, "diagnostics never constructs a replacement worker");
	assert.equal(reads.mock.callCount(), 0);
});

test("only a diagnostics specialist can inspect its parked admitted target", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager(
		{},
		{
			diagnosticHost,
		},
	);
	const peer = await sessions.spawn({ cwd: f.source, projectId: f.project.id, message: "Peer" });
	const caller = await sessions.spawn({
		projectId: f.project.id,
		message: "Caller",
		role: "diagnostics",
		diagnosticTarget: diagnosticTarget(peer.id),
	});
	await Promise.all([sessions["starting"].get(caller.id), sessions["starting"].get(peer.id)]);
	const callerWorker = sessions["workers"].get(caller.id)! as FakeWorker;
	const peerWorker = sessions["workers"].get(peer.id)! as FakeWorker;
	sessions["onPacket"](sessions["metas"].get(peer.id)!, peerWorker, {
		type: "diagnostics.call",
		callId: "ordinary-read",
		sessionId: peer.id,
	});
	await until(() => peerWorker.sent.some((command) => command.type === "diagnostics.result"));
	const ordinary = peerWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.result" }> =>
			command.type === "diagnostics.result" && command.callId === "ordinary-read",
	);
	assert.match(ordinary?.error ?? "", /Only an admitted diagnostics specialist/);
	sessions["workers"].delete(peer.id);
	sessions["onPacket"](sessions["metas"].get(caller.id)!, callerWorker, {
		type: "diagnostics.call",
		callId: "peer-read",
		sessionId: peer.id,
		limit: 4,
	});
	await until(() => callerWorker.sent.some((command) => command.type === "diagnostics.result"));
	const allowed = callerWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.result" }> =>
			command.type === "diagnostics.result" && command.callId === "peer-read",
	);
	assert.ok(allowed?.result, allowed?.error);
	assert.ok("sessionId" in allowed.result);
	assert.equal(allowed.result.sessionId, peer.id);
	assert.equal(f.workers.length, 2, "reading the parked peer never constructs a worker");

	const other = await sessions.spawn({ projectId: f.project.id, message: "Other same-project chat" });
	await sessions["starting"].get(other.id);
	sessions["onPacket"](sessions["metas"].get(caller.id)!, callerWorker, {
		type: "diagnostics.call",
		callId: "cross-target",
		sessionId: other.id,
	});
	await until(() =>
		callerWorker.sent.some((command) => command.type === "diagnostics.result" && command.callId === "cross-target"),
	);
	const denied = callerWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.result" }> =>
			command.type === "diagnostics.result" && command.callId === "cross-target",
	);
	assert.ok(denied?.result, denied?.error);
});

test("diagnostic log IPC stays fixed to the persisted host and parked target", async (t) => {
	const f = await fixture(t);
	const daemonLog = join(f.home, "logs", "pilotd.log");
	await mkdir(join(f.home, "logs"), { recursive: true });
	await writeFile(daemonLog, "[2026-10-18T10:00:00.000Z] daemon ready\n");
	const sessions = await f.manager(
		{},
		{
			diagnosticHost,
			diagnosticLogs: { daemonLog, platform: "darwin" },
		},
	);
	const target = await sessions.spawn({ cwd: f.source, projectId: f.project.id, message: "Target" });
	const specialist = await sessions.spawn({
		projectId: f.project.id,
		message: "Inspect logs",
		role: "diagnostics",
		diagnosticTarget: diagnosticTarget(target.id, { ...diagnosticHost, hostId: "selected-alias" }),
	});
	await Promise.all([sessions["starting"].get(target.id), sessions["starting"].get(specialist.id)]);
	const targetWorker = sessions["workers"].get(target.id)! as FakeWorker;
	const specialistWorker = sessions["workers"].get(specialist.id)! as FakeWorker;
	targetWorker.readDiagnosticLogs("ordinary", { action: "inventory" });
	await until(() => targetWorker.sent.some((command) => command.type === "diagnostics.logs.result"));
	const ordinary = targetWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.logs.result" }> =>
			command.type === "diagnostics.logs.result" && command.callId === "ordinary",
	);
	assert.match(ordinary?.error ?? "", /diagnostics specialist/);

	sessions["workers"].delete(target.id);
	specialistWorker.readDiagnosticLogs("inventory", { action: "inventory" });
	await until(() =>
		specialistWorker.sent.some(
			(command) => command.type === "diagnostics.logs.result" && command.callId === "inventory",
		),
	);
	const allowed = specialistWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.logs.result" }> =>
			command.type === "diagnostics.logs.result" && command.callId === "inventory",
	);
	assert.ok(allowed?.result, allowed?.error);
	assert.equal(allowed.result.host.hostId, "selected-alias");
	assert.equal(allowed.result.targetSessionId, target.id);
	const daemonSource = allowed.result.sources?.find((source) => source.id === "daemon");
	assert.equal(daemonSource?.availability, "available", JSON.stringify(daemonSource));
	assert.equal(f.workers.length, 2, "log reads never construct a replacement target worker");
	const targetMeta = sessions["metas"].get(target.id)!;
	targetMeta.failure = "synthetic failure";
	specialistWorker.readDiagnosticLogs("failed-target", { action: "search", source: "daemon", q: "ready" });
	await until(() =>
		specialistWorker.sent.some(
			(command) => command.type === "diagnostics.logs.result" && command.callId === "failed-target",
		),
	);
	assert.ok(
		specialistWorker.sent.find(
			(command): command is Extract<KernelCommand, { type: "diagnostics.logs.result" }> =>
				command.type === "diagnostics.logs.result" && command.callId === "failed-target",
		)?.result,
	);
	delete targetMeta.failure;
	targetMeta.archivedAt = Date.now();
	specialistWorker.readDiagnosticLogs("archived-target", { action: "inventory" });
	await until(() =>
		specialistWorker.sent.some(
			(command) => command.type === "diagnostics.logs.result" && command.callId === "archived-target",
		),
	);
	assert.ok(
		specialistWorker.sent.find(
			(command): command is Extract<KernelCommand, { type: "diagnostics.logs.result" }> =>
				command.type === "diagnostics.logs.result" && command.callId === "archived-target",
		)?.result,
		"failed and archived targets remain read-only readable without worker startup",
	);

	const meta = sessions["metas"].get(specialist.id)!;
	meta.diagnosticTarget = {
		...meta.diagnosticTarget!,
		host: { ...meta.diagnosticTarget!.host, lineageId: "wrong-lineage" },
	};
	specialistWorker.readDiagnosticLogs("wrong-host", { action: "inventory" });
	await until(() =>
		specialistWorker.sent.some(
			(command) => command.type === "diagnostics.logs.result" && command.callId === "wrong-host",
		),
	);
	const wrongHost = specialistWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.logs.result" }> =>
			command.type === "diagnostics.logs.result" && command.callId === "wrong-host",
	);
	assert.match(wrongHost?.error ?? "", /target host|does not match this daemon/);
});

test("diagnostics role reads other parked histories without legacy grants and validates provenance", async (t) => {
	const f = await fixture(t);
	const reads: Array<{ directory: string; hostId: string; sessionId: string; before?: number; limit: number }> = [];
	const sessions = await f.manager(
		{
			diagnosticHistoryRead: async (directory, target, before, limit): Promise<DiagnosticHistoryPage> => {
				reads.push({
					directory,
					hostId: target.host.hostId,
					sessionId: target.sessionId,
					...(before === undefined ? {} : { before }),
					limit,
				});
				return {
					schemaVersion: 1,
					target: before === 99 ? { ...target, host: { ...target.host, lineageId: "wrong-lineage" } } : target,
					collectedAt: "2026-01-01T00:00:00.000Z",
					source: { availability: "available", freshness: "fresh" },
					entries: [],
					pagination: {
						...(before === undefined ? {} : { before }),
						more: false,
						returned: 0,
						limit,
						scannedEntries: 0,
						maxScannedEntries: 200,
						encodedBytes: 0,
						maxBytes: 65_536,
						perEntryMaxBytes: 8_192,
						truncatedEntries: 0,
					},
				};
			},
		},
		{ diagnosticHost },
	);
	const target = await sessions.spawn({ projectId: f.project.id, message: "Target" });
	const remoteTarget = diagnosticTarget(target.id, { ...diagnosticHost, hostId: "remote-box" });
	const noLink = await sessions.spawn({
		message: "Generic Ask about Pilot",
		role: "diagnostics",
		diagnosticTarget: remoteTarget,
	});
	const granted = await sessions.spawn({
		message: "Diagnose this chat",
		role: "diagnostics",
		diagnosticTarget: remoteTarget,
		diagnosticHistoryAccess: true,
	});
	await Promise.all([
		sessions["starting"].get(target.id),
		sessions["starting"].get(noLink.id),
		sessions["starting"].get(granted.id),
	]);
	assert.equal(noLink.diagnosticHistoryAccess, undefined);
	assert.equal(granted.diagnosticHistoryAccess, true);
	assert.equal(
		f.workers.find((worker) => worker.spec.sessionId === noLink.id)?.spec.diagnosticHistoryAccess,
		undefined,
	);
	assert.equal(f.workers.find((worker) => worker.spec.sessionId === granted.id)?.spec.diagnosticHistoryAccess, true);

	const noLinkWorker = sessions["workers"].get(noLink.id)! as FakeWorker;
	sessions["onPacket"](sessions["metas"].get(noLink.id)!, noLinkWorker, {
		type: "diagnostics.history.call",
		callId: "no-link",
		sessionId: target.id,
	});
	await until(() =>
		noLinkWorker.sent.some(
			(command) => command.type === "diagnostics.history.result" && command.callId === "no-link",
		),
	);
	const noLinkResult = noLinkWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.history.result" }> =>
			command.type === "diagnostics.history.result" && command.callId === "no-link",
	);
	assert.ok(noLinkResult?.result, noLinkResult?.error);
	assert.equal(reads.length, 1);
	reads.length = 0;

	sessions["workers"].delete(target.id);
	const workerCount = f.workers.length;
	const grantedWorker = sessions["workers"].get(granted.id)! as FakeWorker;
	sessions["onPacket"](sessions["metas"].get(granted.id)!, grantedWorker, {
		type: "diagnostics.history.call",
		callId: "allowed",
		sessionId: target.id,
		before: 17,
		limit: 4,
	});
	await until(() =>
		grantedWorker.sent.some(
			(command) => command.type === "diagnostics.history.result" && command.callId === "allowed",
		),
	);
	const allowed = grantedWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.history.result" }> =>
			command.type === "diagnostics.history.result" && command.callId === "allowed",
	);
	assert.ok(allowed?.result, allowed?.error);
	assert.deepEqual(reads, [
		{
			directory: join(f.home, "sessions", target.id, "durable"),
			hostId: "remote-box",
			sessionId: target.id,
			before: 17,
			limit: 4,
		},
	]);
	assert.equal(f.workers.length, workerCount, "history reads never wake or replace the target worker");
	const targetMeta = sessions["metas"].get(target.id)!;
	targetMeta.failure = "private failure";
	targetMeta.archivedAt = Date.now();
	sessions.setConnectivity(false);
	sessions["onPacket"](sessions["metas"].get(granted.id)!, grantedWorker, {
		type: "diagnostics.history.call",
		callId: "archived-failed-offline",
		sessionId: target.id,
	});
	await until(() =>
		grantedWorker.sent.some(
			(command) => command.type === "diagnostics.history.result" && command.callId === "archived-failed-offline",
		),
	);
	const archived = grantedWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.history.result" }> =>
			command.type === "diagnostics.history.result" && command.callId === "archived-failed-offline",
	);
	assert.ok(archived?.result, archived?.error);
	assert.equal(reads.length, 2, "archived, failed and offline targets remain available through cold storage");
	assert.equal(f.workers.length, workerCount);
	sessions["onPacket"](sessions["metas"].get(granted.id)!, grantedWorker, {
		type: "diagnostics.history.call",
		callId: "wrong-lineage",
		sessionId: target.id,
		before: 99,
	});
	await until(() =>
		grantedWorker.sent.some(
			(command) => command.type === "diagnostics.history.result" && command.callId === "wrong-lineage",
		),
	);
	const wrongLineage = grantedWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.history.result" }> =>
			command.type === "diagnostics.history.result" && command.callId === "wrong-lineage",
	);
	assert.match(wrongLineage?.error ?? "", /source did not match the admitted target/);
	assert.equal(reads.length, 3);

	const other = await sessions.spawn({ projectId: f.project.id, message: "Other" });
	await sessions["starting"].get(other.id);
	sessions["onPacket"](sessions["metas"].get(granted.id)!, grantedWorker, {
		type: "diagnostics.history.call",
		callId: "cross-target",
		sessionId: other.id,
	});
	await until(() =>
		grantedWorker.sent.some(
			(command) => command.type === "diagnostics.history.result" && command.callId === "cross-target",
		),
	);
	const denied = grantedWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.history.result" }> =>
			command.type === "diagnostics.history.result" && command.callId === "cross-target",
	);
	assert.ok(denied?.result, denied?.error);
	assert.equal(reads.length, 4);
});

test("diagnostic performance reads existing sanitized local snapshot only with persisted role", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({}, { diagnosticHost });
	const peer = await sessions.spawn({ projectId: f.project.id, message: "Peer" });
	const specialist = await sessions.spawn({ message: "Diagnose app", role: "diagnostics", diagnosticScope: "app" });
	await Promise.all([sessions["starting"].get(peer.id), sessions["starting"].get(specialist.id)]);
	await assert.rejects(sessions.diagnosticContext(peer.id, { action: "performance" }), /Only diagnostics/);
	await assert.rejects(
		sessions.diagnosticContext(specialist.id, { action: "performance", role: "diagnostics" }),
		/Invalid diagnostic/,
	);
	const absent = await sessions.diagnosticContext(specialist.id, { action: "performance" });
	assert.equal(absent.status, "unavailable");
	assert.equal(absent.reason, "unsupported");
	const watchdog = new EventLoopWatchdog();
	watchdog.start();
	t.after(() => watchdog.stop());
	const end = operations.begin("synthetic password=performance-canary");
	t.after(end);
	let courierReads = 0;
	const stop = sessions.diagnosticReadBroker.onRead(() => courierReads++);
	t.after(stop);
	const workers = f.workers.length;
	const before = sessions.get(peer.id);
	const result = await sessions.diagnosticContext(specialist.id, { action: "performance", host: diagnosticHost });
	assert.equal(result.status, "available");
	assert.deepEqual(result.host, diagnosticHost);
	const data = result.data as {
		process: { mainThreadCpuMs: number; rssBytes: number };
		operations: object;
		eventLoop: object;
	};
	assert.ok(data.process.mainThreadCpuMs >= 0 && data.process.rssBytes > 0);
	assert.ok(data.operations && data.eventLoop);
	assert.doesNotMatch(JSON.stringify(result), /performance-canary/);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
	const remote = await sessions.diagnosticContext(specialist.id, {
		action: "performance",
		host: { ...diagnosticHost, daemonId: "other" },
	});
	assert.equal(remote.status, "unavailable");
	assert.equal(remote.reason, "unsupported");
	assert.equal(courierReads, 0);
	assert.equal(f.workers.length, workers);
	assert.deepEqual(sessions.get(peer.id), before);
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(
		sessions.diagnosticContext(specialist.id, { action: "performance" }, cancelled.signal),
		/cancelled/,
	);
});

test("app-wide diagnostic capability reads unselected archived chats and budgets without waking them", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({}, { diagnosticHost });
	const peer = await sessions.spawn({ projectId: f.project.id, message: "Peer" });
	const specialist = await sessions.spawn({ message: "Diagnose app", role: "diagnostics", diagnosticScope: "app" });
	await Promise.all([sessions["starting"].get(peer.id), sessions["starting"].get(specialist.id)]);
	sessions["metas"].get(peer.id)!.archivedAt = Date.now();
	sessions["workers"].delete(peer.id);
	sessions["aiUsageBudget"] = { basis: "catalog_estimate", limitUsdMicros: 123, window: "retained_chat" };
	const workers = f.workers.length;
	const before = sessions.get(peer.id);
	const chats = await sessions.diagnosticContext(specialist.id, { action: "chats", limit: 20 });
	assert.match(JSON.stringify(chats), new RegExp(peer.id));
	assert.match(JSON.stringify(chats), /archivedAt/);
	const detail = await sessions.diagnosticContext(specialist.id, { action: "chat", sessionId: peer.id });
	assert.match(JSON.stringify(detail), /limitUsdMicros/);
	assert.match(JSON.stringify(detail), /123/);
	const history = await sessions.diagnosticContext(specialist.id, { action: "history", sessionId: peer.id });
	assert.equal(history.host.daemonId, diagnosticHost.daemonId);
	assert.match(JSON.stringify(history), new RegExp(peer.id));
	const deleted = await sessions.diagnosticContext(specialist.id, { action: "history", sessionId: randomUUID() });
	assert.equal(deleted.status, "missing");
	assert.equal(deleted.reason, "deleted");
	await assert.rejects(sessions.diagnosticContext(peer.id, { action: "chats" }), /Only diagnostics/);
	let refreshReads = 0;
	sessions.diagnosticDomainRead = async (request) => {
		refreshReads++;
		return diagnosticContextResponse(request.host!, { refresh: "retained_only_no_network", sources: [] });
	};
	await assert.rejects(sessions.diagnosticContext(peer.id, { action: "refresh_health" }), /Only diagnostics/);
	await assert.rejects(
		sessions.diagnosticContext(specialist.id, { action: "refresh_health", role: "diagnostics" }),
		/Invalid diagnostic/,
	);
	assert.equal(refreshReads, 0);
	const refresh = await sessions.diagnosticContext(specialist.id, { action: "refresh_health" });
	assert.match(JSON.stringify(refresh), /retained_only_no_network/);
	assert.equal(refreshReads, 1, "only the persisted role reaches the read-only service");
	await assert.rejects(
		sessions.diagnosticContext(specialist.id, { action: "chats", role: "diagnostics" }),
		/Invalid diagnostic/,
	);
	assert.equal(f.workers.length, workers);
	assert.deepEqual(sessions.get(peer.id), before, "reads never mutate the archived subject");
	const remote = { hostId: "other", daemonId: "other-daemon", lineageId: "other-lineage" };
	const stop = sessions.diagnosticReadBroker.onRead((d) =>
		sessions.diagnosticReadBroker.respond(d.id, {
			schemaVersion: 1,
			host: { ...remote, lineageId: "forged" },
			status: "available",
			data: { secret: "bad" },
			page: { more: false, scanned: 0, maxScan: 200, maxBytes: 65536, truncated: false },
		}),
	);
	const wrongHost = await sessions.diagnosticContext(specialist.id, { action: "chats", host: remote });
	assert.equal(wrongHost.status, "unavailable");
	assert.doesNotMatch(JSON.stringify(wrongHost), /bad/);
	stop();
});

test("spawning target-scoped diagnostics does not wake or change a parked target", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({}, { diagnosticHost });
	const target = await sessions.spawn({ projectId: f.project.id, message: "Target" });
	await sessions["starting"].get(target.id);
	const before = sessions.get(target.id)!;
	sessions["workers"].delete(target.id);
	const createdWorkers = f.workers.length;
	const specialist = await sessions.spawn({
		message: "Diagnose",
		role: "diagnostics",
		diagnosticTarget: diagnosticTarget(target.id),
	});
	await sessions["starting"].get(specialist.id);
	assert.equal(sessions["workers"].has(target.id), false);
	assert.equal(f.workers.length, createdWorkers + 1, "only the specialist kernel starts");
	assert.deepEqual(sessions.get(target.id), before);
});

test("app-scoped diagnostics starts without a control row, project or hidden chat target", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({}, { diagnosticHost });
	const before = sessions.list().length;
	const specialist = await sessions.spawn({
		message: "Inspect the app",
		role: "diagnostics",
		diagnosticScope: "app",
	});
	await sessions["starting"].get(specialist.id);
	assert.equal(sessions.list().length, before + 1);
	assert.equal(specialist.role, "diagnostics");
	assert.equal(specialist.diagnosticScope, "app");
	assert.equal(specialist.diagnosticTarget, undefined);
	assert.equal(specialist.diagnosticTargetId, undefined);
	assert.equal(specialist.projectId, undefined);
	const worker = f.workers.find((candidate) => candidate.spec.sessionId === specialist.id)!;
	assert.deepEqual(worker.spec.diagnosticScope, { kind: "app", host: diagnosticHost });
	assert.equal(worker.spec.diagnosticTarget, undefined);

	sessions["onPacket"](sessions["metas"].get(specialist.id)!, worker, {
		type: "diagnostics.call",
		callId: "app-snapshot",
	});
	await until(() =>
		worker.sent.some((command) => command.type === "diagnostics.result" && command.callId === "app-snapshot"),
	);
	const result = worker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.result" }> =>
			command.type === "diagnostics.result" && command.callId === "app-snapshot",
	);
	assert.ok(result?.result && "scope" in result.result);
	assert.equal(result.result.scope, "app");
	assert.equal("sessionId" in result.result, false);

	sessions["onPacket"](sessions["metas"].get(specialist.id)!, worker, {
		type: "diagnostics.logs.call",
		callId: "app-logs",
		request: { action: "inventory" },
	});
	await until(() =>
		worker.sent.some((command) => command.type === "diagnostics.logs.result" && command.callId === "app-logs"),
	);
	const logs = worker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.logs.result" }> =>
			command.type === "diagnostics.logs.result" && command.callId === "app-logs",
	);
	assert.equal(logs?.result?.scope, "app");
	assert.equal(logs?.result?.targetSessionId, undefined);
	assert.equal(logs?.result?.sources?.find((source) => source.id === "lifecycle")?.reason, "no_target");
});

test("diagnostics role survives reopen and prepares only a bounded read-only handoff", async (t) => {
	const f = await fixture(t);
	const factories: SessionFactories = {
		workspace: async (_source, path) => {
			await mkdir(path, { recursive: true });
			return { path, base: "HEAD", jj: false };
		},
	};
	const sessions = await f.manager(factories, { diagnosticHost });
	await assert.rejects(
		sessions.spawn({ cwd: f.source, message: "Ordinary", diagnosticTitleFromReply: true }),
		/role=diagnostics/,
	);
	await assert.rejects(
		sessions.spawn({ projectId: f.project.id, message: "Unscoped", role: "diagnostics" }),
		/exactly one app scope or chat target/i,
	);
	await assert.rejects(
		sessions.spawn({
			message: "Conflicting scope",
			role: "diagnostics",
			diagnosticScope: "app",
			diagnosticTarget: diagnosticTarget(randomUUID()),
		}),
		/exactly one app scope or chat target/i,
	);
	const target = await sessions.spawn({ projectId: f.project.id, message: "Target" });
	const remoteTarget = diagnosticTarget(target.id, { ...diagnosticHost, hostId: "remote-box" });
	await assert.rejects(
		sessions.spawn({
			message: "Invalid hint",
			role: "diagnostics",
			diagnosticTarget: remoteTarget,
			diagnosticTitleFromReply: false,
		}),
		/explicit true hint or omitted/,
	);
	await assert.rejects(
		sessions.spawn({
			message: "Conflicting title",
			title: "Explicit",
			role: "diagnostics",
			diagnosticTarget: remoteTarget,
			diagnosticTitleFromReply: true,
		}),
		/cannot be combined/,
	);
	await assert.rejects(
		sessions.spawn({
			message: "Wrong host",
			role: "diagnostics",
			diagnosticTarget: diagnosticTarget(target.id, { ...diagnosticHost, daemonId: "other" }),
		}),
		/does not match this daemon/i,
	);
	await assert.rejects(
		sessions.spawn({
			message: "Malformed link",
			role: "diagnostics",
			diagnosticTarget: { ...remoteTarget, chatUrl: `pilot://chat/${randomUUID()}` },
		}),
		/canonical chat link/i,
	);
	const missingId = randomUUID();
	await assert.rejects(
		sessions.spawn({ message: "Missing target", role: "diagnostics", diagnosticTarget: diagnosticTarget(missingId) }),
		/Unknown session/i,
	);
	await assert.rejects(
		sessions.spawn({
			projectId: f.project.id,
			message: "Writable",
			mode: "build",
			role: "diagnostics",
			diagnosticTarget: remoteTarget,
		}),
		/read-only session/,
	);
	const specialist = await sessions.spawn({
		projectId: f.project.id,
		message: "Diagnose the target",
		role: "diagnostics",
		diagnosticTarget: remoteTarget,
		diagnosticHistoryAccess: true,
		model: "test/diagnostic",
		thinking: "high",
	});
	await Promise.all([sessions["starting"].get(specialist.id), sessions["starting"].get(target.id)]);
	assert.equal(specialist.role, "diagnostics");
	assert.equal(specialist.diagnosticHistoryAccess, true);
	assert.equal(specialist.mode, "ask");
	assert.equal(f.workers.find((worker) => worker.spec.sessionId === specialist.id)?.spec.role, "diagnostics");
	assert.deepEqual(
		f.workers.find((worker) => worker.spec.sessionId === specialist.id)?.spec.diagnosticTarget,
		remoteTarget,
	);
	assert.equal(
		f.workers.find((worker) => worker.spec.sessionId === specialist.id)?.spec.diagnosticHistoryAccess,
		true,
	);
	assert.equal(f.workers.find((worker) => worker.spec.sessionId === specialist.id)?.spec.model, "test/diagnostic");
	assert.equal(f.workers.find((worker) => worker.spec.sessionId === specialist.id)?.spec.thinking, "high");
	assert.equal(specialist.diagnosticTargetId, target.id);
	assert.deepEqual(specialist.diagnosticTarget, remoteTarget);
	const evidence = {
		ref: "diagnostic:v1:lifecycle:bounded",
		source: "lifecycle",
		at: "2026-01-01T00:00:00.000Z",
		kind: "kernel.exit",
		reason: "process_exit",
		state: "failed",
	} as const;
	const diagnostic: SessionDiagnostics = {
		schemaVersion: 1,
		host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
		sessionId: target.id,
		release: "1.0.0",
		collectedAt: "2026-01-01T00:00:01.000Z",
		freshness: "fresh",
		connectivity: { state: "unknown" },
		current: {
			state: "failed",
			working: false,
			pauses: [],
			recovery: "none",
			hasError: true,
			errorCode: "worker_failure",
			queue: {
				pendingInputs: 0,
				starting: false,
				parking: false,
				workspacePreparing: false,
				runningJobs: 0,
				workingSubagents: 0,
			},
		},
		resources: {},
		sources: [],
		evidence: [evidence],
		truncation: {
			truncated: false,
			returned: 1,
			available: 1,
			dropped: 0,
			invalid: 0,
			encodedBytes: 256,
			maxItems: 128,
			maxBytes: 65_536,
		},
	};
	t.mock.method(
		sessions,
		"diagnostics",
		async (_id: string, options: NonNullable<Parameters<SessionManager["diagnostics"]>[1]> = {}) => {
			if (options.host && options.host.daemonId !== diagnosticHost.daemonId)
				throw new Conflict("Diagnostic host identity does not match this daemon");
			return diagnostic;
		},
	);
	const workerCount = f.workers.length;
	const specialistWorker = f.workers.find((worker) => worker.spec.sessionId === specialist.id)!;
	const proposalDraft = {
		evidenceRefs: [evidence.ref],
		findings: "The worker exited before durable completion.",
		uncertainty: "medium" as const,
		suggestedRepair: "Preserve the startup failure until the supervised worker settles.",
		regressionTestGuidance: "Cover the supervised exit boundary with a deterministic fixture.",
	};
	specialistWorker.publishRepairProposal("invalid", { ...proposalDraft, execute: "start" } as never);
	await until(() =>
		specialistWorker.sent.some(
			(command) => command.type === "diagnostics.proposal.result" && command.callId === "invalid",
		),
	);
	assert.match(
		specialistWorker.sent.find(
			(command): command is Extract<KernelCommand, { type: "diagnostics.proposal.result" }> =>
				command.type === "diagnostics.proposal.result" && command.callId === "invalid",
		)?.error ?? "",
		/fields/,
	);
	specialistWorker.publishRepairProposal("stale", { ...proposalDraft, evidenceRefs: ["diagnostic:v1:missing"] });
	await until(() =>
		specialistWorker.sent.some(
			(command) => command.type === "diagnostics.proposal.result" && command.callId === "stale",
		),
	);
	assert.match(
		specialistWorker.sent.find(
			(command): command is Extract<KernelCommand, { type: "diagnostics.proposal.result" }> =>
				command.type === "diagnostics.proposal.result" && command.callId === "stale",
		)?.error ?? "",
		/no longer available/,
	);
	const historyRef = `diagnostic-history:v1:${target.id}:107`;
	const invalidRefError =
		/diagnostic:v1: strings .*returned by diagnostics.*diagnostic-history:v1:.*diagnostic-log:v1:.*not accepted/;
	for (const [callId, evidenceRefs, expectedError] of [
		["history-only", [historyRef], invalidRefError],
		[
			"mixed-history",
			[historyRef, `diagnostic-history:v1:${target.id}:110`, `diagnostic-history:v1:${target.id}:112`, evidence.ref],
			invalidRefError,
		],
		["raw-log-ref", ["diagnostic-log:v1:opaque"], invalidRefError],
		["non-string-ref", [42], invalidRefError],
		["oversized-ref", [`diagnostic:v1:${"x".repeat(256)}`], invalidRefError],
		["empty-refs", [], /requires 1 to 16 unique diagnostic evidence refs/],
		["duplicate-refs", [evidence.ref, evidence.ref], /requires 1 to 16 unique diagnostic evidence refs/],
		[
			"too-many-refs",
			Array.from({ length: 17 }, (_, index) => `diagnostic:v1:lifecycle:${index}`),
			/requires 1 to 16 unique diagnostic evidence refs/,
		],
	] as const) {
		specialistWorker.publishRepairProposal(callId, { ...proposalDraft, evidenceRefs } as never);
		await until(() =>
			specialistWorker.sent.some(
				(command) => command.type === "diagnostics.proposal.result" && command.callId === callId,
			),
		);
		const rejected = specialistWorker.sent.find(
			(command): command is Extract<KernelCommand, { type: "diagnostics.proposal.result" }> =>
				command.type === "diagnostics.proposal.result" && command.callId === callId,
		);
		assert.match(rejected?.error ?? "", expectedError, callId);
		assert.equal(rejected?.result, undefined, callId);
		assert.equal(sessions.get(specialist.id)?.diagnosticRepairProposal, undefined, callId);
	}
	specialistWorker.publishRepairProposal("proposal", proposalDraft);
	await until(() =>
		specialistWorker.sent.some(
			(command) => command.type === "diagnostics.proposal.result" && command.callId === "proposal",
		),
	);
	const proposalResult = specialistWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.proposal.result" }> =>
			command.type === "diagnostics.proposal.result" && command.callId === "proposal",
	);
	const proposal = proposalResult?.result;
	assert.ok(proposal);
	assert.equal(proposal.targetSessionId, target.id);
	assert.deepEqual(sessions.get(specialist.id)?.diagnosticRepairProposal, proposal);
	assert.equal(f.workers.length, workerCount, "publishing a proposal starts no worker or repair chat");
	const handoff = await sessions.diagnosticsHandoff(specialist.id, {
		targetSessionId: target.id,
		proposalId: proposal.id,
		findings: proposal.findings,
		uncertainty: proposal.uncertainty,
		suggestedRepair: proposal.suggestedRepair,
		regressionTestGuidance: "Cover the supervised exit boundary with a deterministic fixture.",
	});
	assert.deepEqual(handoff.evidence, [evidence]);
	assert.equal(handoff.targetSessionId, target.id);
	assert.equal(handoff.proposalId, proposal.id);
	assert.equal(f.workers.length, workerCount, "handoff preparation never starts another worker");
	await assert.rejects(
		sessions.diagnosticsHandoff(specialist.id, {
			targetSessionId: target.id,
			proposalId: "diagnostic-proposal:v1:00000000-0000-4000-8000-000000000001",
			findings: proposal.findings,
			uncertainty: proposal.uncertainty,
			suggestedRepair: proposal.suggestedRepair,
			regressionTestGuidance: proposal.regressionTestGuidance,
		}),
		/missing or has changed/,
	);
	await assert.rejects(
		sessions.diagnosticsHandoff(
			specialist.id,
			{
				targetSessionId: target.id,
				proposalId: proposal.id,
				findings: proposal.findings,
				uncertainty: proposal.uncertainty,
				suggestedRepair: proposal.suggestedRepair,
				regressionTestGuidance: proposal.regressionTestGuidance,
			},
			{ host: { ...diagnosticHost, daemonId: "other" } },
		),
		/host identity/i,
	);
	const sibling = await sessions.spawn({ projectId: f.project.id, message: "Same-project sibling" });
	await sessions["starting"].get(sibling.id);
	await assert.rejects(
		sessions.diagnosticsHandoff(specialist.id, {
			targetSessionId: sibling.id,
			proposalId: proposal.id,
			findings: proposal.findings,
			uncertainty: proposal.uncertainty,
			suggestedRepair: proposal.suggestedRepair,
			regressionTestGuidance: "Test",
		}),
		/subject does not match/,
	);
	await assert.rejects(
		sessions.diagnosticsHandoff(target.id, {
			targetSessionId: specialist.id,
			proposalId: proposal.id,
			findings: proposal.findings,
			uncertainty: proposal.uncertainty,
			suggestedRepair: proposal.suggestedRepair,
			regressionTestGuidance: "Test",
		}),
		/Only a diagnostics specialist/,
	);
	const pilotPath = join(await realpath(f.root), "pilot-source");
	await mkdir(pilotPath);
	const pilotProject = await f.projects.create({ path: pilotPath, name: "Source checkout", model: "test/preferred" });
	t.mock.method(f.projects, "origin", async (id: string) => ({
		identity: id === pilotProject.id ? '["github.com","babariviere/pilot"]' : null,
	}));
	const configured = await sessions.configureDiagnosticRepairProject({
		expectedRevision: 0,
		host: remoteTarget.host,
		projectId: pilotProject.id,
		path: pilotPath,
		origin: '["github.com","babariviere/pilot"]',
	});
	assert.equal(handoff.sourceProjectId, f.project.id, "the evidence project is not the repair destination");
	const repairAdmission = {
		specialistSessionId: specialist.id,
		proposalId: proposal.id,
		target: remoteTarget,
		binding: configured.binding,
		repairTitle: handoff.repairTitle,
		readDiagnostics: true,
	};
	const repairRequest = {
		projectId: pilotProject.id,
		title: handoff.repairTitle,
		workspace: "clone" as const,
		message: "Apply the reviewed repair",
		mode: "build" as const,
		diagnosticRepair: repairAdmission,
	};
	await assert.rejects(
		sessions.spawn(repairRequest),
		/durable native confirmation/,
		"a proposal cannot grant direct create authority",
	);
	await assert.rejects(
		sessions.spawnDurable(
			{
				...repairRequest,
				diagnosticRepair: {
					...repairAdmission,
					target: { ...remoteTarget, host: { ...remoteTarget.host, lineageId: "other" } },
				},
			},
			randomUUID(),
			randomUUID(),
		),
		/Cross-host|stale or belongs to another target/,
	);
	const repairId = randomUUID();
	const repairOperationId = randomUUID();
	const [repair, duplicate] = await Promise.all([
		sessions.spawnDurable(repairRequest, repairId, repairOperationId),
		sessions.spawnDurable(repairRequest, repairId, repairOperationId),
	]);
	assert.equal(duplicate.id, repair.id, "duplicate confirmation joins the exact durable admission");
	assert.equal(
		(await sessions.spawnDurable(repairRequest, repairId, repairOperationId)).id,
		repair.id,
		"lost-response lookup returns the existing repair chat",
	);
	assert.equal(repair.mode, "build");
	assert.equal(repair.role, undefined);
	assert.equal(repair.projectId, pilotProject.id);
	assert.equal(repair.title, handoff.repairTitle);
	await sessions["starting"].get(repair.id);
	const repairWorker = sessions["workers"].get(repair.id)! as FakeWorker;
	const repairMeta = sessions["metas"].get(repair.id)!;
	assert.deepEqual(repairMeta.repairDiagnostics, { kind: "chat", ...remoteTarget });
	assert.ok(repairWorker, sessions.get(repair.id)?.error);
	assert.deepEqual(repairWorker.spec.repairDiagnostics, repairMeta.repairDiagnostics);
	assert.equal(repairWorker.spec.role, undefined, "repair remains an ordinary Build");
	sessions["workers"].delete(target.id);
	await sessions["pullRequests"].settled();
	const targetBeforeReads = JSON.stringify(sessions["metas"].get(target.id));
	const workerCountBeforeReads = f.workers.length;
	const repairRead = async (
		packet: Extract<
			KernelPacket,
			{ type: "diagnostics.call" | "diagnostics.history.call" | "diagnostics.logs.call" | "diagnostics.proposal" }
		>,
	) => {
		sessions["onPacket"](repairMeta, repairWorker, packet);
		await until(() => repairWorker.sent.some((command) => "callId" in command && command.callId === packet.callId));
		return repairWorker.sent.find((command) => "callId" in command && command.callId === packet.callId) as Extract<
			KernelCommand,
			{
				type:
					| "diagnostics.result"
					| "diagnostics.history.result"
					| "diagnostics.logs.result"
					| "diagnostics.proposal.result";
			}
		>;
	};
	const operational = await repairRead({ type: "diagnostics.call", callId: "repair-operational" });
	assert.ok(operational.result, operational.error);
	assert.ok("sessionId" in operational.result && operational.result.sessionId === target.id);
	const history = await repairRead({
		type: "diagnostics.history.call",
		callId: "repair-history",
		sessionId: target.id,
		limit: 1,
	});
	assert.ok(history.result, history.error);
	const logs = await repairRead({
		type: "diagnostics.logs.call",
		callId: "repair-logs",
		request: { action: "inventory" },
	});
	assert.ok(logs.result && "targetSessionId" in logs.result && logs.result.targetSessionId === target.id, logs.error);
	for (const [type, callId] of [
		["diagnostics.call", "repair-other-chat"],
		["diagnostics.history.call", "repair-other-history"],
	] as const) {
		const denied = await repairRead({ type, callId, sessionId: sibling.id });
		assert.match(denied.error ?? "", /approved repair subject/);
		assert.equal(denied.result, undefined);
	}
	const rejectedProposal = await repairRead({
		type: "diagnostics.proposal",
		callId: "repair-no-proposals",
		proposal: proposalDraft,
	});
	assert.match(rejectedProposal.error ?? "", /Only the live diagnostics specialist/);
	await assert.rejects(sessions.diagnosticContext(repair.id, { action: "chats" }), /Only diagnostics/);
	assert.equal(f.workers.length, workerCountBeforeReads, "fresh repair reads never wake or create target workers");
	assert.equal(sessions["workers"].has(target.id), false, "the diagnosed target remains parked");
	assert.equal(
		JSON.stringify(sessions["metas"].get(target.id)),
		targetBeforeReads,
		"diagnostic reads never mutate the target",
	);
	const originalGrant = repairMeta.repairDiagnostics!;
	repairMeta.repairDiagnostics = { ...originalGrant, host: { ...originalGrant.host, lineageId: "changed" } };
	const staleHost = await repairRead({ type: "diagnostics.call", callId: "repair-stale-host" });
	assert.match(staleHost.error ?? "", /host identity changed/);
	repairMeta.repairDiagnostics = originalGrant;
	await assert.rejects(
		sessions.spawnDurable(repairRequest, randomUUID(), randomUUID()),
		/already has a confirmed repair/,
		"different operation IDs cannot admit the same proposal twice",
	);

	specialistWorker.publishRepairProposal("replacement", {
		...proposalDraft,
		findings: "A newer diagnosis replaced the reviewed proposal.",
	});
	await until(() =>
		specialistWorker.sent.some(
			(command) => command.type === "diagnostics.proposal.result" && command.callId === "replacement",
		),
	);
	const replacementProposal = specialistWorker.sent.find(
		(command): command is Extract<KernelCommand, { type: "diagnostics.proposal.result" }> =>
			command.type === "diagnostics.proposal.result" && command.callId === "replacement",
	)?.result;
	assert.ok(replacementProposal);
	await assert.rejects(
		sessions.spawnDurable(repairRequest, randomUUID(), randomUUID()),
		/stale or belongs to another target/,
		"replacement between review and admission invalidates the old confirmation",
	);
	await sessions.shutdown();
	const reopened = await f.manager(factories, { diagnosticHost });
	assert.equal(reopened.get(specialist.id)?.role, "diagnostics");
	assert.equal(reopened["metas"].get(specialist.id)?.role, "diagnostics");
	assert.equal(reopened.get(specialist.id)?.diagnosticTargetId, target.id);
	assert.deepEqual(reopened.get(specialist.id)?.diagnosticTarget, remoteTarget);
	assert.equal(reopened.get(specialist.id)?.diagnosticHistoryAccess, true);
	assert.deepEqual(reopened.get(specialist.id)?.diagnosticRepairProposal, replacementProposal);
	assert.deepEqual(reopened["metas"].get(repair.id)?.repairDiagnostics, { kind: "chat", ...remoteTarget });
	await reopened.send(repair.id, "Continue verification");
	const restoredRepairWorker = reopened["workers"].get(repair.id)! as FakeWorker;
	assert.deepEqual(restoredRepairWorker.spec.repairDiagnostics, { kind: "chat", ...remoteTarget });
});

test("startup/update timing labels are fixed and exclude awaited readiness", async (t) => {
	const f = await fixture(t);
	let now = 0;
	const tracker = new DaemonOperations(
		() => now,
		() => now,
	);
	t.mock.method(operations, "time", <T>(label: string | (() => string), run: () => T) => tracker.time(label, run, 0));
	const factory = f.workerFactory(false);
	const sessions = await f.manager({
		worker: (...args) => {
			now += 150;
			return factory!(...args);
		},
	});
	const chat = await sessions.spawn({ cwd: f.source, message: "private-preparation-content" });
	await until(() => f.workers.length === 1);
	assert.equal(sessions.prepareUpdate().ready, false);
	assert.equal(sessions.pauseForUpdate().ready, false);
	sessions["resumeAfterUpdate"]();
	now += 2_041; // An asynchronous wait must not become a synchronous slow section.
	f.workers[0]!.open();
	await sessions["starting"].get(chat.id);
	const snapshot = tracker.snapshot();
	assert.equal(snapshot.slowByKind.find((entry) => entry.label === "worker.construct")?.ms, 150);
	const expected = [
		"worker.context",
		"worker.construct",
		"worker.publish",
		"sessions.metadata.capture",
		"sessions.metadata.parse",
		"sessions.metadata.encode",
		"sessions.update.prepare",
		"sessions.update.pause",
		"sessions.update.resume",
	];
	assert.deepEqual(snapshot.slowByKind.map((entry) => entry.label).sort(), expected.sort());
	assert.ok(snapshot.recentSlow.every((entry) => entry.ms <= 150));
	assert.doesNotMatch(JSON.stringify(snapshot), /private-preparation-content/);
	assert.ok(!JSON.stringify(snapshot).includes(chat.id));
	assert.ok(!JSON.stringify(snapshot).includes(f.source));
});

test("app evidence stays bounded, expires while idle and is erased on disable", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({}, { diagnosticHost });
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	for (let index = 0; index < 140; index++) sessions.appDiagnostics();
	assert.equal(sessions["appEvidence"].size, 128);
	assert.ok(Buffer.byteLength(JSON.stringify(sessions.appDiagnosticEvidence(diagnosticHost))) < 65536);
	t.mock.timers.tick(30 * 60_000 + 1);
	assert.equal(sessions["appEvidence"].size, 0, "idle expiry does not wait for another read");
	sessions.appDiagnostics();
	sessions.configureTelemetry({
		enabled: false,
		serviceVersion: "test",
		environment: "test",
		hostKind: "local",
		hostId: "host",
		localDiagnostics: false,
	});
	assert.equal(sessions["appEvidence"].size, 0);
	assert.equal(sessions["appEvidenceExpiry"], undefined);
	assert.deepEqual(sessions.appDiagnostics().evidence, []);
	t.mock.timers.reset();
});

test("standalone app proposals use fixed source bindings, reject destination overrides and survive single-start recovery", async (t) => {
	const f = await fixture(t);
	const sourcePath = await realpath(f.source);
	const pilot = await f.projects.update(f.project.id, { path: sourcePath, name: "Source checkout" });
	t.mock.method(f.projects, "origin", async () => ({ identity: '["github.com","babariviere/pilot"]' }));
	const sessions = await f.manager(
		{
			workspace: async (_source, path) => {
				await mkdir(path, { recursive: true });
				return { path, base: "HEAD", jj: false };
			},
		},
		{ diagnosticHost },
	);
	const app = await sessions.spawn({
		role: "diagnostics",
		diagnosticScope: "app",
		diagnosticHost,
		message: "Why does the sidebar retain selection?",
	});
	await sessions["starting"].get(app.id);
	const worker = f.workers.find((item) => item.spec.sessionId === app.id)!;
	const observed = sessions.appDiagnostics().evidence![0]!;
	const draft = {
		evidenceRefs: [observed.ref],
		repairTitle: "Sidebar retains an obsolete selection",
		findings: "Selection persisted after a host changed. The snapshot supplies context, not proof of cause.",
		uncertainty: "high" as const,
		suggestedRepair: "Fence selection by the active host identity.",
		regressionTestGuidance: "Mount the real sidebar and switch between distinct host identities.",
	};
	worker.publishRepairProposal("app-proposal", draft);
	await until(() =>
		worker.sent.some((item) => item.type === "diagnostics.proposal.result" && item.callId === "app-proposal"),
	);
	const proposal = sessions.get(app.id)!.diagnosticRepairProposal!;
	assert.deepEqual(proposal.subject, { kind: "app", host: diagnosticHost });
	assert.equal(proposal.targetSessionId, undefined);
	assert.equal(sessions.list().length, 1, "publishing or viewing an app proposal creates no Build");
	const handoff = await sessions.diagnosticsHandoff(app.id, {
		subject: proposal.subject,
		proposalId: proposal.id,
		findings: proposal.findings,
		uncertainty: proposal.uncertainty,
		suggestedRepair: proposal.suggestedRepair,
		regressionTestGuidance: proposal.regressionTestGuidance,
		repairTitle: proposal.repairTitle,
	});
	assert.equal(handoff.targetSessionId, undefined);
	assert.equal(handoff.projectId, undefined);
	assert.deepEqual(handoff.evidence, [observed]);
	const base = {
		projectId: pilot.id,
		workspace: "clone" as const,
		mode: "build" as const,
		message: JSON.stringify(handoff),
		title: handoff.repairTitle,
		diagnosticRepair: {
			specialistSessionId: app.id,
			proposalId: proposal.id,
			subject: proposal.subject,
			repairTitle: handoff.repairTitle,
		},
	};
	await assert.rejects(sessions.spawnDurable(base, randomUUID(), randomUUID()), /binding/i);
	const configured = await sessions.configureDiagnosticRepairProject({
		expectedRevision: 0,
		host: diagnosticHost,
		projectId: pilot.id,
		path: pilot.path,
		origin: '["github.com","babariviere/pilot"]',
	});
	const request = { ...base, diagnosticRepair: { ...base.diagnosticRepair, binding: configured.binding } };
	for (const override of [
		{ projectId: "wrong" },
		{ cwd: sourcePath },
		{ missionId: "wrong" },
		{ workspace: "direct" as const },
		{ baseBranch: "main" },
		{ title: "Unreviewed title" },
	]) {
		await assert.rejects(
			sessions.spawnDurable({ ...request, ...override }, randomUUID(), randomUUID()),
			/without overrides/,
		);
	}
	const id = randomUUID(),
		operation = randomUUID();
	let reads = 0;
	const changing = t.mock.method(f.projects, "origin", async () => ({
		identity: ++reads < 3 ? '["github.com","babariviere/pilot"]' : '["github.com","fork/pilot"]',
	}));
	await assert.rejects(sessions.spawnDurable(request, id, operation), /changed during preparation/);
	assert.equal(sessions.list().length, 1, "an origin race creates no repair chat");
	assert.equal(sessions["newSessionAdmissions"].size, 0, "failed preparation releases the in-memory reservation");
	assert.equal(
		sessions["metas"].get(app.id)!.diagnosticRepairStart,
		undefined,
		"proven pre-commit rollback releases the claim",
	);
	changing.mock.restore();
	const repair = await sessions.spawnDurable(request, id, operation);
	assert.equal(repair.title, draft.repairTitle);
	assert.equal(
		sessions["metas"].get(repair.id)?.repairDiagnostics,
		undefined,
		"older confirmations never acquire diagnostic access",
	);
	assert.equal(
		(await f.stored(repair.id)).titlePending,
		undefined,
		"reviewed repair titles require no naming model call",
	);
	assert.equal(repair.role, undefined);
	assert.equal(repair.projectId, pilot.id);
	assert.equal(sessions.get(app.id)!.diagnosticTarget, undefined);
	await assert.rejects(sessions.spawnDurable(request, randomUUID(), randomUUID()), /already has a confirmed repair/);
	await sessions.spawnDurable(
		{ ...request, diagnosticRepair: { ...request.diagnosticRepair, readDiagnostics: true } },
		id,
		operation,
	);
	assert.equal(
		sessions["metas"].get(repair.id)?.repairDiagnostics,
		undefined,
		"receipt reconciliation cannot promote an older grant",
	);
	worker.publishRepairProposal("app-access-proposal", draft);
	await until(() =>
		worker.sent.some((item) => item.type === "diagnostics.proposal.result" && item.callId === "app-access-proposal"),
	);
	const accessProposal = sessions.get(app.id)!.diagnosticRepairProposal!;
	const accessRequest = {
		...request,
		diagnosticRepair: { ...request.diagnosticRepair, proposalId: accessProposal.id, readDiagnostics: true },
	};
	await assert.rejects(
		sessions.spawnDurable(
			{ ...accessRequest, diagnosticRepair: { ...accessRequest.diagnosticRepair, readDiagnostics: "yes" as never } },
			randomUUID(),
			randomUUID(),
		),
		/explicitly confirmed/,
	);
	const withAccess = await sessions.spawnDurable(accessRequest, randomUUID(), randomUUID());
	await sessions["starting"].get(withAccess.id);
	const accessMeta = sessions["metas"].get(withAccess.id)!;
	const accessWorker = sessions["workers"].get(withAccess.id)! as FakeWorker;
	assert.deepEqual(accessWorker.spec.repairDiagnostics, { kind: "app", host: diagnosticHost });
	const beforeReads = f.workers.length;
	for (const packet of [
		{ type: "diagnostics.call", callId: "app-repair-operational" },
		{ type: "diagnostics.call", callId: "app-repair-denied-chat", sessionId: repair.id },
		{ type: "diagnostics.history.call", callId: "app-repair-denied-history", sessionId: repair.id },
		{ type: "diagnostics.logs.call", callId: "app-repair-logs", request: { action: "inventory" } },
	] as const) {
		sessions["onPacket"](accessMeta, accessWorker, packet);
		await until(() => accessWorker.sent.some((command) => "callId" in command && command.callId === packet.callId));
	}
	const replies = accessWorker.sent.filter(
		(
			command,
		): command is Extract<
			KernelCommand,
			{ type: "diagnostics.result" | "diagnostics.history.result" | "diagnostics.logs.result" }
		> =>
			command.type === "diagnostics.result" ||
			command.type === "diagnostics.history.result" ||
			command.type === "diagnostics.logs.result",
	);
	assert.ok(
		replies[0]?.result && "scope" in replies[0].result && replies[0].result.scope === "app",
		replies[0]?.error,
	);
	assert.match(replies[1]?.error ?? "", /does not authorize chat diagnostics/);
	assert.match(replies[2]?.error ?? "", /exact approved repair subject/);
	assert.ok(
		replies[3]?.result && "scope" in replies[3].result && replies[3].result.scope === "app",
		replies[3]?.error,
	);
	assert.equal(f.workers.length, beforeReads);
	await sessions.rename(repair.id, "My own repair title");
	await sessions.shutdown();
	const reopened = await f.manager({}, { diagnosticHost });
	assert.equal(reopened.get(app.id)!.role, "diagnostics");
	assert.deepEqual(reopened.get(app.id)!.diagnosticHost, diagnosticHost);
	assert.deepEqual(reopened.get(app.id)!.diagnosticRepairProposal, accessProposal);
	assert.deepEqual(reopened["metas"].get(withAccess.id)?.repairDiagnostics, { kind: "app", host: diagnosticHost });
	assert.equal((await reopened.spawnDurable(request, id, operation)).title, "My own repair title");
	await assert.rejects(
		reopened.spawnDurable(request, randomUUID(), randomUUID()),
		/stale or belongs to another target/,
	);
});

test("large restart recovery keeps the daemon responsive and bounds cold starts without losing input IDs", async (t) => {
	const f = await fixture(t);
	const ids = Array.from({ length: 150 }, () => randomUUID());
	for (const id of ids) {
		await mkdir(join(f.home, "sessions", id), { recursive: true });
		await writeFile(
			join(f.home, "sessions", id, "meta.json"),
			JSON.stringify({
				id,
				cwd: f.source,
				title: "Recover",
				createdAt: 1,
				updatedAt: 1,
				initializing: true,
				pending: [{ type: "input", requestId: `input:${id}`, content: "original", mode: "followUp" }],
			}),
		);
	}
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	await until(() => f.workers.length === 2);
	assert.equal(sessions.list().length, ids.length, "metadata is available before workers become ready");
	assert.deepEqual(sessions.prepareUpdate(), { ready: false }, "queued recoveries retain their admission");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(f.workers.length, 2, "the event loop can run while the recovery queue waits");
	for (let index = 0; index < ids.length; index++) {
		await until(() => f.workers.length > index);
		const worker = f.workers[index]!;
		worker.open();
		await until(() => worker.requests.length === 1);
		assert.equal(worker.requests[0]!.requestId, `input:${worker.spec.sessionId}`);
	}
	await Promise.all(sessions["starting"].values());
	assert.equal(f.workers.length, ids.length);
	assert.equal(sessions["starting"].size, 0);
});

test("Stop returns queued input without waiting behind unrelated cold starts", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	for (let index = 0; index < 2; index++) await sessions.spawn({ cwd: f.source, message: "blocked startup" });
	await until(() => f.workers.length === 2);
	const queued = await sessions.spawn({ cwd: f.source, message: "withdraw this" });
	assert.deepEqual(await sessions.stop(queued.id), { ok: true, draft: "withdraw this" });
	assert.equal(f.workers.length, 2);
	assert.equal((await f.stored(queued.id)).pending[0]?.type, "abort");
});

test("queued worker admission waits for a role change rather than persisting a startup failure", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	for (let index = 0; index < 2; index++) await sessions.spawn({ cwd: f.source, message: "blocked startup" });
	await until(() => f.workers.length === 2);
	const queued = await sessions.spawn({ projectId: f.project.id, workspace: "direct", message: "promote" });
	const role = deferred();
	const roles = sessions as unknown as {
		isMissionCoordinator(id: string): boolean;
		prepareCoordinatorRole(id: string): Promise<void>;
	};
	t.mock.method(roles, "isMissionCoordinator", (id: string) => id === queued.id);
	const prepare = t.mock.method(roles, "prepareCoordinatorRole", async (id: string) => {
		if (id !== queued.id) return;
		await role.promise;
		const meta = sessions["require"](id);
		meta.coordinatorView = {
			originalCwd: f.source,
			path: f.source,
			scratch: f.home,
			head: "a".repeat(40),
			repository: f.source,
		};
	});
	f.workers[0]!.open();
	await until(() => prepare.mock.calls.length > 0);
	assert.equal(f.workers.length, 2);
	role.resolve();
	await until(() => f.workers.length === 3);
	assert.equal(f.workers[2]!.spec.cwd, f.home);
	assert.ok(f.workers[2]!.spec.pilot?.coordinatorView);
	f.workers[2]!.open();
	await sessions["starting"].get(queued.id);
	assert.equal((await f.stored(queued.id)).failure, undefined);
});

test("queued command discovery rechecks archival before opening a worker", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	const idle = await sessions.spawn({ cwd: f.source, message: "idle" });
	await until(() => f.workers.length === 1);
	f.workers[0]!.open();
	await until(() => sessions.get(idle.id)?.state === "working");
	await sessions.stop(idle.id);
	await f.workers[0]!.close();
	for (let index = 0; index < 2; index++) await sessions.spawn({ cwd: f.source, message: "blocked startup" });
	await until(() => f.workers.length === 3);
	// Clear the ready command cache to exercise a first-time cold discovery.
	sessions["commandLists"].delete(idle.id);
	const discovery = sessions.commands(idle.id);
	const rejected = assert.rejects(discovery, /Restore the archived session/);
	await sessions["setArchived"](idle.id, true);
	f.workers[1]!.open();
	await rejected;
	assert.equal(f.workers.length, 3, "archived chat was never forked");
});

for (const pause of ["shutdown", "sleep"] as const) {
	test(`${pause} cancels queued session recoveries without forking or losing their durable outbox`, async (t) => {
		const f = await fixture(t);
		const sessions = await f.manager({ worker: f.workerFactory(false) });
		const chats = [];
		for (let index = 0; index < 8; index++)
			chats.push(await sessions.spawn({ cwd: f.source, message: "unfinished" }));
		await until(() => f.workers.length === 2);
		if (pause === "shutdown") await sessions.shutdown();
		else {
			const sleeping = sessions.pauseForSleep("wake:1");
			await assert.rejects(sessions["ensureWorker"](f.workers[0]!.spec.sessionId), /paused until the next wake/);
			await sleeping;
		}
		await Promise.all(sessions["starting"].values());
		assert.equal(f.workers.length, 2);
		for (const chat of chats) {
			const saved = await f.stored(chat.id);
			assert.equal(saved.pending.length, 1);
			assert.equal(saved.failure, undefined);
		}
	});
}

for (const workspace of ["clone", "direct"] as const) {
	test(`${workspace} summaries project the session storage directory across restart`, async (t) => {
		const f = await fixture(t);
		const sessions = await f.manager({
			workspace: async (_source, path) => ({ path, base: "HEAD", jj: false }),
		});
		const changes: SessionSummary[] = [];
		sessions.onChange((session) => changes.push(session));
		const created = await sessions.spawn({
			...(workspace === "clone" ? { projectId: f.project.id } : { cwd: f.source }),
			title: "Storage path",
			message: "hello",
		});
		const sessionPath = join(f.home, "sessions", created.id);
		assert.equal(created.sessionPath, sessionPath);
		assert.notEqual(created.sessionPath, created.cwd);
		assert.equal(created.cwd, workspace === "clone" ? join(sessionPath, "workspace") : f.source);
		assert.ok((await stat(join(sessionPath, "meta.json"))).isFile());
		await until(() => sessions.get(created.id)?.state === "working");
		assert.equal(f.workers[0]!.spec.storageDir, join(sessionPath, "durable"));
		assert.equal(sessions.get(created.id)?.sessionPath, sessionPath);
		assert.equal(sessions.list()[0]?.sessionPath, sessionPath);
		assert.ok(changes.length > 0);
		assert.ok(changes.every((session) => session.sessionPath === sessionPath));
		await sessions.stop(created.id);
		await sessions.shutdown();
		// Existing metadata has no wire-only path; derive it again when reopening a parked session.
		assert.equal(Object.hasOwn(await f.stored(created.id), "sessionPath"), false);
		const reopened = await f.manager();
		assert.equal(reopened.get(created.id)?.state, "parked");
		assert.equal(reopened.get(created.id)?.sessionPath, sessionPath);
		assert.equal(reopened.list()[0]?.sessionPath, sessionPath);
	});
}

test("POST returns durable starting session before clone or worker, guarding changes and terminals", async (t) => {
	const f = await fixture(t);
	const clone = deferred();
	t.after(() => clone.resolve());
	const sessions = await f.manager({
		workspace: async (_source, path, _runner, signal) => {
			await waitFor(clone.promise, signal);
			return { path, base: "origin/main", jj: false };
		},
	});
	let terminalsStarted = 0;
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		sessions,
		f.projects,
		{} as ModelCatalog,
		{
			attach() {
				terminalsStarted++;
			},
		} as unknown as TerminalManager,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	let ws: WebSocket | undefined;
	t.after(
		() =>
			new Promise<void>((resolve) => {
				ws?.terminate();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const response = await fetch(`${url}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ projectId: f.project.id, message: "first input" }),
		signal: AbortSignal.timeout(3_000),
	});
	assert.equal(response.status, 201);
	const created = (await response.json()) as SessionSummary;
	assert.equal(created.state, "starting");
	assert.equal(created.cwd, join(f.home, "sessions", created.id, "workspace"));
	assert.equal(created.sessionPath, join(f.home, "sessions", created.id));
	assert.notEqual(created.sessionPath, created.cwd);
	assert.notEqual(created.cwd, f.source);
	const meta = await f.stored(created.id);
	assert.equal(meta.initializing, true);
	assert.equal(meta.preparing?.source, f.source);
	assert.equal(meta.pending[0]?.type, "input");
	assert.match(meta.pending[0]!.requestId, /^[0-9a-f-]{36}$/);
	assert.equal(f.workers.length, 0);
	assert.equal((await fetch(`${url}/api/sessions/${created.id}/changes`)).status, 400);

	ws = new WebSocket(`${url.replace("http", "ws")}/api/sessions/${created.id}/ws`);
	const messages: { type: string; message?: string }[] = [];
	ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
	await once(ws, "open");
	// A terminal cannot start before the clone is ready. The refusal is retryable.
	const terminal = new WebSocket(
		`${url.replace("http", "ws")}/api/sessions/${created.id}/terminal/ws?cols=80&rows=24`,
	);
	const refusal = once(terminal, "message");
	const [code] = await once(terminal, "close");
	assert.equal(code, 1013);
	assert.match(JSON.parse(String((await refusal)[0])).message, /still preparing/);
	assert.equal(terminalsStarted, 0);
	assert.equal(f.workers.length, 0);
	clone.resolve();
	await until(() => sessions.get(created.id)?.state === "working");
	await until(() => messages.some((message) => message.type === "events"));
	assert.equal(f.workers.length, 1);
	assert.equal(f.workers[0]!.spec.cwd, created.cwd);
	assert.equal(f.workers[0]!.spec.trustDirectory, f.source);
	assert.equal(f.workers[0]!.requests[0]!.requestId, meta.pending[0]!.requestId);
	assert.deepEqual(sessions.changeBase(created.id), { cwd: created.cwd, base: "origin/main", branch: {} });
});

test("direct projects and cwd overrides return before worker readiness without cloning", async (t) => {
	const f = await fixture(t);
	await f.projects.update(f.project.id, { workspace: "direct" });
	const sessions = await f.manager({
		worker: f.workerFactory(false),
		workspace: async () => {
			throw new Error("must not clone");
		},
	});
	for (const request of [
		{ projectId: f.project.id, message: "direct" },
		{ projectId: f.project.id, cwd: f.source, message: "override" },
		{ cwd: f.source, message: "standalone" },
	]) {
		const created = await sessions.spawn(request);
		assert.equal(created.state, "starting");
		assert.equal(created.cwd, f.source);
		const meta = await f.stored(created.id);
		assert.equal(meta.preparing, undefined);
		// A cold start persists its quota policy before constructing a worker. Spawn must not wait for it.
		await until(() => f.workers.some((worker) => worker.spec.sessionId === created.id));
		const worker = f.workers.at(-1)!;
		assert.equal(worker.requests.length, 0);
		worker.open();
		await until(() => sessions.get(created.id)?.state === "working");
		assert.equal(worker.requests[0]!.requestId, meta.pending[0]!.requestId);
	}
});

test("restart retries an unfinished clone, removes only its partial destination and preserves input IDs", async (t) => {
	const f = await fixture(t);
	const clone = deferred();
	const entered = deferred();
	const sessions = await f.manager({
		workspace: async (_source, path, _runner, signal, baseBranch) => {
			assert.equal(baseBranch, "release/stable");
			entered.resolve();
			await waitFor(clone.promise, signal);
			return { path, base: "HEAD", jj: false };
		},
	});
	const created = await sessions.spawn({
		projectId: f.project.id,
		message: "recover clone",
		baseBranch: "release/stable",
	});
	assert.equal(created.sourceBranch, "release/stable");
	await entered.promise;
	await mkdir(created.cwd);
	await writeFile(join(created.cwd, "partial"), "unfinished");
	await writeFile(join(f.source, "keep"), "source");
	await sessions.send(created.id, "second", "steer", "second-id");
	const before = await f.stored(created.id);
	assert.deepEqual(before.preparing, { source: f.source, baseBranch: "release/stable" });
	await sessions.shutdown();
	clone.resolve();
	let clones = 0;
	const reopened = await f.manager({
		workspace: async (source, path, _runner, _signal, baseBranch) => {
			clones++;
			assert.equal(baseBranch, "release/stable");
			assert.equal(source, f.source);
			assert.equal(path, created.cwd);
			assert.equal(await stat(path).catch(() => undefined), undefined);
			return { path, base: `origin/${baseBranch}`, jj: false };
		},
	});
	await until(() => reopened.get(created.id)?.state === "working");
	assert.equal(clones, 1);
	assert.equal(reopened.get(created.id)?.sourceBranch, "release/stable");
	assert.deepEqual(reopened.changeBase(created.id), { cwd: created.cwd, base: "origin/release/stable", branch: {} });
	assert.equal(await readFile(join(f.source, "keep"), "utf8"), "source");
	assert.deepEqual(f.workers[0]!.requests, before.pending);
	assert.deepEqual((await f.stored(created.id)).pending, []);
	await reopened.shutdown();
	const readyRestart = await f.manager({
		workspace: async () => {
			throw new Error("must reuse prepared base");
		},
	});
	assert.deepEqual(readyRestart.changeBase(created.id), {
		cwd: created.cwd,
		base: "origin/release/stable",
		branch: {},
	});
	assert.equal(readyRestart.get(created.id)?.sourceBranch, "release/stable");
});

test("baseBranch validates before admission and is only accepted for private-clone project sessions", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({
		workspace: async () => {
			throw new Error("must not prepare");
		},
	});
	for (const baseBranch of ["", "HEAD", "main~1", "a b", null, 123])
		await assert.rejects(
			sessions.spawn({ projectId: f.project.id, message: "invalid", baseBranch: baseBranch as string }),
			/valid exact origin branch name/,
		);
	for (const request of [
		{ cwd: f.source },
		{},
		{ projectId: f.project.id, cwd: f.source },
		{ projectId: f.project.id, cwd: "" },
	])
		await assert.rejects(
			sessions.spawn({ ...request, message: "invalid", baseBranch: "main" }),
			/private-clone project without a cwd override/,
		);
	await f.projects.update(f.project.id, { workspace: "direct" });
	await assert.rejects(
		sessions.spawn({ projectId: f.project.id, message: "invalid", baseBranch: "main" }),
		/private-clone project without a cwd override/,
	);
	assert.deepEqual(sessions.list(), []);
	assert.equal(f.workers.length, 0);
});

test("restart after clone but before ready reuses the workspace and recovers idle pending input", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({
		worker: f.workerFactory(false),
		workspace: async (_source, path) => ({ path, base: "HEAD", jj: true }),
	});
	const created = await sessions.spawn({ projectId: f.project.id, message: "recover kernel" });
	await until(() => f.workers.length === 1);
	const before = await f.stored(created.id);
	assert.equal(before.preparing, undefined);
	assert.equal(before.working, undefined);
	await sessions.shutdown();
	const reopened = await f.manager({
		workspace: async () => {
			throw new Error("must not clone again");
		},
	});
	await until(() => reopened.get(created.id)?.state === "working");
	assert.deepEqual(f.workers[1]!.requests, before.pending);
	assert.equal(f.workers[1]!.spec.cwd, created.cwd);
	assert.equal(f.workers[1]!.spec.pilot?.workspace?.jj, true);
});

for (const workspace of ["clone", "direct"] as const) {
	test(`${workspace} workers receive the project's PR policy, refreshed on restart`, async (t) => {
		const f = await fixture(t);
		const sessions = await f.manager({
			workspace: async (_source, path) => ({ path, base: "origin/main", jj: true }),
		});
		await f.projects.update(f.project.id, { workspace });
		const required = await sessions.spawn({ projectId: f.project.id, message: "default policy" });
		await until(() => sessions.get(required.id)?.state === "working");
		assert.equal(f.workers[0]!.spec.pilot?.requirePullRequest, true);
		await f.projects.update(f.project.id, { requirePullRequest: false });
		const direct = await sessions.spawn({ projectId: f.project.id, message: "direct push allowed" });
		await until(() => sessions.get(direct.id)?.state === "working");
		assert.equal(f.workers[1]!.spec.pilot?.requirePullRequest, false);
		assert.equal(Boolean(f.workers[1]!.spec.pilot?.workspace), workspace === "clone");
		// Saving settings never changes a running worker's policy midway through its task.
		await f.projects.update(f.project.id, { requirePullRequest: true });
		assert.equal(f.workers[1]!.spec.pilot?.requirePullRequest, false);
		await sessions.stop(required.id);
		await sessions.stop(direct.id);
		await sessions.shutdown();
		const reopened = await f.manager();
		await reopened.send(direct.id, "use updated policy");
		assert.equal(f.workers[2]!.spec.pilot?.requirePullRequest, true);
	});
}

test("accepted input with a lost acknowledgement replays the same ID and deduplicates after restart", async (t) => {
	const f = await fixture(t);
	const ack = deferred();
	const durableInputs = new Set<string>();
	let executions = 0;
	const admit = async (command: Command) => {
		if (!durableInputs.has(command.requestId)) {
			durableInputs.add(command.requestId);
			executions++;
		}
	};
	const sessions = await f.manager({
		worker: f.workerFactory(true, async (command) => {
			await admit(command);
			await ack.promise;
		}),
	});
	const created = await sessions.spawn({ cwd: f.source, message: "exactly once" });
	await until(() => executions === 1);
	const before = await f.stored(created.id);
	assert.equal(before.pending.length, 1);
	assert.equal(before.working, false);
	await sessions.shutdown();
	ack.resolve();
	const reopened = await f.manager({ worker: f.workerFactory(true, admit) });
	await until(() => reopened.get(created.id)?.state === "working");
	assert.deepEqual(f.workers[1]!.requests, before.pending);
	assert.equal(executions, 1);
	await reopened.send(created.id, "retry accepted", "followUp", before.pending[0]!.requestId);
	assert.equal(executions, 1);
	assert.deepEqual((await f.stored(created.id)).pending, []);
});

test("startup sends are durable, ordered and deduplicated; unsubscribed watchers are not attached", async (t) => {
	const f = await fixture(t);
	const clone = deferred();
	const sessions = await f.manager({
		workspace: async (_source, path, _runner, signal) => {
			await waitFor(clone.promise, signal);
			return { path, base: "HEAD", jj: false };
		},
	});
	const created = await sessions.spawn({ projectId: f.project.id, message: "first" });
	const batches: AgentEvent[][] = [];
	const off = sessions.subscribe(created.id, () => assert.fail("removed watcher was attached"));
	off();
	sessions.subscribe(created.id, (events) => batches.push(events));
	await Promise.all([
		sessions.send(created.id, "second", "steer", "second-id"),
		sessions.send(created.id, "ignored duplicate", "followUp", "second-id"),
		sessions.send(created.id, "third", "followUp", "third-id"),
	]);
	const before = await f.stored(created.id);
	assert.equal(before.pending.length, 3);
	assert.equal(f.workers.length, 0);
	clone.resolve();
	await until(() => sessions.get(created.id)?.state === "working");
	assert.deepEqual(f.workers[0]!.requests, before.pending);
	assert.deepEqual(batches, [[snapshot]]);
	assert.equal(f.workers[0]!.sent.filter((command) => command.type === "watch").length, 1);
});

for (const phase of ["clone", "ready", "ack"] as const) {
	test(`stop during ${phase} withdraws pending input and persists abort before later input`, async (t) => {
		const f = await fixture(t);
		const gate = deferred();
		const sessions = await f.manager({
			worker: f.workerFactory(phase !== "ready", async () => {
				if (phase === "ack") await gate.promise;
			}),
			workspace: async (_source, path, _runner, signal) => {
				if (phase === "clone") await waitFor(gate.promise, signal);
				return { path, base: "HEAD", jj: false };
			},
		});
		const created = await sessions.spawn({ projectId: f.project.id, message: "cancel me" });
		const batches: AgentEvent[][] = [];
		sessions.subscribe(created.id, (events) => batches.push(events));
		if (phase !== "clone") await until(() => f.workers.length === 1);
		if (phase === "ack") await until(() => f.workers[0]!.requests.length === 1);
		await sessions.send(created.id, "also cancel", "followUp", "cancel-id");
		await sessions.stop(created.id);
		const stopped = await f.stored(created.id);
		assert.equal(stopped.pending.length, 1);
		assert.equal(stopped.pending[0]!.type, "abort");
		if (phase === "clone") {
			assert.deepEqual(batches, [[snapshot]]);
			assert.equal(stopped.cancelled, true);
		}
		await sessions.send(created.id, "after stop", "steer", "after-id");
		gate.resolve();
		if (phase === "ready") f.workers[0]!.open();
		await until(() => sessions.get(created.id)?.state === "working");
		const requests = f.workers[0]!.requests;
		assert.deepEqual(requests.slice(phase === "ack" ? 1 : 0), [
			stopped.pending[0],
			{ type: "input", requestId: "after-id", content: "after stop", mode: "steer" },
		]);
		assert.deepEqual((await f.stored(created.id)).pending, []);
	});
}

test("startup retains a redacted nested network cause in summary and persisted failure after restart", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({
		worker: () => {
			throw new TypeError("fetch failed", {
				cause: Object.assign(new Error("connect password=hidden"), {
					code: "ECONNREFUSED",
					host: "api.example.com",
					syscall: "connect",
				}),
			});
		},
	});
	const failed = deferred();
	sessions.onChange((summary) => {
		if (summary.state === "failed") failed.resolve();
	});
	const created = await sessions.spawn({ cwd: f.root, message: "fail visibly" });
	await failed.promise;
	const reason = sessions.get(created.id)!.error!;
	assert.match(reason, /Session startup: Retryable network error.*ECONNREFUSED.*api.example.com.*connect/);
	assert.doesNotMatch(reason, /hidden/);
	assert.equal(sessions.get(created.id)!.outcomeReason, reason);
	assert.equal((await f.stored(created.id)).failure, reason);
	await sessions.shutdown();
	const reopened = await f.manager();
	assert.equal(reopened.get(created.id)!.error, reason);
	assert.equal(reopened.get(created.id)!.outcomeReason, reason);
});

for (const failure of ["clone", "factory", "ready"] as const) {
	test(`${failure} startup errors remain visible failed sessions across restart`, async (t) => {
		const releaseFailureSave = deferred();
		// Register before fixture cleanup so an assertion failure cannot strand shutdown.
		t.after(() => releaseFailureSave.resolve());
		const f = await fixture(t);
		const sessions = await f.manager({
			workspace: async (_source, path) => {
				if (failure === "clone") throw new Error("clone unavailable");
				return { path, base: "HEAD", jj: false };
			},
			worker:
				failure === "factory"
					? () => {
							throw new Error("fork unavailable");
						}
					: f.workerFactory(false),
		});
		const failureSaving = deferred();
		const save = sessions["save"].bind(sessions);
		sessions["save"] = async (meta, ...args) => {
			if (meta.failure) {
				failureSaving.resolve();
				await releaseFailureSave.promise;
			}
			await save(meta, ...args);
		};
		const created = await sessions.spawn({ projectId: f.project.id, message: "fail visibly" });
		const changes: SessionSummary[] = [];
		sessions.onChange((session) => changes.push(session));
		const batches: AgentEvent[][] = [];
		const snapshotDelivered = deferred();
		sessions.subscribe(created.id, (events) => {
			batches.push(events);
			if (sessions.get(created.id)?.state === "failed") snapshotDelivered.resolve();
		});
		if (failure === "ready") {
			await until(() => f.workers.length === 1);
			f.workers[0]!.gate.reject(new Error("kernel unavailable"));
		}
		await failureSaving.promise;
		const beforeFailureSnapshot = failure === "ready" ? [[snapshot]] : [];
		assert.deepEqual(batches, beforeFailureSnapshot);
		assert.equal((await f.stored(created.id)).failure, undefined);
		// A separate update can publish the in-memory failure before its save completes.
		// Force that ordering instead of hoping the filesystem happens to expose the gap.
		sessions["emit"](sessions["metas"].get(created.id)!);
		assert.match(sessions.get(created.id)!.error!, /unavailable/);
		assert.equal(changes.at(-1)?.state, "failed");
		assert.deepEqual(batches, beforeFailureSnapshot, "a failure summary is not a transcript barrier");
		// A summary can expose the failure while its persistence is still in flight.
		// The initial transcript is a separate notification after that save settles.
		releaseFailureSave.resolve();
		await snapshotDelivered.promise;
		assert.equal(batches.length, beforeFailureSnapshot.length + 1);
		assert.deepEqual(
			batches.at(-1)?.filter((event) => event.type === "snapshot"),
			[snapshot],
		);
		assert.equal((await f.stored(created.id)).pending.length, 1);
		await assert.rejects(sessions.send(created.id, "retry"), /unavailable/);
		sessions.subscribe(created.id, () => {});
		if (failure === "clone") {
			await sessions.stop(created.id);
			assert.equal(f.workers.length, 0);
			assert.throws(() => sessions.changeBase(created.id), /still preparing/);
		}
		await sessions.shutdown();
		const count = f.workers.length;
		const reopened = await f.manager();
		assert.equal(reopened.get(created.id)?.state, "failed");
		const recoveredBatches: AgentEvent[][] = [];
		reopened.subscribe(created.id, (events) => recoveredBatches.push(events));
		await until(() => recoveredBatches.length === 1);
		assert.deepEqual(
			recoveredBatches.flat().filter((event) => event.type === "snapshot"),
			[snapshot],
		);
		assert.equal(f.workers.length, count);
		assert.equal(reopened.get(created.id)?.canRetryStartup, failure === "clone" ? undefined : true);
		const pending = (await f.stored(created.id)).pending;
		const diagnostic = reopened.get(created.id)!.error;
		const archived = await reopened.archive(created.id);
		assert.ok(archived.archivedAt);
		assert.equal(archived.canRetryStartup, undefined);
		assert.equal(archived.error, diagnostic);
		assert.deepEqual((await f.stored(created.id)).pending, pending);
		assert.equal(f.workers.length, count, "archiving must not launch a worker");
		await reopened.restore(created.id);
		assert.equal(reopened.get(created.id)?.canRetryStartup, failure === "clone" ? undefined : true);
		assert.equal(f.workers.length, count, "restoring a failed session must not launch a worker");
		if (failure === "clone") {
			await assert.rejects(reopened.retryStartup(created.id), /no retryable/);
		} else {
			const result = await reopened.retryStartup(created.id);
			assert.equal(result.state, "working");
			assert.equal(result.canRetryStartup, undefined);
			assert.equal(result.error, undefined);
			assert.equal(result.outcome, undefined);
			assert.deepEqual(f.workers.at(-1)!.requests, pending);
			assert.deepEqual((await f.stored(created.id)).pending, []);
			await assert.rejects(reopened.retryStartup(created.id), /no retryable/);
		}
	});
}

for (const workspace of ["clone", "direct"] as const) {
	test(`retry startup reuses the ${workspace} workspace, closes the old owner and serializes recovery`, async (t) => {
		const f = await fixture(t);
		let clones = 0;
		const sessions = await f.manager({
			workspace: async (_source, path) => {
				clones++;
				await mkdir(path);
				return { path, base: "HEAD", jj: false };
			},
			worker: f.workerFactory(false),
		});
		const created = await sessions.spawn({
			...(workspace === "clone" ? { projectId: f.project.id } : { cwd: f.source }),
			message: "original input",
		});
		await until(() => f.workers.length === 1);
		await writeFile(join(created.cwd, "keep"), "workspace contents");
		await sessions.send(created.id, "second input", "steer", "stable-second-id");
		f.workers[0]!.gate.reject(new Error("Native extension loading failed: dependency missing"));
		await until(() => sessions.get(created.id)?.canRetryStartup === true);
		const before = await f.stored(created.id);
		const batches: AgentEvent[][] = [];
		sessions.subscribe(created.id, (events) => batches.push(events));
		const close = deferred();
		t.after(() => close.resolve());
		f.workers[0]!.closeGate = close.promise;
		const retry = sessions.retryStartup(created.id);
		await until(() => f.workers[0]!.closed);
		assert.equal(f.workers.length, 1, "replacement must wait for the old storage owner");
		await assert.rejects(sessions.retryStartup(created.id), /changing configuration/);
		await assert.rejects(sessions.send(created.id, "racing send"), /changing its model/);
		await assert.rejects(sessions.stop(created.id), /changing its model/);
		await assert.rejects(sessions.archive(created.id), Conflict);
		close.resolve();
		await until(() => f.workers.length === 2);
		assert.equal(sessions.get(created.id)?.state, "starting");
		assert.equal(f.workers[1]!.spec.cwd, created.cwd);
		assert.equal(f.workers[1]!.spec.storageDir, f.workers[0]!.spec.storageDir);
		assert.ok(f.workers[1]!.sent.some((command) => command.type === "watch"));
		f.workers[1]!.open();
		const result = await retry;
		assert.equal(result.state, "working");
		assert.equal(result.error, undefined);
		assert.equal(result.outcome, undefined);
		assert.equal(result.canRetryStartup, undefined);
		assert.equal(sessions["aiUsage"].summary(created.id, true)?.efficiency?.relaunch.reasons.startup_retry, 1);
		assert.deepEqual(f.workers[1]!.requests, before.pending);
		assert.equal(clones, workspace === "clone" ? 1 : 0);
		assert.equal(await readFile(join(created.cwd, "keep"), "utf8"), "workspace contents");
		assert.equal((await f.stored(created.id)).lastUserMessageAt, before.lastUserMessageAt);
		assert.deepEqual((await f.stored(created.id)).pending, []);
	});
}

test("retry startup failures retain original input, show the new diagnostic and allow another retry", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	const created = await sessions.spawn({ cwd: f.source, message: "original input" });
	await until(() => f.workers.length === 1);
	f.workers[0]!.gate.reject(new Error("first startup failure"));
	await until(() => sessions.get(created.id)?.canRetryStartup === true);
	const pending = (await f.stored(created.id)).pending;
	const retry = sessions.retryStartup(created.id);
	const rejected = assert.rejects(retry, /second startup failure/);
	await until(() => f.workers.length === 2);
	f.workers[1]!.gate.reject(new Error("second startup failure"));
	await rejected;
	assert.equal(sessions.get(created.id)?.canRetryStartup, true);
	assert.match(sessions.get(created.id)!.error!, /second startup failure/);
	assert.deepEqual((await f.stored(created.id)).pending, pending);
	assert.deepEqual(f.workers[1]!.requests, []);
	const recovered = sessions.retryStartup(created.id);
	await until(() => f.workers.length === 3);
	f.workers[2]!.open();
	assert.equal((await recovered).state, "working");
	assert.deepEqual(f.workers[2]!.requests, pending);
});

test("a failed restart with working children exposes Retry Startup without losing recovery metadata", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	const created = await sessions.spawn({ cwd: f.source, message: "original" });
	await until(() => f.workers.length === 1);
	const meta = sessions["require"](created.id);
	const children: KernelSubagent[] = ["implementation", "review"].map((name) => ({
		name,
		state: "working",
		task: "Unfinished",
		createdAt: 1,
		cwd: f.source,
		storage: join(f.home, name),
	}));
	meta.subagents = children;
	meta.updatePaused = true;
	meta.kernelRestartPending = true;
	f.workers[0]!.gate.reject(new Error("Credential broker busy"));
	await sessions["starting"].get(created.id);
	const failed = sessions.get(created.id)!;
	assert.equal(failed.state, "failed");
	assert.equal(failed.working, false, "stale child flags must not hide the failure banner and its Retry action");
	assert.equal(failed.canRetryStartup, true);
	assert.equal(failed.outcome, "failed");
	assert.ok(
		failed.subagents?.every((child) => child.state === "idle" && child.error?.includes("Credential broker busy")),
	);
	assert.deepEqual(meta.subagents, children, "display projection must not cancel durable child recovery");
	await sessions.shutdown();
	const reopened = await f.manager();
	assert.equal(reopened.get(created.id)?.working, false);
	assert.equal(reopened.get(created.id)?.canRetryStartup, true);
	assert.deepEqual(reopened["require"](created.id).subagents, children);
	assert.equal(f.workers.length, 1, "viewing a failed restart cannot start its children");
});

test("Stop cancels failed child recovery without credentials and stays stopped across viewing, sleep and restart", async (t) => {
	const f = await fixture(t);
	const closing = deferred();
	t.after(() => closing.resolve());
	const cancelled: string[] = [];
	const sessions = await f.manager({
		worker: f.workerFactory(false),
		stopRecovery: async (spec) => {
			cancelled.push(spec.sessionId);
			return [];
		},
	});
	const created = await sessions.spawn({ cwd: f.source, message: "undelivered" });
	await until(() => f.workers.length === 1);
	f.workers[0]!.gate.reject(new Error("Credential broker busy"));
	await sessions["starting"].get(created.id);
	f.workers[0]!.closeGate = closing.promise;
	const stop = sessions.stop(created.id);
	await until(() => f.workers[0]!.closed);
	assert.deepEqual(cancelled, [], "wait for the old storage owner to exit");
	await assert.rejects(sessions.retryStartup(created.id), /changing configuration/);
	closing.resolve();
	assert.deepEqual(await stop, { ok: true, draft: "undelivered" });
	assert.deepEqual(cancelled, [created.id]);
	const stopped = sessions.get(created.id)!;
	assert.equal(stopped.state, "parked");
	assert.equal(stopped.working, false);
	assert.equal(stopped.error, undefined);
	assert.equal(stopped.outcome, undefined);
	assert.equal(sessions["require"](created.id).recoveryStopped, true);
	assert.deepEqual(
		(await f.stored(created.id)).pending.map((command) => command.type),
		["abort"],
	);
	assert.equal(f.workers.length, 1, "Stop never starts a model or credential-dependent worker");
	await sessions.shutdown();
	const reopened = await f.manager();
	const batches: AgentEvent[][] = [];
	reopened.subscribe(created.id, (events) => batches.push(events));
	await until(() => batches.length > 0);
	await reopened.pauseForSleep("sleep:stopped");
	await reopened.resumeAfterSleep();
	await Promise.all(reopened["starting"].values());
	assert.equal(reopened.get(created.id)?.working, false);
	assert.equal(reopened.get(created.id)?.outcome, undefined, "cold history cannot resurrect the old completion");
	assert.equal(f.workers.length, 1, "restart, subscription and wake must not reopen stopped recovery");
	assert.deepEqual(await reopened.stop(created.id), { ok: true });
	assert.deepEqual(await reopened.sendReported(created.id, "automatic follow-up", "mission:send:stopped"), {
		delivery: "rejected",
		mode: "followUp",
		reason: "stopped",
		error: "Chat recovery is stopped. Send a new message to continue.",
	});
	await assert.rejects(
		reopened.sharedContextNotice(created.id, "shared-context:stopped", "Shared context changed"),
		/recovery is stopped/,
	);
	assert.equal(f.workers.length, 1, "automatic and agent follow-ups cannot release the user's Stop fence");
	await until(() => reopened.prepareUpdate().ready);
	reopened["resumeAfterUpdate"]();
	await assert.rejects(reopened["ensureWorker"](created.id), /Recovery is stopped/);
	await reopened.send(created.id, "new explicit work", "followUp", "new-work");
	assert.equal(f.workers.length, 2);
	assert.equal(reopened["aiUsage"].summary(created.id, true)?.efficiency?.relaunch.reasons.user_resume, 1);
	assert.equal(f.workers[1]!.spec.stopOnOpen, true, "cancel the old run before resuming the Harness");
	assert.deepEqual(
		f.workers[1]!.requests.map((command) => command.type),
		["abort", "input"],
	);
	assert.equal(f.workers[1]!.requests[1]?.requestId, "new-work");
});

test("failed cancellation preserves its failure, outbox and retryable Stop intent", async (t) => {
	const f = await fixture(t);
	let attempts = 0;
	const sessions = await f.manager({
		worker: f.workerFactory(false),
		stopRecovery: async () => {
			if (++attempts === 1) throw new Error("Child journal is busy");
			return [];
		},
	});
	const created = await sessions.spawn({ cwd: f.source, message: "keep my draft" });
	await until(() => f.workers.length === 1);
	f.workers[0]!.gate.reject(new Error("Startup failed"));
	await sessions["starting"].get(created.id);
	await assert.rejects(sessions.stop(created.id), /Child journal is busy/);
	assert.equal(sessions.get(created.id)?.canRetryStartup, true);
	assert.equal(sessions["require"](created.id).recoveryStopped, true);
	assert.equal((await f.stored(created.id)).pending[1]?.type, "input");
	assert.deepEqual(await sessions.stop(created.id), { ok: true, draft: "keep my draft" });
	assert.equal(sessions.get(created.id)?.error, undefined);
	assert.equal(attempts, 2);
});

test("retry startup honors the update lease and resumes the durable outbox after interrupted recovery", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	const created = await sessions.spawn({ cwd: f.source, message: "original input" });
	await until(() => f.workers.length === 1);
	f.workers[0]!.state = "failed";
	f.workers[0]!.gate.reject(new Error("startup failure"));
	await until(() => sessions.get(created.id)?.canRetryStartup === true);
	const pending = (await f.stored(created.id)).pending;
	await until(() => sessions.prepareUpdate().ready);
	await assert.rejects(sessions.retryStartup(created.id), /update/i);
	assert.equal(sessions.get(created.id)?.canRetryStartup, true);
	assert.equal(f.workers.length, 1);
	await sessions.shutdown();
	const recovering = await f.manager({ worker: f.workerFactory(false) });
	const retry = recovering.retryStartup(created.id);
	await until(() => f.workers.length === 2);
	assert.deepEqual(recovering.prepareUpdate(), { ready: false });
	assert.equal((await f.stored(created.id)).initializing, true);
	await recovering.shutdown();
	await retry;
	const reopened = await f.manager();
	await until(() => reopened.get(created.id)?.state === "working");
	assert.deepEqual(f.workers.at(-1)!.requests, pending);
	assert.deepEqual((await f.stored(created.id)).pending, []);
});

test("retry startup refuses archived, invalid and non-startup failed sessions", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	const created = await sessions.spawn({ cwd: f.source, message: "original input" });
	await assert.rejects(sessions.retryStartup("missing"), /Unknown session/);
	await assert.rejects(sessions.retryStartup(created.id), /no retryable/);
	await until(() => f.workers.length === 1);
	f.workers[0]!.gate.reject(new Error("startup failure"));
	await until(() => sessions.get(created.id)?.canRetryStartup === true);
	await sessions.shutdown();
	const path = join(f.home, "sessions", created.id, "meta.json");
	const original = JSON.parse(await readFile(path, "utf8"));
	for (const patch of [{ archivedAt: Date.now() }, { failure: "Session validation: invalid source" }]) {
		await writeFile(path, JSON.stringify({ ...original, ...patch }));
		const reopened = await f.manager();
		assert.equal(reopened.get(created.id)?.canRetryStartup, undefined);
		await assert.rejects(reopened.retryStartup(created.id), Conflict);
		await reopened.shutdown();
	}
	await writeFile(path, JSON.stringify({ ...original, mode: "unsupported" }));
	const invalid = await f.manager();
	await assert.rejects(invalid.retryStartup(created.id), /mode/);
	assert.equal(f.workers.length, 1, "invalid metadata cannot reopen a worker");
});

test("shutdown during clone does not start a worker when preparation later completes", async (t) => {
	const f = await fixture(t);
	const entered = deferred();
	const clone = deferred();
	const sessions = await f.manager({
		workspace: async (_source, path, _runner, signal) => {
			entered.resolve();
			await waitFor(clone.promise, signal);
			return { path, base: "HEAD", jj: false };
		},
	});
	const created = await sessions.spawn({ projectId: f.project.id, message: "resume later" });
	await entered.promise;
	await sessions.shutdown();
	clone.resolve();
	await delay(5);
	assert.equal(f.workers.length, 0);
	assert.equal((await f.stored(created.id)).initializing, true);
	assert.ok((await f.stored(created.id)).preparing);
});

test("stopped preparation stays cancelled across restart and immediately clears subscriber loading", async (t) => {
	const f = await fixture(t);
	const gate = deferred();
	const workspace: SessionFactories["workspace"] = async (_source, path, _runner, signal) => {
		await waitFor(gate.promise, signal);
		return { path, base: "HEAD", jj: false };
	};
	const sessions = await f.manager({ workspace });
	const created = await sessions.spawn({ projectId: f.project.id, message: "must not run" });
	await sessions.stop(created.id);
	const stopped = await f.stored(created.id);
	await sessions.shutdown();
	const reopened = await f.manager({ workspace });
	const batches: AgentEvent[][] = [];
	reopened.subscribe(created.id, (events) => batches.push(events));
	assert.deepEqual(batches, [[snapshot]]);
	gate.resolve();
	await until(() => reopened.get(created.id)?.state === "idle");
	assert.equal(f.workers.length, 1);
	assert.deepEqual(f.workers[0]!.requests, stopped.pending);
	assert.equal(f.workers[0]!.requests[0]!.type, "abort");
});

test("worker context is live-only while aggregate AI accounting survives worker and daemon restarts", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "usage" });
	await until(() => sessions.get(created.id)?.state === "working");
	const changes: SessionSummary[] = [];
	sessions.onChange((session) => changes.push(session));
	const context = { tokens: 100, contextWindow: 200_000, percent: 0.05 };
	const scope = (kind: "model_requests" | "child_operations", input: number) => ({
		tokens: { input, output: 10, cacheRead: 5, cacheWrite: 0, reasoningStatus: "unavailable" as const },
		cost: {
			estimateStatus: "unavailable" as const,
			billedStatus: "unavailable" as const,
			subscriptionCoverage: "unknown" as const,
		},
		activity: {
			kind,
			count: 1,
			success: 1,
			failure: 0,
			cancelled: 0,
			usageReports: 1,
			providerAttemptsObserved: 1,
			requestRetriesObserved: 0,
			elapsedMsObserved: 100,
			activeMsObserved: 80,
			outcomeCoverage: "partial" as const,
			timingCoverage: "partial" as const,
		},
	});
	f.workers[0]!.reportUsage({
		context,
		provider: "faux",
		accounting: {
			conversationId: "0",
			timingBoot: "00000000-0000-4000-8000-000000000001",
			activityEpoch: "initial",
			epochKind: "initial",
			observedAt: Date.now(),
			direct: scope("model_requests", 100),
			child: scope("child_operations", 20),
		},
	});
	assert.deepEqual(sessions.get(created.id)?.usage?.context, context);
	assert.equal(sessions.get(created.id)?.usage?.ai?.direct.tokens.input, 100);
	assert.equal(sessions.get(created.id)?.usage?.ai?.efficiency?.relaunch.reasons.initial, 1);
	assert.equal(changes.at(-1)?.usage?.ai?.child.tokens.input, 20);
	await f.workers[0]!.close();
	assert.equal(sessions.get(created.id)?.usage?.context, undefined);
	assert.equal(sessions.get(created.id)?.usage?.ai?.direct.tokens.input, 100);
	await sessions.shutdown();
	const reopened = await f.manager();
	assert.equal(reopened.get(created.id)?.usage?.ai?.direct.tokens.input, 100);
	assert.equal(reopened.get(created.id)?.usage?.ai?.efficiency?.relaunch.count, 1);
});

test("an above-budget diagnostic comparison is consent-gated and never affects execution", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({}, { diagnosticHost });
	const telemetry = {
		enabled: false,
		serviceVersion: "test",
		environment: "test" as const,
		hostKind: "local" as const,
		hostId: "host",
		localDiagnostics: true,
	};
	sessions.configureTelemetry(telemetry, {
		basis: "catalog_estimate",
		limitUsdMicros: 100,
		window: "retained_chat",
	});
	const created = await sessions.spawn({ cwd: f.source, message: "usage" });
	await until(() => sessions.get(created.id)?.state === "working");
	assert.equal(JSON.stringify(f.workers[0]!.spec.telemetry).includes("aiUsageBudget"), false);
	const scope = (kind: "model_requests" | "child_operations", active: boolean) => ({
		tokens: {
			input: active ? 10 : 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoningStatus: "unavailable" as const,
		},
		cost: active
			? {
					estimateStatus: "catalog_estimate" as const,
					estimatedUsdMicros: 101,
					pricingRevision: "pi-ai@1.3.0",
					billedStatus: "unavailable" as const,
					subscriptionCoverage: "unknown" as const,
				}
			: {
					estimateStatus: "unavailable" as const,
					billedStatus: "unavailable" as const,
					subscriptionCoverage: "unknown" as const,
				},
		activity: {
			kind,
			count: active ? 1 : 0,
			success: active ? 1 : 0,
			failure: 0,
			cancelled: 0,
			usageReports: active ? 1 : 0,
			providerAttemptsObserved: active ? 1 : 0,
			requestRetriesObserved: 0,
			elapsedMsObserved: active ? 10 : 0,
			activeMsObserved: active ? 8 : 0,
			outcomeCoverage: "partial" as const,
			timingCoverage: "partial" as const,
		},
	});
	f.workers[0]!.reportUsage({
		accounting: {
			conversationId: "0",
			timingBoot: "00000000-0000-4000-8000-000000000001",
			activityEpoch: "initial",
			epochKind: "initial",
			observedAt: Date.now(),
			direct: scope("model_requests", true),
			child: scope("child_operations", false),
		},
	});
	const diagnostic = await sessions.diagnostics(created.id);
	assert.equal(diagnostic.aiBudget?.comparison, "above");
	assert.equal(diagnostic.aiBudget?.informational, true);
	assert.equal(sessions.get(created.id)?.subscriptionPause, undefined);

	const before = f.workers[0]!.requests.length;
	await sessions.send(created.id, "continue normally", "steer", "over-budget-still-runs");
	assert.equal(f.workers[0]!.requests.length, before + 1);
	assert.equal(f.workers[0]!.requests.at(-1)?.requestId, "over-budget-still-runs");

	sessions.configureTelemetry(
		{ ...telemetry, localDiagnostics: false },
		{
			basis: "catalog_estimate",
			limitUsdMicros: 100,
			window: "retained_chat",
		},
	);
	assert.equal((await sessions.diagnostics(created.id)).aiBudget, undefined);
});

test("history reads entries hidden by compaction from the session's durable storage", async (t) => {
	const f = await fixture(t);
	const reads: Array<[string, number, number]> = [];
	const entry = { id: 3, conversationId: 0, kind: "pi.user", createdAt: 1 } as never;
	const sessions = await f.manager({
		historyRead: async (directory, before, limit) => {
			reads.push([directory, before, limit]);
			return { entries: [entry], more: true };
		},
	});
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await until(() => sessions.get(created.id)?.state === "working");
	assert.deepEqual(await sessions.history(created.id, 9, 50), { entries: [entry], more: true });
	assert.deepEqual(reads, [[join(created.sessionPath!, "durable"), 9, 50]]);
	assert.equal(f.workers.length, 1, "reading history never starts another worker");
	await assert.rejects(sessions.history("missing", 9, 50), /Unknown session|not found/i);
});

test("subagent reports reach summaries without private paths, survive parking, and route reads and commands", async (t) => {
	const f = await fixture(t);
	const reads: Array<[string, string, number | undefined]> = [];
	const watches: Array<{
		directory: string;
		conversationId: string;
		update: (update: SubagentWatchUpdate) => void;
		stopped: boolean;
	}> = [];
	const sessions = await f.manager({
		subagentRead: async (directory, conversationId, after) => {
			reads.push([directory, conversationId, after]);
			return after === undefined
				? { full: true, events: [snapshot], cursor: 3 }
				: { full: false, events: [], cursor: after };
		},
		subagentWatch: (directory, conversationId, update) => {
			const watch = { directory, conversationId, update, stopped: false };
			watches.push(watch);
			return () => {
				watch.stopped = true;
			};
		},
	});
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await until(() => sessions.get(created.id)?.state === "working");
	const runs = join(created.sessionPath!, "durable", "subagent-runs", "parent");
	const review: KernelSubagent = {
		name: "review",
		state: "working",
		task: "Review",
		createdAt: 1,
		cwd: f.source,
		model: "test/model",
		storage: join(runs, "1", "review.durable"),
		conversationId: "8",
	};
	const pending: KernelSubagent = { ...review, name: "pending", storage: join(runs, "2", "pending.durable") };
	delete pending.conversationId;
	const outside: KernelSubagent = { ...review, name: "outside", storage: join(f.root, "elsewhere") };
	const retired: KernelSubagent = { ...review, name: "retired", retired: true };
	const changes: SessionSummary[] = [];
	sessions.onChange((session) => changes.push(session));
	f.workers[0]!.reportSubagents([review, pending, outside, retired]);
	const visible = sessions.get(created.id)?.subagents;
	assert.deepEqual(visible?.[0], {
		name: "review",
		state: "working",
		task: "Review",
		createdAt: 1,
		cwd: f.source,
		model: "test/model",
	});
	assert.equal(JSON.stringify(changes.at(-1)).includes("subagent-runs"), false, "storage paths stay private");
	const count = changes.length;
	f.workers[0]!.reportSubagents([review, pending, outside, retired]);
	assert.equal(changes.length, count, "unchanged reports are not republished");

	const full = await sessions.subagentTranscript(created.id, "review");
	assert.deepEqual(full.transcript, { name: "review", full: true, events: [snapshot], cursor: 3 });
	assert.match(full.signature!, /^8\/full\//);
	assert.deepEqual(await sessions.subagentTranscript(created.id, "review", { ifNoneMatch: full.signature }), {
		signature: full.signature,
		unchanged: true,
	});
	const delta = await sessions.subagentTranscript(created.id, "review", { after: 3 });
	assert.deepEqual(delta.transcript, { name: "review", full: false, events: [], cursor: 3 });
	assert.deepEqual(reads, [
		[review.storage, "8", undefined],
		[review.storage, "8", 3],
	]);
	assert.deepEqual((await sessions.subagentTranscript(created.id, "pending")).transcript, {
		name: "pending",
		full: true,
		events: [],
	});
	await assert.rejects(sessions.subagentTranscript(created.id, "outside"), /outside the session/);
	await assert.rejects(sessions.subagentTranscript(created.id, "missing"), /No subagent named missing/);

	// Live transcripts wait for a child's storage, share one watcher, and stop with the last viewer.
	const received: Array<{ name: string; events?: AgentEvent[]; error?: string }> = [];
	const viewer = (name: string) => ({
		events: (events: AgentEvent[]) => received.push({ name, events }),
		error: (error: string) => received.push({ name, error }),
	});
	const offPending = sessions.watchSubagent(created.id, "pending", viewer("pending"));
	assert.deepEqual(received, [{ name: "pending", events: [] }]);
	assert.equal(watches.length, 0, "no watcher before the child has storage");
	const offReview = sessions.watchSubagent(created.id, "review", viewer("review"));
	const offReviewAgain = sessions.watchSubagent(created.id, "review", viewer("review-2"));
	assert.equal(watches.length, 1, "viewers of one subagent share a watcher");
	assert.deepEqual([watches[0]!.directory, watches[0]!.conversationId], [review.storage, "8"]);
	watches[0]!.update({ full: true, events: [snapshot] });
	assert.deepEqual(
		received.slice(1).map((item) => item.name),
		["review", "review-2"],
	);
	sessions.watchSubagent(created.id, "outside", viewer("outside"))();
	assert.match((received.at(-1) as { error?: string }).error ?? "", /outside the session/);
	assert.throws(() => sessions.watchSubagent(created.id, "missing", viewer("missing")), /No subagent named/);
	f.workers[0]!.reportSubagents([review, { ...pending, conversationId: "9" }, outside, retired]);
	assert.equal(watches.length, 2, "a waiting viewer attaches once the child reports its conversation");
	assert.deepEqual([watches[1]!.directory, watches[1]!.conversationId], [pending.storage, "9"]);
	offPending();
	offReview();
	assert.equal(watches[0]!.stopped, false);
	offReviewAgain();
	assert.equal(watches[0]!.stopped, true);
	assert.equal(watches[1]!.stopped, true);

	await sessions.subagentCommand(created.id, "review", { action: "send", message: "focus", requestId: "r1" });
	await sessions.subagentCommand(created.id, "review", { action: "send", message: "then", mode: "followUp" });
	await sessions.subagentCommand(created.id, "review", { action: "stop" });
	await assert.rejects(sessions.subagentCommand(created.id, "missing", { action: "stop" }), /No subagent named/);
	await assert.rejects(sessions.subagentCommand(created.id, "retired", { action: "stop" }), /retired/);
	await assert.rejects(sessions.subagentCommand(created.id, "review", { action: "send", message: " " }), /required/);
	const requests = f.workers[0]!.subagentRequests;
	assert.deepEqual(requests[0], {
		type: "subagent",
		action: "send",
		requestId: "r1",
		name: "review",
		message: "focus",
		mode: "steer",
	});
	assert.equal(requests[1]!.mode, "followUp");
	assert.equal(requests[2]!.action, "stop");
	assert.equal(requests.length, 3);

	// Parked sessions keep the last report, so the app can still list and read subagents.
	await f.workers[0]!.close();
	assert.equal(sessions.get(created.id)?.state, "parked");
	assert.equal(sessions.get(created.id)?.subagents?.length, 4);
	await until(
		async () =>
			((await f.stored(created.id)) as { subagents?: KernelSubagent[] }).subagents?.[0]?.storage === review.storage,
	);
	assert.equal((await sessions.subagentTranscript(created.id, "review")).transcript?.full, true);
	assert.equal(f.workers.length, 1, "reading a transcript never reopens the kernel");
});

test("runtime worker exit publishes parked rather than the exited worker's stale working state", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await until(() => sessions.get(created.id)?.state === "working");
	const changes: SessionSummary[] = [];
	sessions.onChange((session) => changes.push(session));
	await f.workers[0]!.close();
	assert.equal(sessions.get(created.id)?.state, "parked");
	assert.equal(changes.at(-1)?.state, "parked");
});

for (const telemetry of ["usage", "artifacts.changed"] as const) {
	test(`${telemetry} telemetry does not delay parking an idle unwatched worker`, async (t) => {
		const f = await fixture(t);
		const idleParkMs = 60_000;
		let coldReads = 0;
		const sessions = await f.manager(
			{
				snapshot: async () => {
					coldReads++;
					return { events: [snapshot] };
				},
			},
			{ idleParkMs },
		);
		const created = await sessions.spawn({ cwd: f.source, message: "work" });
		await until(() => sessions.get(created.id)?.state === "working");
		await sessions.stop(created.id);
		const worker = f.workers[0]!;
		const lastUse = sessions["lastUse"].get(created.id)!;
		let now = lastUse + idleParkMs - 1;
		t.mock.method(Date, "now", () => now);
		if (telemetry === "usage") worker.reportUsage({ context: { tokens: now, contextWindow: 200_000 } });
		else sessions["onPacket"](sessions["metas"].get(created.id)!, worker, { type: telemetry });
		assert.equal(sessions["lastUse"].get(created.id), lastUse, "telemetry is not execution activity");
		await sessions["parkIdleWorkers"]();
		assert.equal(worker.closed, false, "the original inactivity deadline still applies");
		now += 2;
		if (telemetry === "usage") worker.reportUsage({ context: { tokens: now, contextWindow: 200_000 } });
		else sessions["onPacket"](sessions["metas"].get(created.id)!, worker, { type: telemetry });
		await sessions["parkIdleWorkers"]();
		await sessions["unparked"](created.id);
		assert.equal(worker.closed, true);
		assert.equal(sessions.get(created.id)?.state, "parked");
		assert.equal(coldReads, 0, "parking without viewers never reconstructs the transcript");
		const events: AgentEvent[][] = [];
		const off = sessions.subscribe(created.id, (batch) => events.push(batch));
		await until(() => events.length === 1);
		assert.equal(coldReads, 1, "a viewer loads the parked transcript on demand");
		assert.deepEqual(events[0], [snapshot]);
		assert.equal(f.workers.length, 1, "viewing parked history does not reopen the kernel");
		off();
	});
}

test("reported running jobs prevent parking even when process inspection misses their children", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({}, { idleParkMs: 60_000 });
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await until(() => sessions.get(created.id)?.state === "working");
	await sessions.stop(created.id);
	const worker = f.workers[0]!;
	const meta = sessions["metas"].get(created.id)!;
	const jobs = [
		{ id: "tests", name: "Tests", state: "running" as const, startedAt: Date.now(), outputPath: "/tmp/tests.log" },
	];
	sessions["onPacket"](meta, worker, { type: "jobs.changed", jobs });
	t.mock.method(Date, "now", () => jobs[0]!.startedAt + 120_000);
	assert.equal(worker.children, false);
	await sessions["parkIdleWorkers"]();
	assert.equal(worker.closed, false);
	sessions["onPacket"](meta, worker, { type: "jobs.changed", jobs: [] });
	await sessions["parkIdleWorkers"]();
	assert.equal(worker.closed, false, "the pending result turn is still working");
	sessions["onPacket"](meta, worker, {
		type: "working",
		working: false,
		completion: { outcome: "done", outcomeAt: Date.now() },
	});
	sessions["lastUse"].set(created.id, jobs[0]!.startedAt);
	await sessions["parkIdleWorkers"]();
	await sessions["unparked"](created.id);
	assert.equal(worker.closed, true);
});

test("execution packets reset the parking deadline and working workers remain protected", async (t) => {
	const f = await fixture(t);
	const idleParkMs = 60_000;
	const sessions = await f.manager({ snapshot: async () => ({ events: [snapshot] }) }, { idleParkMs });
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await until(() => sessions.get(created.id)?.state === "working");
	await sessions.stop(created.id);
	const worker = f.workers[0]!;
	let now = sessions["lastUse"].get(created.id)! + idleParkMs + 1;
	t.mock.method(Date, "now", () => now);
	await worker.request({ type: "input", requestId: "active", content: "work", mode: "followUp" });
	assert.equal(sessions["lastUse"].get(created.id), now);
	now += idleParkMs + 1;
	await sessions["parkIdleWorkers"]();
	assert.equal(worker.closed, false, "working kernels never park even past the deadline");
	await worker.request({ type: "abort", requestId: "idle" });
	assert.equal(sessions["lastUse"].get(created.id), now);
	now += idleParkMs - 1;
	await sessions["parkIdleWorkers"]();
	assert.equal(worker.closed, false, "execution starts a fresh inactivity window");
	now += 2;
	await sessions["parkIdleWorkers"]();
	await sessions["unparked"](created.id);
	assert.equal(worker.closed, true);
});

test("jobs listing is session-local and never wakes parked, archived or unknown chats", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({}, { idleParkMs: 60_000 });
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await until(() => sessions.get(created.id)?.state === "working");
	const worker = f.workers[0]!;
	const lastUse = sessions["lastUse"].get(created.id);
	const summary = sessions.get(created.id);
	const launches = sessions["aiUsage"].summary(created.id, true)?.efficiency?.relaunch.count;
	const reads = t.mock.method(worker, "jobs", worker.jobs.bind(worker));
	assert.deepEqual(await sessions.jobs(created.id), await worker.jobs());
	const afterJobs = sessions.get(created.id);
	assert.deepEqual({ ...afterJobs, usage: undefined }, { ...summary, usage: undefined });
	assert.equal(
		sessions["aiUsage"].summary(created.id, true)?.efficiency?.relaunch.count,
		launches,
		"a jobs read does not create launch evidence",
	);
	assert.equal(sessions["lastUse"].get(created.id), lastUse);
	await sessions.stop(created.id);
	const now = sessions["lastUse"].get(created.id)! + 60_001;
	t.mock.method(Date, "now", () => now);
	await sessions["parkIdleWorkers"]();
	await sessions["unparked"](created.id);
	const count = reads.mock.callCount();
	assert.deepEqual(await sessions.jobs(created.id), []);
	assert.equal(reads.mock.callCount(), count);
	assert.equal(f.workers.length, 1);
	await sessions.archive(created.id);
	assert.deepEqual(await sessions.jobs(created.id), []);
	assert.equal(f.workers.length, 1);
	await assert.rejects(sessions.jobs("missing"), /Unknown session/);
});

test("stopping a job reaches only a live worker's running job", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({}, { idleParkMs: 60_000 });
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await until(() => sessions.get(created.id)?.state === "working");
	const worker = f.workers[0]!;
	const meta = sessions["metas"].get(created.id)!;
	await assert.rejects(sessions.stopJob(created.id, "tests"), NotFound);
	const job = { name: "Tests", state: "running" as const, startedAt: Date.now(), outputPath: "/tmp/tests.log" };
	sessions["onPacket"](meta, worker, {
		type: "jobs.changed",
		jobs: [
			{ id: "tests", ...job },
			{ id: "ended", ...job },
		],
	});
	await sessions.stopJob(created.id, "tests");
	await assert.rejects(sessions.stopJob(created.id, "ended"), /no longer running/);
	await assert.rejects(sessions.stopJob(created.id, "other"), /no longer running/);
	assert.deepEqual(worker.stoppedJobs, ["tests", "ended"]);
	await assert.rejects(sessions.stopJob("missing", "tests"), /Unknown session/);
	await sessions.stop(created.id);
	await sessions.archive(created.id);
	await assert.rejects(sessions.stopJob(created.id, "tests"), NotFound);
	assert.deepEqual(worker.stoppedJobs, ["tests", "ended"]);
});

test("idle unwatched kernels without subprocesses park, and reopen only after releasing storage", async (t) => {
	const f = await fixture(t);
	const idleParkMs = 60_000;
	const sessions = await f.manager({}, { idleParkMs });
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await until(() => sessions.get(created.id)?.state === "working");
	let now = Date.now() + idleParkMs + 1;
	t.mock.method(Date, "now", () => now);
	await sessions["parkIdleWorkers"]();
	assert.equal(sessions.get(created.id)?.state, "working", "working kernels never park");
	await sessions.stop(created.id);
	await sessions["starting"].get(created.id);
	await until(() => sessions.get(created.id)?.state === "idle");
	now += idleParkMs + 1;
	const first = f.workers[0]!;
	const off = sessions.subscribe(created.id, () => {});
	now += idleParkMs + 1;
	await sessions["parkIdleWorkers"]();
	assert.equal(first.closed, false, "a viewer keeps the kernel open");
	first.children = true;
	off();
	now += idleParkMs + 1;
	await sessions["parkIdleWorkers"]();
	assert.equal(first.closed, false, "background jobs and subagents keep the kernel open");
	const release = deferred();
	try {
		first.closeGate = release.promise;
		first.children = false;
		await sessions["parkIdleWorkers"]();
		assert.equal(sessions.get(created.id)?.state, "parked");
		assert.equal(first.closed, true);
		const events: AgentEvent[][] = [];
		sessions.subscribe(created.id, (batch) => events.push(batch));
		assert.equal(f.workers.length, 1, "viewing parked history never reopens the kernel");
		const waiting = deferred();
		const unparked = sessions["unparked"].bind(sessions);
		t.mock.method(sessions as unknown as { unparked(id: string): Promise<void> }, "unparked", async (id: string) => {
			waiting.resolve();
			await unparked(id);
		});
		const sending = sessions.send(created.id, "resume work");
		await waiting.promise;
		assert.equal(f.workers.length, 1, "explicit execution waits for the parked kernel to release its lease");
		release.resolve();
		await sending;
		await until(() => f.workers.length === 2 && sessions.get(created.id)?.state === "working");
		assert.equal(sessions["aiUsage"].summary(created.id, true)?.efficiency?.relaunch.reasons.parked_wake, 1);
		await until(() => events.some((batch) => batch.some((event) => event.type === "snapshot")));
		assert.equal((await f.stored(created.id)).failure, undefined);
		assert.equal(sessions.get(created.id)?.error, undefined);
	} finally {
		release.resolve();
	}
});

test("malformed preparing metadata never removes or runs in the source directory", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	const created = await sessions.spawn({ cwd: f.source, message: "corrupted destination" });
	await sessions.shutdown();
	const opened = f.workers.length;
	const file = join(f.home, "sessions", created.id, "meta.json");
	const meta = await f.stored(created.id);
	meta.preparing = { source: f.source };
	await writeFile(file, JSON.stringify(meta));
	await writeFile(join(f.source, "keep"), "source untouched");
	const reopened = await f.manager({
		workspace: async () => {
			throw new Error("must not clone");
		},
	});
	await until(() => reopened.get(created.id)?.state === "failed");
	assert.match(reopened.get(created.id)!.error!, /Invalid session workspace destination/);
	assert.equal(await readFile(join(f.source, "keep"), "utf8"), "source untouched");
	assert.equal(f.workers.length, opened);
});

test("legacy persisted outcomes do not leak through HTTP or initial WebSocket session lists", async (t) => {
	const f = await fixture(t);
	const id = randomUUID();
	await mkdir(join(f.home, "sessions", id), { recursive: true });
	await writeFile(
		join(f.home, "sessions", id, "meta.json"),
		JSON.stringify({
			id,
			cwd: f.source,
			title: "Legacy",
			createdAt: 1,
			updatedAt: 2,
			outcome: "needs_input",
			outcomeAt: 42,
			outcomeReason: "Approval",
		}),
	);
	const sessions = await f.manager();
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		sessions,
		f.projects,
		{} as ModelCatalog,
		{} as TerminalManager,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	let ws: WebSocket | undefined;
	t.after(
		() =>
			new Promise<void>((resolve) => {
				ws?.terminate();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const single = (await (await fetch(`${url}/api/sessions/${id}`)).json()) as SessionSummary;
	const list = (await (await fetch(`${url}/api/sessions`)).json()) as SessionSummary[];
	const messages: { type: string; sessions?: SessionSummary[] }[] = [];
	ws = new WebSocket(`${url.replace("http", "ws")}/api/ws`);
	ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
	await until(() => messages.some((message) => message.type === "sessions"));
	const initial = messages.find((message) => message.type === "sessions")!.sessions![0]!;
	for (const summary of [single, list[0]!, initial]) {
		assert.equal(summary.outcome, "done");
		assert.equal(summary.outcomeAt, 42);
		assert.equal(summary.outcomeReason, undefined);
		assert.equal(summary.updatedAt, 2);
		assert.equal(summary.state, "parked");
	}
	assert.equal(f.workers.length, 0);
});

test("metadata with a mismatched session ID is skipped instead of trusted", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	const created = await sessions.spawn({ cwd: f.source, message: "wrong id" });
	await sessions.shutdown();
	const opened = f.workers.length;
	const meta = { ...(await f.stored(created.id)), id: "../source" };
	await writeFile(join(f.home, "sessions", created.id, "meta.json"), JSON.stringify(meta));
	const warning = mock.method(console, "warn", () => {});
	t.after(() => warning.mock.restore());
	const reopened = await f.manager();
	assert.deepEqual(reopened.list(), []);
	assert.equal(warning.mock.callCount(), 1);
	assert.equal(f.workers.length, opened);
});

for (const phase of ["runtime", "initializing"] as const) {
	test(`rejected ${phase} input does not disable Stop or valid sends and is not replayed`, async (t) => {
		const f = await fixture(t);
		const sessions = await f.manager({
			worker: f.workerFactory(phase !== "initializing", async (command) => {
				if (command.type === "input" && command.content === "invalid")
					throw new CommandRejected("input expansion rejected");
			}),
		});
		const created = await sessions.spawn({ cwd: f.source, message: "working initial" });
		if (phase === "runtime") {
			await until(() => sessions.get(created.id)?.state === "working");
			await assert.rejects(
				sessions.send(created.id, "invalid", "followUp", "invalid-id"),
				/input expansion rejected/,
			);
		} else {
			await sessions.send(created.id, "invalid", "followUp", "invalid-id");
			await until(() => f.workers.length === 1);
			f.workers[0]!.open();
			await until(
				() =>
					sessions.get(created.id)?.error === "input expansion rejected" &&
					sessions.get(created.id)?.state === "working",
			);
		}
		assert.equal((await f.stored(created.id)).failure, undefined);
		assert.deepEqual((await f.stored(created.id)).pending, []);
		await sessions.stop(created.id);
		assert.equal(f.workers[0]!.requests.at(-1)?.type, "abort");
		await sessions.send(created.id, "valid later", "followUp", "valid-id");
		assert.equal(sessions.get(created.id)?.state, "working");
		assert.equal(sessions.get(created.id)?.error, undefined);
		await sessions.shutdown();
		const reopened = await f.manager();
		await until(() => f.workers.length === 2);
		await until(() => reopened.get(created.id)?.state !== "starting");
		assert.equal(f.workers[1]!.requests.length, 0);
	});
}

test("explicitly rejected initial input is visibly failed but remains usable for Stop and retry", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({
		worker: f.workerFactory(true, async (command) => {
			if (command.type === "input" && command.content === "invalid")
				throw new CommandRejected("initial input rejected");
		}),
	});
	const created = await sessions.spawn({ cwd: f.source, message: "invalid" });
	await until(() => sessions.get(created.id)?.state === "failed");
	assert.equal((await f.stored(created.id)).failure, undefined);
	assert.deepEqual((await f.stored(created.id)).pending, []);
	await sessions.stop(created.id);
	assert.equal(f.workers[0]!.requests.at(-1)?.type, "abort");
	await sessions.send(created.id, "fixed");
	assert.equal(sessions.get(created.id)?.state, "working");
});

test("uncertain admission after transport failure retains the request ID for restart", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({
		worker: f.workerFactory(true, async () => {
			throw new Error("disconnected before acknowledgement");
		}),
	});
	const created = await sessions.spawn({ cwd: f.source, message: "retry safely" });
	await until(() => sessions.get(created.id)?.state === "failed");
	const before = await f.stored(created.id);
	assert.equal(before.failure, undefined);
	assert.equal(before.pending.length, 1);
	await sessions.shutdown();
	const reopened = await f.manager();
	await until(() => reopened.get(created.id)?.state === "working");
	assert.deepEqual(f.workers[1]!.requests, before.pending);
});

for (const recovery of ["restart", "demand", "automatic"] as const) {
	test(`unexpected live kernel failure after durable admission recovers by ${recovery} without duplicates`, async (t) => {
		const f = await fixture(t);
		const warning = mock.method(console, "warn", () => {});
		t.after(() => warning.mock.restore());
		const acknowledgement = deferred();
		const accepted = new Set<string>();
		let attempts = 0;
		let admissions = 0;
		const admit = async (command: Command) => {
			if (!accepted.has(command.requestId)) {
				accepted.add(command.requestId);
				admissions++;
			}
			if (++attempts === 1) await acknowledgement.promise;
		};
		const sessions = await f.manager(
			{ worker: f.workerFactory(true, admit) },
			{ kernelRestartBackoffMs: recovery === "automatic" ? 1 : 15_000 },
		);
		const created = await sessions.spawn({ cwd: f.source, message: "admitted before crash" });
		await until(() => admissions === 1);
		const before = await f.stored(created.id);
		f.workers[0]!.crash();
		acknowledgement.reject(new Error("IPC disconnected before acknowledgement"));
		await until(() => sessions.get(created.id)?.state !== "starting");
		assert.equal((await f.stored(created.id)).failure, undefined);
		assert.deepEqual((await f.stored(created.id)).pending, before.pending);
		let recovered = sessions;
		if (recovery === "restart") {
			await sessions.shutdown();
			recovered = await f.manager({ worker: f.workerFactory(true, admit) });
		} else if (recovery === "demand") sessions.subscribe(created.id, () => {});
		await until(() => recovered.get(created.id)?.state === "working");
		assert.equal(admissions, 1);
		assert.equal(attempts, 2);
		assert.deepEqual(f.workers[1]!.requests, before.pending);
		assert.equal(recovered["aiUsage"].summary(created.id, true)?.efficiency?.relaunch.reasons.crash_recovery, 1);
		await until(async () => (await f.stored(created.id)).pending.length === 0);
		assert.deepEqual((await f.stored(created.id)).pending, []);
	});
}

test("a kernel crash without queued input stays usable and backs off automatic restarts", async (t) => {
	const f = await fixture(t);
	const warning = mock.method(console, "warn", () => {});
	t.after(() => warning.mock.restore());
	const sessions = await f.manager({}, { kernelRestartBackoffMs: 100 });
	const created = await sessions.spawn({ cwd: f.source, message: "before crash" });
	await sessions["starting"].get(created.id);
	assert.deepEqual((await f.stored(created.id)).pending, []);
	f.workers[0]!.crash();
	await until(() => sessions.get(created.id)?.state === "parked");
	assert.equal(sessions.get(created.id)?.error, "IPC connection failed");
	assert.equal((await f.stored(created.id)).inputError, undefined, "nothing was uncertain");
	assert.equal(sessions.canSendNotice(created.id), false, "automatic work waits after a crash");
	// User input is never delayed, and a fresh kernel clears the crash.
	await sessions.send(created.id, "after crash");
	assert.equal(f.workers.length, 2);
	assert.equal(sessions["aiUsage"].summary(created.id, true)?.efficiency?.relaunch.reasons.crash_recovery, 1);
	assert.equal(sessions.get(created.id)?.state, "working");
	assert.equal(sessions.get(created.id)?.error, undefined);
	f.workers[1]!.crash();
	const backoff = sessions["kernelFailures"].get(created.id)!;
	assert.equal(backoff.failures, 2);
	assert.ok(backoff.until - backoff.at >= 200, "consecutive failures double the wait");
});

test("an interrupted run reopens automatically after backoff without submitting a second input", async (t) => {
	const f = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	t.mock.method(console, "warn", () => {});
	const sessions = await f.manager({}, { kernelRestartBackoffMs: 100 });
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await sessions["starting"].get(created.id);
	assert.deepEqual((await f.stored(created.id)).pending, []);
	f.workers[0]!.crash();
	assert.equal(sessions["metas"].get(created.id)?.kernelRestartPending, true);
	assert.deepEqual(sessions.prepareUpdate(), { ready: false }, "interrupted work still blocks an idle-only update");
	const meta = sessions["metas"].get(created.id)!;
	assert.throws(() => sessions["assertModelIdle"](meta), /must be idle/);
	assert.throws(() => sessions["assertWorkspaceQuiescent"](meta), /Session is in use/);
	assert.equal(sessions.canSendNotice(created.id), false);
	t.mock.timers.tick(99);
	await Promise.resolve();
	assert.equal(f.workers.length, 1);
	t.mock.timers.tick(1);
	await until(() => f.workers.length === 2);
	await sessions["starting"].get(created.id);
	assert.equal(f.workers[1]!.spec.storageDir, f.workers[0]!.spec.storageDir);
	assert.deepEqual(f.workers[1]!.requests, [], "the Harness resumes durable work; the daemon never resubmits it");
	assert.equal(sessions["metas"].get(created.id)?.kernelRestartPending, undefined);
	// A late exit cannot touch its replacement or schedule another restart.
	sessions["onExit"](sessions["metas"].get(created.id)!, f.workers[0]!, 1);
	assert.equal(sessions.get(created.id)?.state, "idle");
});

for (const pause of ["sleep", "update", "shutdown"] as const) {
	test(`automatic crash recovery respects ${pause} and keeps durable recovery intent`, async (t) => {
		const f = await fixture(t);
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		t.mock.method(console, "warn", () => {});
		const sessions = await f.manager({}, { kernelRestartBackoffMs: 100 });
		const created = await sessions.spawn({ cwd: f.source, message: "work" });
		await sessions["starting"].get(created.id);
		f.workers[0]!.crash();
		if (pause === "sleep") await sessions.pauseForSleep();
		else if (pause === "update") sessions.pauseForUpdate();
		else await sessions.shutdown();
		t.mock.timers.tick(100);
		// Drain the timer's promise continuations, not a wall-clock delay.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		assert.equal(f.workers.length, 1);
		assert.equal(sessions["metas"].get(created.id)?.kernelRestartPending, true);
		if (pause === "sleep") await sessions.resumeAfterSleep();
		else if (pause === "update") t.mock.timers.tick(30_000);
		else {
			const reopened = await f.manager();
			await until(() => f.workers.length === 2);
			await reopened["starting"].get(created.id);
		}
		if (pause !== "shutdown") {
			await until(() => f.workers.length === 2);
			await sessions["starting"].get(created.id);
		}
	});
}

test("Stop during crash backoff aborts durable work without later automatic input", async (t) => {
	const f = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	t.mock.method(console, "warn", () => {});
	const sessions = await f.manager({}, { kernelRestartBackoffMs: 100 });
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await sessions["starting"].get(created.id);
	f.workers[0]!.crash();
	await sessions.stop(created.id);
	await sessions["starting"].get(created.id);
	assert.equal(f.workers.length, 2);
	assert.deepEqual(
		f.workers[1]!.requests.map((command) => command.type),
		["abort"],
	);
	t.mock.timers.tick(10_000);
	for (let i = 0; i < 10; i++) await Promise.resolve();
	assert.equal(f.workers.length, 2);
	assert.equal(sessions["metas"].get(created.id)?.kernelRestartPending, undefined);
	assert.equal(sessions.get(created.id)?.state, "idle");
});

test("an idle kernel crash does not schedule a new run", async (t) => {
	const f = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	t.mock.method(console, "warn", () => {});
	const sessions = await f.manager({}, { kernelRestartBackoffMs: 100 });
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await sessions["starting"].get(created.id);
	await sessions.stop(created.id);
	f.workers[0]!.crash();
	t.mock.timers.tick(10_000);
	assert.equal(f.workers.length, 1);
	assert.equal(sessions["metas"].get(created.id)?.kernelRestartPending, undefined);
});

test("a fresh kernel clears a stale input error when nothing is queued", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "hello" });
	await until(() => sessions.get(created.id)?.state === "working");
	await sessions.shutdown();
	const file = join(f.home, "sessions", created.id, "meta.json");
	await writeFile(file, JSON.stringify({ ...(await f.stored(created.id)), inputError: "Kernel IPC disconnected" }));
	// Durable work resumes on load. Its ready kernel proves the old IPC failure no longer applies.
	const reopened = await f.manager();
	await until(() => reopened.get(created.id)?.state === "idle");
	assert.equal(reopened.get(created.id)?.error, undefined);
	await until(async () => (await f.stored(created.id)).inputError === undefined);
});

// Exercise supervision without forking a kernel or loading a model.
type Meta = Parameters<SessionManager["save"]>[0];
type Worker = Parameters<SessionManager["onPacket"]>[1];
const fakeWorker = (_exitCode: number | null = null): Worker => ({
	ready: Promise.resolve(),
	state: "idle",
	send: () => {},
	request: async () => {},
	close: async () => {},
});

async function outcomeFixture(run: (manager: SessionManager, meta: Meta, home: string) => Promise<void>) {
	const home = await mkdtemp(join(tmpdir(), "pilot-outcomes-"));
	const manager = new SessionManager(home, new ProjectStore(home));
	const meta: Meta = { id: randomUUID(), title: "Session", cwd: home, createdAt: 1, updatedAt: 1 };
	try {
		await manager.load();
		await mkdir(join(home, "sessions", meta.id));
		await manager["save"](meta);
		await run(manager, meta, home);
	} finally {
		await manager.shutdown();
		await rm(home, { recursive: true, force: true });
	}
}

async function flush(manager: SessionManager) {
	await Promise.all(manager["saving"].values());
}

test("live job snapshots clear on worker exit and daemon restart, ignoring a replaced worker", async () => {
	await outcomeFixture(async (manager, meta, home) => {
		const worker = fakeWorker();
		manager["workers"].set(meta.id, worker);
		const jobs = [
			{ id: "tests", name: "Tests", state: "running" as const, startedAt: 1, outputPath: "/tmp/tests.log" },
		];
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs });
		assert.deepEqual(manager.get(meta.id)?.runningJobs, jobs);
		assert.equal(manager.get(meta.id)?.working, true);
		await manager["save"](meta);
		const reopened = new SessionManager(home, new ProjectStore(home));
		await reopened.load();
		try {
			assert.equal(reopened.get(meta.id)?.runningJobs, undefined);
			assert.equal(reopened.get(meta.id)?.attentionReason, undefined);
			assert.equal(reopened.get(meta.id)?.attentionAt, undefined);
			assert.equal(reopened.get(meta.id)?.working, false);
		} finally {
			await reopened.shutdown();
		}
		manager["onExit"](meta, worker, 0);
		assert.equal(manager.get(meta.id)?.runningJobs, undefined);
		assert.equal(manager.get(meta.id)?.working, false);
		const replacement = fakeWorker();
		manager["workers"].set(meta.id, replacement);
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs });
		assert.equal(manager.get(meta.id)?.runningJobs, undefined);
		manager["onPacket"](meta, replacement, { type: "jobs.changed", jobs });
		assert.deepEqual(manager.get(meta.id)?.runningJobs, jobs);
		replacement.state = "failed";
		manager["onExit"](meta, replacement, 1);
		assert.equal(manager.get(meta.id)?.runningJobs, undefined);
		assert.equal(manager.get(meta.id)?.outcome, "failed");
		assert.equal(manager.get(meta.id)?.working, false);
	});
});

test("compaction shows the chat as working and keeps its last result", async () => {
	await outcomeFixture(async (manager, meta) => {
		const worker = fakeWorker();
		manager["workers"].set(meta.id, worker);
		const changes: SessionSummary[] = [];
		manager.onChange((summary) => changes.push(summary));
		manager["onPacket"](meta, worker, { type: "working", working: true });
		manager["onPacket"](meta, worker, {
			type: "working",
			working: false,
			completion: { outcome: "done", outcomeAt: 10 },
		});
		assert.equal(manager.get(meta.id)?.outcome, "done");
		worker.compacting = true;
		manager["onPacket"](meta, worker, { type: "compacting", compacting: true });
		assert.equal(changes.at(-1)?.state, "working");
		assert.equal(changes.at(-1)?.working, true);
		worker.compacting = false;
		manager["onPacket"](meta, worker, { type: "compacting", compacting: false });
		assert.equal(changes.at(-1)?.state, "idle");
		assert.equal(changes.at(-1)?.working, false);
		assert.equal(changes.at(-1)?.outcome, "done", "compaction is not a new result");
	});
});

test("long jobs emit live user attention at one hour and clear on job end or worker exit", async (t) => {
	await outcomeFixture(async (manager, meta) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
		const worker = fakeWorker();
		manager["workers"].set(meta.id, worker);
		const changes: SessionSummary[] = [];
		manager.onChange((summary) => changes.push(summary));
		const job = {
			id: "tests",
			name: "Tests",
			state: "running" as const,
			startedAt: 1_000,
			outputPath: "/tmp/tests.log",
		};
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs: [job] });
		t.mock.timers.tick(3_599_999);
		assert.equal(changes.at(-1)?.attentionReason, undefined);
		t.mock.timers.tick(1);
		assert.deepEqual(changes.at(-1)?.attentionReason, { kind: "long_job", detail: "Tests has run for 1h" });
		assert.equal(changes.at(-1)?.attentionAt, 3_601_000);
		assert.equal(changes.at(-1)?.working, true);
		assert.equal(changes.at(-1)?.outcome, undefined);
		assert.equal(meta.outcome, undefined);
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs: [] });
		assert.equal(changes.at(-1)?.attentionReason, undefined, "end/stop clears immediately, before the follow-up");
		assert.equal(changes.at(-1)?.working, true);
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs: [job] });
		assert.equal(changes.at(-1)?.attentionReason?.kind, "long_job", "overdue snapshots escalate immediately");
		manager["onExit"](meta, worker, 0);
		assert.equal(manager.get(meta.id)?.attentionReason, undefined);
		const replacement = fakeWorker();
		manager["workers"].set(meta.id, replacement);
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs: [job] });
		assert.equal(manager.get(meta.id)?.attentionReason, undefined, "late packets cannot restore old attention");
		const fresh = { ...job, startedAt: Date.now() };
		manager["onPacket"](meta, replacement, { type: "jobs.changed", jobs: [fresh] });
		const count = changes.length;
		await manager.shutdown();
		t.mock.timers.tick(3_600_000);
		assert.equal(changes.length, count, "shutdown releases live deadlines");
		t.mock.timers.reset();
	});
});

test("suspected tool stalls ask for diagnosis while waits and pauses remain distinct", async () => {
	await outcomeFixture(async (manager, meta) => {
		const worker = fakeWorker();
		worker.state = "working";
		manager["workers"].set(meta.id, worker);
		const now = Date.now();
		const stalled = {
			enabled: true,
			observedAt: now,
			dropped: 0,
			calls: [
				{
					ref: "abcdef012345-1",
					category: "mcp" as const,
					nested: true,
					state: "running" as const,
					startedAt: now - 700_000,
					progressAt: now - 700_000,
					livenessAt: now,
				},
			],
		};
		manager["onPacket"](meta, worker, { type: "tool.activity", activity: stalled });
		assert.equal(manager.get(meta.id)?.attentionReason?.kind, "tool_stall");
		assert.match(manager.get(meta.id)?.attentionReason?.detail ?? "", /no useful progress/);
		manager["onPacket"](meta, worker, {
			type: "jobs.changed",
			jobs: [{ id: "build", name: "Build", state: "running", startedAt: now - 3_700_000, outputPath: "/tmp/build" }],
		});
		assert.equal(manager.get(meta.id)?.attentionReason?.kind, "long_job", "known jobs keep their distinct reason");
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs: [] });

		meta.updatePaused = true;
		assert.equal(manager.get(meta.id)?.attentionReason, undefined, "an update pause is not reported as a tool stall");
		delete meta.updatePaused;

		manager["onPacket"](meta, worker, {
			type: "tool.activity",
			activity: {
				...stalled,
				calls: [{ ...stalled.calls[0]!, waitKind: "user" as const, livenessAt: now, progressAt: now - 700_000 }],
			},
		});
		assert.equal(
			manager.get(meta.id)?.attentionReason,
			undefined,
			"an explicit user wait stays visible only as evidence",
		);

		manager["onPacket"](meta, worker, {
			type: "tool.activity",
			activity: {
				...stalled,
				calls: [
					{
						...stalled.calls[0]!,
						state: "cancelling" as const,
						cancelRequestedAt: now - 31_000,
						progressAt: now,
						livenessAt: now,
					},
				],
			},
		});
		assert.match(manager.get(meta.id)?.attentionReason?.detail ?? "", /cancellation was requested/);

		manager["onPacket"](meta, worker, {
			type: "tool.activity",
			activity: { ...stalled, calls: [] },
		});
		assert.equal(manager.get(meta.id)?.attentionReason, undefined);

		manager["onPacket"](meta, worker, { type: "tool.activity", activity: stalled });
		worker.state = "failed";
		manager["onExit"](meta, worker, 0);
		assert.notEqual(
			manager.get(meta.id)?.attentionReason?.kind,
			"tool_stall",
			"a dead worker is not a live tool stall",
		);
	});
});

test("chats that reach for an MCP server needing sign-in ask for it until it works or the chat is archived", async () => {
	await outcomeFixture(async (manager, meta) => {
		let status: McpStatus = {
			checking: false,
			servers: [{ name: "datadog", transport: "http", state: "needs_sign_in", canSignIn: true }],
		};
		const listeners = new Set<(status: McpStatus) => void>();
		manager.setMcpStatus({
			status: () => status,
			check: () => {},
			onChange: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		});
		const worker = fakeWorker();
		manager["workers"].set(meta.id, worker);
		const changes: SessionSummary[] = [];
		manager.onChange((summary) => changes.push(summary));
		const packet = { type: "mcp.used" as const, namespaces: ["datadog"], failed: true };
		manager["onPacket"](meta, fakeWorker(), packet);
		assert.equal(manager.get(meta.id)?.attentionReason, undefined, "a replaced worker's hint is ignored");
		manager["onPacket"](meta, worker, packet);
		assert.deepEqual(changes.at(-1)?.attentionReason, {
			kind: "mcp",
			detail: "datadog needs sign-in",
			server: "datadog",
		});
		assert.equal(typeof changes.at(-1)?.attentionAt, "number");
		assert.equal(meta.outcome, undefined, "never an agent outcome");

		status = { checking: false, servers: [{ ...status.servers[0]!, state: "connected", tools: 2 }] };
		for (const listener of listeners) listener(status);
		assert.equal(changes.at(-1)?.attentionReason, undefined, "signing in releases the chat at once");

		status = { checking: false, servers: [{ ...status.servers[0]!, state: "needs_sign_in" }] };
		manager["onPacket"](meta, worker, packet);
		assert.equal(manager.get(meta.id)?.attentionReason?.kind, "mcp");
		await manager.archive(meta.id);
		assert.equal(manager.get(meta.id)?.attentionReason, undefined);
	});
});

test("a scheduled follow-up message marks its chat until the schedule leaves", async () => {
	await outcomeFixture(async (manager, meta) => {
		let ids = new Set<string>();
		const listeners = new Set<() => void>();
		manager.setScheduledMessages({
			scheduledMessageSessions: () => ids,
			onChange: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		});
		const changes: SessionSummary[] = [];
		manager.onChange((summary) => changes.push(summary));
		assert.equal(manager.get(meta.id)?.scheduledMessage, undefined);
		ids = new Set([meta.id]);
		for (const listener of listeners) listener();
		assert.equal(changes.at(-1)?.scheduledMessage, true);
		const count = changes.length;
		for (const listener of listeners) listener();
		assert.equal(changes.length, count, "unchanged schedules publish nothing");
		ids = new Set();
		for (const listener of listeners) listener();
		assert.equal(changes.at(-1)?.scheduledMessage, undefined);
	});
});

test("idle jobs and their follow-up stay working without publishing an intermediate outcome", async () => {
	await outcomeFixture(async (manager, meta, home) => {
		const worker = { ...fakeWorker(), busy: false };
		manager["workers"].set(meta.id, worker);
		const changes: SessionSummary[] = [];
		manager.onChange((summary) => changes.push(summary));
		const completion: SessionCompletion = { outcome: "done", outcomeAt: 42 };
		const jobs = [
			{ id: "tests", name: "Tests", state: "running" as const, startedAt: 1, outputPath: "/tmp/tests.log" },
		];
		worker.state = "working";
		manager["onPacket"](meta, worker, { type: "working", working: true });
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs });
		worker.state = "idle";
		manager["onPacket"](meta, worker, { type: "working", working: false, completion });
		assert.equal(manager.get(meta.id)?.state, "idle");
		assert.equal(manager.get(meta.id)?.working, true);
		assert.equal(meta.outcome, undefined);
		// Removing the last job does not finish the chat, nor does a replay of its earlier completion.
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs: [] });
		manager["onPacket"](meta, worker, { type: "working", working: false, completion });
		assert.equal(manager.get(meta.id)?.working, true);
		manager["lastUse"].set(meta.id, 0);
		assert.equal(manager["parkable"](meta, worker), false);
		assert.ok(
			changes.every(
				(summary) => summary.working && summary.outcome === undefined && summary.outcomeAt === undefined,
			),
		);
		await flush(manager);
		const stored = JSON.parse(await readFile(join(home, "sessions", meta.id, "meta.json"), "utf8"));
		assert.equal(stored.outcome, undefined, "the intermediate outcome is never persisted");
		assert.equal(stored.lastCompletionAt, 42);
		const reopened = new SessionManager(home, new ProjectStore(home));
		await reopened.load();
		try {
			const freshWorker = fakeWorker();
			reopened["workers"].set(meta.id, freshWorker);
			reopened["onPacket"](reopened["metas"].get(meta.id)!, freshWorker, {
				type: "ready",
				model: "test/model",
				working: false,
				usage: {},
				completion,
			});
			assert.equal(reopened.get(meta.id)?.outcome, undefined, "restart cannot resurrect the job-waiting result");
			assert.equal(reopened.get(meta.id)?.working, false, "live jobs are never restored from metadata");
		} finally {
			await reopened.shutdown();
		}
		worker.state = "working";
		manager["onPacket"](meta, worker, { type: "working", working: true });
		worker.state = "idle";
		manager["onPacket"](meta, worker, {
			type: "working",
			working: false,
			completion: { outcome: "done", outcomeAt: 43 },
		});
		assert.equal(manager.get(meta.id)?.working, false);
		assert.equal(manager.get(meta.id)?.outcome, "done");
		assert.equal(manager.get(meta.id)?.outcomeAt, 43);
		manager["lastUse"].set(meta.id, 0);
		assert.equal(manager["parkable"](meta, worker), true);
		assert.equal(changes.filter((summary) => summary.outcome).length, 1);
	});
});

test("a question needs the user while jobs keep running", async () => {
	await outcomeFixture(async (manager, meta) => {
		const worker = fakeWorker();
		manager["workers"].set(meta.id, worker);
		const jobs = [
			{ id: "tests", name: "Tests", state: "running" as const, startedAt: 1, outputPath: "/tmp/tests.log" },
		];
		worker.state = "working";
		manager["onPacket"](meta, worker, { type: "working", working: true });
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs });
		worker.state = "idle";
		manager["onPacket"](meta, worker, {
			type: "working",
			working: false,
			completion: { outcome: "question", outcomeAt: 42, outcomeReason: "Which branch?" },
		});
		assert.equal(manager.get(meta.id)?.working, false);
		assert.equal(manager.get(meta.id)?.outcome, "question");
		assert.deepEqual(manager.get(meta.id)?.runningJobs, jobs);
		// Job progress and the end of the last job leave the question in place.
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs });
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs: [] });
		assert.equal(manager.get(meta.id)?.working, false);
		assert.equal(manager.get(meta.id)?.outcome, "question");
		// The answer starts a new turn.
		worker.state = "working";
		manager["onPacket"](meta, worker, { type: "working", working: true });
		assert.equal(manager.get(meta.id)?.working, true);
		assert.equal(manager.get(meta.id)?.outcome, undefined);
	});
});

test("jobs that end during a turn allow that turn's final outcome", async () => {
	await outcomeFixture(async (manager, meta) => {
		const worker = fakeWorker();
		manager["workers"].set(meta.id, worker);
		manager["onPacket"](meta, worker, { type: "working", working: true });
		manager["onPacket"](meta, worker, {
			type: "jobs.changed",
			jobs: [{ id: "tests", name: "Tests", state: "running", startedAt: 1, outputPath: "/tmp/tests.log" }],
		});
		manager["onPacket"](meta, worker, { type: "jobs.changed", jobs: [] });
		manager["onPacket"](meta, worker, {
			type: "working",
			working: false,
			completion: { outcome: "done", outcomeAt: 42 },
		});
		assert.equal(manager.get(meta.id)?.working, false);
		assert.equal(manager.get(meta.id)?.outcomeAt, 42);
	});
});

test("ready and working completions survive restart parked, replay does not change completion version", async () => {
	await outcomeFixture(async (manager, meta, home) => {
		const worker = fakeWorker();
		const changes: SessionSummary[] = [];
		manager.onChange((summary) => changes.push(summary));
		const completion: SessionCompletion = { outcome: "done", outcomeAt: 42, outcomeReason: "Approval" };
		manager["onPacket"](meta, worker, { type: "ready", model: "test/model", working: false, usage: {}, completion });
		await flush(manager);
		const reopened = new SessionManager(home, new ProjectStore(home));
		await reopened.load();
		assert.equal(reopened.get(meta.id)?.state, "parked");
		assert.equal(reopened.get(meta.id)?.outcome, "done");
		assert.equal(reopened.get(meta.id)?.outcomeAt, 42);
		assert.equal(reopened.get(meta.id)?.outcomeReason, "Approval");
		assert.equal(reopened["workers"].size, 0);
		manager["onPacket"](meta, worker, { type: "working", working: false, completion });
		assert.equal(meta.outcomeAt, 42);
		manager["onPacket"](meta, worker, { type: "working", working: true });
		assert.equal(manager.get(meta.id)?.outcome, undefined);
		assert.equal(manager.get(meta.id)?.outcomeAt, undefined);
		assert.equal(manager.get(meta.id)?.outcomeReason, undefined);
		manager["onPacket"](meta, worker, { type: "working", working: false });
		assert.equal(meta.outcome, undefined, "idle alone cannot imply done");
		manager["onPacket"](meta, worker, {
			type: "working",
			working: false,
			completion: { outcome: "stopped", outcomeAt: 43 },
		});
		await flush(manager);
		const stopped = new SessionManager(home, new ProjectStore(home));
		await stopped.load();
		assert.equal(stopped.get(meta.id)?.outcome, "stopped");
		assert.equal(stopped.get(meta.id)?.outcomeAt, 43);
		assert.equal(stopped.get(meta.id)?.outcomeReason, undefined);
		assert.equal(changes.at(-1)?.outcome, "stopped");
	});
});

for (const shutdownError of [false, true]) {
	test(`parking a real worker preserves completion through disconnect (shutdown error: ${shutdownError})`, async () => {
		await outcomeFixture(async (manager, meta, home) => {
			const child = new IpcProcess();
			const worker = new KernelWorker(
				{ sessionId: meta.id, cwd: home, storageDir: home },
				(packet) => manager["onPacket"](meta, worker, packet),
				(exited, code, signal) => manager["onExit"](meta, exited, code, signal),
				undefined,
				{ child: child as unknown as ChildProcess },
			);
			manager["workers"].set(meta.id, worker);
			child.emit("message", {
				type: "ready",
				model: "test/model",
				working: false,
				usage: {},
				completion: { outcome: "done", outcomeAt: 42 },
			});
			const watch = child.sent.findLast((command) => command.type === "watch");
			assert.ok(watch?.type === "watch");
			child.emit("message", { type: "events", watchId: watch.watchId, events: [snapshot] });
			worker.hasChildren = async () => false;
			manager["lastUse"].set(meta.id, 0);
			const changes: SessionSummary[] = [];
			manager.onChange((summary) => changes.push(summary));
			await manager["parkIdleWorkers"]();
			assert.equal(child.sent.at(-1)?.type, "shutdown");
			if (shutdownError) child.emit("message", { type: "error", message: "Shutdown failed: cleanup" });
			child.connected = false;
			child.emit("disconnect");
			child.emit("exit", shutdownError ? 1 : 0, null);
			await manager["unparked"](meta.id);
			await flush(manager);
			assert.deepEqual(child.killed, []);
			assert.ok(changes.length > 0);
			for (const summary of changes) {
				assert.equal(summary.state, "parked");
				assert.equal(summary.outcome, "done");
				assert.equal(summary.outcomeAt, 42);
				assert.equal(summary.error, undefined);
			}
			const reopened = new SessionManager(home, new ProjectStore(home));
			try {
				await reopened.load();
				assert.equal(reopened.get(meta.id)?.outcome, "done");
				assert.equal(reopened.get(meta.id)?.outcomeAt, 42);
				assert.equal(reopened.get(meta.id)?.state, "parked");
				assert.equal(reopened.get(meta.id)?.error, undefined);
			} finally {
				await reopened.shutdown();
			}
		});
	});
}

test("errors and fatal exits persist failures, keeping the original error when its worker exits", async () => {
	await outcomeFixture(async (manager, meta, home) => {
		const worker = fakeWorker();
		worker.state = "failed";
		manager["onPacket"](meta, worker, { type: "error", message: "Missing credentials" });
		const version = meta.outcomeAt;
		manager["onExit"](meta, worker, 1, null);
		await flush(manager);
		assert.equal(meta.outcome, "failed");
		assert.equal(meta.outcomeAt, version);
		assert.equal(meta.outcomeReason, "Missing credentials");
		const reopened = new SessionManager(home, new ProjectStore(home));
		await reopened.load();
		assert.equal(reopened.get(meta.id)?.outcomeReason, "Missing credentials");
		manager["onPacket"](meta, worker, { type: "working", working: true });
		manager["onExit"](meta, fakeWorker(), null, "SIGKILL");
		assert.ok(meta.outcomeAt! > version!);
		assert.equal(meta.outcomeReason, "Kernel exited with signal SIGKILL");
	});
});

test("request errors do not complete active work or prevent restart resumption", async () => {
	await outcomeFixture(async (manager, meta, home) => {
		const worker = fakeWorker();
		worker.state = "working";
		manager["workers"].set(meta.id, worker);
		manager["onPacket"](meta, worker, { type: "working", working: true });
		worker.error = "Input admission rejected";
		manager["onPacket"](meta, worker, { type: "error", requestId: "input", message: worker.error });
		assert.equal(meta.working, true);
		assert.equal(meta.outcome, undefined);
		assert.equal(manager.get(meta.id)?.state, "working");
		assert.equal(manager.get(meta.id)?.error, worker.error);
		manager["workers"].delete(meta.id);
		await flush(manager);
		const reopened = new SessionManager(home, new ProjectStore(home));
		const resumed: string[] = [];
		reopened["ensureWorker"] = async (id) => {
			resumed.push(id);
			return fakeWorker();
		};
		try {
			await reopened.load();
			assert.deepEqual(resumed, [meta.id]);
			assert.equal(reopened.get(meta.id)?.outcome, undefined);
		} finally {
			// Drain its metadata writes before the fixture removes the directory.
			await reopened.shutdown();
		}
	});
});

test("nonfatal unscoped errors and clean idle exits do not create failed outcomes", async () => {
	await outcomeFixture(async (manager, meta) => {
		const worker = fakeWorker(0);
		manager["onPacket"](meta, worker, { type: "working", working: false });
		manager["onPacket"](meta, worker, { type: "error", message: "Watch failed" });
		assert.equal(meta.outcome, undefined);
		const changes: SessionSummary[] = [];
		manager.onChange((summary) => changes.push(summary));
		manager["onExit"](meta, worker, 0, null);
		assert.equal(meta.outcome, undefined);
		assert.equal(changes.at(-1)?.state, "parked");
	});
});

test("abort acknowledgements do not imply stopped, only a settled completion does", async () => {
	await outcomeFixture(async (manager, meta) => {
		const worker = fakeWorker();
		manager["onPacket"](meta, worker, { type: "working", working: true });
		manager["onPacket"](meta, worker, { type: "aborted", requestId: "abort" });
		assert.equal(meta.outcome, undefined);
		assert.equal(meta.working, true);
		manager["onPacket"](meta, worker, {
			type: "working",
			working: false,
			completion: { outcome: "stopped", outcomeAt: 100 },
		});
		assert.equal(meta.outcome, "stopped");
	});
});

test("shutdown errors and exits do not create outcomes, and shutdown drains queued metadata", async () => {
	await outcomeFixture(async (manager, meta, home) => {
		manager["onPacket"](meta, fakeWorker(), {
			type: "working",
			working: false,
			completion: { outcome: "done", outcomeAt: 10 },
		});
		await manager.shutdown();
		manager["onPacket"](meta, fakeWorker(), { type: "error", message: "Shutdown failed" });
		manager["onExit"](meta, fakeWorker(), 1, null);
		assert.equal(meta.outcome, "done");
		assert.equal(meta.outcomeAt, 10);
		const saved = JSON.parse(await readFile(join(home, "sessions", meta.id, "meta.json"), "utf8"));
		assert.equal(saved.outcome, "done");
	});
});

test("queued metadata writes capture each transition instead of serializing live objects", async () => {
	await outcomeFixture(async (manager, meta, home) => {
		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		manager["saving"].set(meta.id, firstGate);
		meta.outcome = "done";
		meta.outcomeAt = 10;
		const first = manager["save"](meta);
		manager["saving"].set(
			meta.id,
			first.then(() => secondGate),
		);
		delete meta.outcome;
		delete meta.outcomeAt;
		meta.working = true;
		const second = manager["save"](meta);
		try {
			releaseFirst();
			await first;
			const file = join(home, "sessions", meta.id, "meta.json");
			assert.equal(JSON.parse(await readFile(file, "utf8")).outcome, "done");
			releaseSecond();
			await second;
			const latest = JSON.parse(await readFile(file, "utf8"));
			assert.equal(latest.outcome, undefined);
			assert.equal(latest.working, true);
		} finally {
			releaseFirst();
			releaseSecond();
			await second;
		}
	});
});

test("database access: only configured projects get db, and only the app's decision grants an ask", async (t) => {
	const f = await fixture(t);
	const agentDir = join(f.root, "agent");
	await mkdir(agentDir);
	const config = join(agentDir, DATABASE_CONFIG_FILE);
	await writeFile(
		config,
		JSON.stringify({
			projects: { [f.project.path]: { environments: { prod: { read: { url: "postgres://ro@prod/app" } } } } },
		}),
	);
	await chmod(config, 0o600);
	const queries: string[] = [];
	const databases = new DatabaseService(agentDir, async (target, statements) => {
		queries.push(`${target.url} ${statements[0]?.sql}`);
		return [{ columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false }];
	});
	const sessions = await f.manager({}, { databases });
	const settings = await sessions.projectDatabases(f.project.id);
	assert.equal(JSON.stringify(settings).includes("postgres://"), false);
	await sessions.updateProjectDatabases(f.project.id, {
		revision: settings.revision,
		environments: [
			{ name: "prod", read: {} },
			{ name: "local", read: { url: "postgres://ro@local/app" }, write: { url: "postgres://rw@local/app" } },
		],
	});
	assert.equal((await sessions.projectDatabases(f.project.id)).environments[1]?.write?.access, "ask");
	const created = await sessions.spawn({ projectId: f.project.id, workspace: "direct", message: "Start" });
	await sessions["starting"].get(created.id);
	const worker = f.workers.at(-1)!;
	assert.equal(worker.spec.databases, true);
	const meta = sessions["metas"].get(created.id)!;
	const call = async (callId: string, action: "access" | "query", args: Record<string, JsonValue>) => {
		sessions["onPacket"](meta, worker, { type: "database.call", callId, action, args });
		await until(() => worker.sent.some((command) => command.type === "database.result" && command.callId === callId));
		const reply = worker.sent.find((command) => command.type === "database.result" && command.callId === callId);
		return reply as Extract<KernelCommand, { type: "database.result" }>;
	};
	const field = (value: JsonValue | undefined, key: string) =>
		value && typeof value === "object" && !Array.isArray(value) ? value[key] : undefined;

	assert.match((await call("q1", "query", { env: "prod", sql: "select 1" })).error ?? "", /No read access to prod/);
	assert.equal(field((await call("a1", "access", { env: "prod" })).result, "status"), "pending");
	// Typing the option's text is just a message: it declines instead of granting.
	await sessions.send(created.id, "Allow read access to prod");
	assert.deepEqual(sessions["metas"].get(created.id)?.databases, {});

	const asked = (await call("a2", "access", { env: "prod" })).result;
	const requestId = field(field(field(asked, "question"), "databaseAccess"), "id");
	assert.equal(typeof requestId, "string");
	await assert.rejects(sessions.decideDatabaseAccess(created.id, "forged", true), /no longer pending/);
	await sessions.decideDatabaseAccess(created.id, requestId as string, true);
	assert.deepEqual(sessions["metas"].get(created.id)?.databases, { grants: [{ env: "prod", mode: "read" }] });
	await until(() =>
		worker.requests.some(
			(command) => command.type === "input" && command.content === "Allowed read access to the prod database.",
		),
	);
	// The decision is used up: a repeated click changes nothing.
	await assert.rejects(sessions.decideDatabaseAccess(created.id, requestId as string, false), /no longer pending/);
	assert.deepEqual(field((await call("q2", "query", { env: "prod", sql: "select 1" })).result, "rows"), [{ n: 1 }]);
	assert.deepEqual(queries, ["postgres://ro@prod/app select 1"]);

	// Another project has no databases: its chats never get the tool.
	const other = join(f.root, "other");
	await mkdir(other);
	const project = await f.projects.create({ path: other, model: "test/preferred" });
	const unrelated = await sessions.spawn({ projectId: project.id, workspace: "direct", message: "Start" });
	await sessions["starting"].get(unrelated.id);
	assert.equal(f.workers.at(-1)!.spec.databases, undefined);
});

test("chat summaries carry their triage source and follow link changes", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const sources = new Map<string, SessionTrackedSource>();
	const reads: string[] = [];
	sessions.setTrackedSources(async (projectId) => {
		reads.push(projectId);
		return projectId === f.project.id ? [...sources].map(([sessionId, source]) => ({ sessionId, source })) : [];
	});
	const created = await sessions.spawn({ projectId: f.project.id, workspace: "direct", message: "Start" });
	const other = await sessions.spawn({ projectId: f.project.id, workspace: "direct", message: "Start" });
	const emitted: SessionSummary[] = [];
	sessions.onChange((summary) => emitted.push(summary));
	assert.equal(sessions.get(created.id)?.trackedSource, undefined);

	const source: SessionTrackedSource = {
		kind: "slack",
		itemId: "item-1",
		label: "#support",
		title: "Login broken",
		url: "https://example.slack.com/archives/C1/p1",
	};
	sources.set(created.id, source);
	sessions.refreshTrackedSources(f.project.id);
	await until(() => sessions.get(created.id)?.trackedSource !== undefined);
	assert.deepEqual(sessions.get(created.id)?.trackedSource, source);
	assert.deepEqual(sessions.list({ projectId: f.project.id }).find((s) => s.id === created.id)?.trackedSource, source);
	assert.ok(emitted.some((summary) => summary.id === created.id && summary.trackedSource?.itemId === "item-1"));
	assert.equal(sessions.get(other.id)?.trackedSource, undefined);
	assert.ok(!emitted.some((summary) => summary.id === other.id && summary.trackedSource));

	sources.delete(created.id);
	sessions.refreshTrackedSources(f.project.id);
	await until(() => sessions.get(created.id)?.trackedSource === undefined);
	assert.ok(reads.every((id) => id === f.project.id));
});

test("slack_status: only chats attached to a Slack triage message declare it, and calls carry the chat's ID", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const calls: Array<[string, Record<string, unknown>]> = [];
	const attached = new Set<string>();
	sessions.setSlackStatus({
		call: async (sessionId, args) => {
			calls.push([sessionId, args]);
			return { updated: [], unchanged: [] };
		},
		linked: async (_projectId, sessionIds) => sessionIds.filter((id) => attached.has(id)),
	});
	const linked = (worker: (typeof f.workers)[number]) =>
		worker.sent.filter((command) => command.type === "slack.linked").map((command) => command.linked);
	const created = await sessions.spawn({ projectId: f.project.id, workspace: "direct", message: "Start" });
	await sessions["starting"].get(created.id);
	const worker = f.workers.at(-1)!;
	const other = await sessions.spawn({ projectId: f.project.id, workspace: "direct", message: "Start" });
	await sessions["starting"].get(other.id);
	const otherWorker = f.workers.at(-1)!;
	await delay(20);
	assert.deepEqual(linked(worker), []);

	attached.add(created.id);
	sessions.refreshSlackLinks(f.project.id);
	await until(() => linked(worker).length === 1);
	assert.deepEqual(linked(worker), [true]);
	sessions["onPacket"](sessions["metas"].get(created.id)!, worker, {
		type: "slack.call",
		callId: "s1",
		args: { status: "waiting", reason: "CSM" },
	});
	await until(() => worker.sent.some((command) => command.type === "slack.result" && command.callId === "s1"));
	assert.deepEqual(calls, [[created.id, { status: "waiting", reason: "CSM" }]]);

	attached.delete(created.id);
	sessions.refreshSlackLinks(f.project.id);
	await until(() => linked(worker).length === 2);
	assert.deepEqual(linked(worker), [true, false]);
	assert.deepEqual(linked(otherWorker), []);
});
