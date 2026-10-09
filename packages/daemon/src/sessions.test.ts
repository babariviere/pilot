// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access tests private supervision seams.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand, KernelPacket, KernelSubagent } from "@pilot/kernel";
import type { AgentEvent, SessionCompletion, SessionState, SessionSummary, SessionUsage } from "@pilot/protocol";
import { WebSocket } from "ws";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import {
	CommandRejected,
	type SessionFactories,
	SessionManager,
	Worker as KernelWorker,
	WorkerUnavailable,
	type SessionManagerOptions,
	type SessionWorker,
} from "./sessions.ts";
import type { TerminalManager } from "./terminals.ts";
import type { SubagentWatchUpdate } from "./subagent-watches.ts";

type Command = Extract<KernelCommand, { type: "input" | "abort" }>;
type Spec = Extract<KernelCommand, { type: "start" }>["spec"];

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

test("startup deadline terminates a hung worker and rejects readiness as uncertain transport", async (t) => {
	const { child, worker } = supervisedWorker(t);
	const rejected = assert.rejects(worker.ready, WorkerUnavailable);
	t.mock.timers.tick(1_000);
	await rejected;
	assert.deepEqual(child.killed, ["SIGTERM"]);
	assert.equal(worker.state, "failed");
	assert.equal(worker["killTimer"], undefined, "confirmed exit cancels the forced-retirement timer");
	t.mock.timers.tick(10_000);
	assert.deepEqual(child.killed, ["SIGTERM"], "an exited process must never receive the fallback signal");
	child.emit("message", { type: "ready", model: "late/model", working: false, usage: {} });
	assert.equal(worker.state, "failed", "late acknowledgement cannot revive a terminated worker");
});

test("command acknowledgement deadline rejects all uncertain admissions and terminates the worker", async (t) => {
	const { child, worker, ready } = supervisedWorker(t);
	ready();
	await worker.ready;
	const input = worker.request({ type: "input", requestId: "stable-id", content: "work", mode: "followUp" });
	const abort = worker.request({ type: "abort", requestId: "abort-id" });
	const rejected = Promise.all([assert.rejects(input, WorkerUnavailable), assert.rejects(abort, WorkerUnavailable)]);
	t.mock.timers.tick(1_000);
	await rejected;
	assert.deepEqual(child.killed, ["SIGTERM"]);
	assert.equal(worker["pending"].size, 0);
	assert.equal(child.sent.find((command) => command.type === "input")?.requestId, "stable-id");
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

test("transport retirement sends SIGTERM first, escalates once after eight seconds, and waits for confirmed exit", async (t) => {
	const { child, worker } = supervisedWorker(t);
	child.kill = (signal) => {
		child.killed.push(signal);
		return true;
	};
	const rejected = assert.rejects(worker.ready, WorkerUnavailable);
	t.mock.timers.tick(1_000);
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
	test(`${phase} deadline retains durable IDs and demand waits for exit without duplicating accepted work`, async (t) => {
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
		t.mock.timers.tick(1_000);
		await drain;
		assert.deepEqual(firstChild.killed, ["SIGTERM"]);
		const timedOut = await f.stored(created.id);
		assert.equal(timedOut.failure, undefined, "transport deadlines must not permanently disable recovery");
		assert.deepEqual(timedOut.pending, [original], "uncertain admission preserves ID and payload");
		assert.match(timedOut.inputError!, /timed out/);
		const resuming = sessions.send(
			created.id,
			"retry payload must not replace original",
			"followUp",
			original.requestId,
		);
		await Promise.resolve();
		assert.equal(attempts, 1, "a replacement cannot open while the old process still owns storage");
		firstChild.connected = false;
		firstChild.emit("exit", null, "SIGTERM");
		await resuming;
		assert.equal(attempts, 2);
		assert.equal(executions, 1, "a lost acknowledgement retries the durable ID, not a new input");
		assert.deepEqual((await f.stored(created.id)).pending, []);
	});
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
	compactions: [],
	inbox: [],
	agent: {},
	usage: { models: {}, tools: {} },
};

class FakeWorker implements SessionWorker {
	readonly gate = deferred();
	readonly ready = this.gate.promise;
	state: SessionState = "starting";
	usage?: SessionUsage;
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

	reportUsage(usage: SessionUsage): void {
		this.usage = usage;
		this.onPacket({ type: "usage", usage });
	}

	reportSubagents(subagents: KernelSubagent[]): void {
		this.onPacket({ type: "subagents", subagents });
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
		assert.deepEqual((await f.stored(created.id)).pending, []);
		assert.equal(sessions.get(created.id)?.state, "idle");
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
	const deadline = Date.now() + 3_000;
	while (!(await check())) {
		assert.ok(Date.now() < deadline, "condition did not settle");
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

test("generated title updates and persists without delaying startup", async (t) => {
	const f = await fixture(t);
	const gate = deferred();
	const task = "Please fix the branch naming and describe the result";
	const sessions = await f.manager({
		title: async (cwd, message, signal) => {
			assert.equal(cwd, f.source);
			assert.equal(message, task);
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
	gate.resolve();
	await until(() => sessions.get(created.id)?.title === "Fix branch naming");
	await until(async () => (await f.stored(created.id)).title === "Fix branch naming");
	assert.ok(titles.includes("Fix branch naming"));
	assert.equal((await f.stored(created.id)).titlePending, undefined);
});

test("explicit titles bypass generation and provider failures keep the fallback", async (t) => {
	const f = await fixture(t);
	let calls = 0;
	const sessions = await f.manager({
		title: async () => {
			calls++;
			throw new Error("unavailable");
		},
	});
	const explicit = await sessions.spawn({ cwd: f.source, message: "task", title: " My title " });
	assert.equal(explicit.title, "My title");
	assert.equal(calls, 0);
	const fallback = await sessions.spawn({ cwd: f.source, message: "Fallback task\nDetails" });
	await until(async () => (await f.stored(fallback.id)).titlePending === undefined);
	assert.equal(calls, 1);
	assert.equal(sessions.get(fallback.id)?.title, "Fallback task");
	assert.equal(sessions.get(explicit.id)?.title, "My title");
});

test("pending titles resume on load without waking an idle kernel", async (t) => {
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
	const sessions = await f.manager({
		title: async (cwd, message) => {
			assert.equal(cwd, f.source);
			assert.equal(message, "Task details");
			return "Recovered title";
		},
	});
	await until(async () => (await f.stored(id)).titlePending === undefined);
	assert.equal(sessions.get(id)?.title, "Recovered title");
	assert.equal(f.workers.length, 0);
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
	const manager = async (factories: SessionFactories = {}, options: SessionManagerOptions = {}) => {
		const sessions = new SessionManager(
			home,
			projects,
			undefined,
			{
				title: async () => undefined,
				worker: workerFactory(),
				...factories,
			},
			{},
			options,
		);
		managers.push(sessions);
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
		initializing?: boolean;
		preparing?: { source: string; baseBranch?: string };
		pending: Command[];
		cancelled?: boolean;
		inputError?: string;
		failure?: string;
		working?: boolean;
	}> => JSON.parse(await readFile(join(home, "sessions", id, "meta.json"), "utf8"));
	t.after(async () => {
		await Promise.all(managers.map((sessions) => sessions.shutdown()));
		await rm(root, { recursive: true, force: true });
	});
	return { root, home, source, projects, project, workers, workerFactory, manager, stored };
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

	ws = new WebSocket(`${url.replace("http", "ws")}/api/ws`);
	const messages: { type: string; message?: string }[] = [];
	ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
	await once(ws, "open");
	ws.send(JSON.stringify({ type: "subscribe", sessionId: created.id }));
	ws.send(JSON.stringify({ type: "terminal.attach", sessionId: created.id, cols: 80, rows: 24 }));
	await until(() => messages.some((message) => message.type === "error"));
	assert.match(messages.find((message) => message.type === "error")!.message!, /still preparing/);
	assert.equal(terminalsStarted, 0);
	assert.equal(f.workers.length, 0);
	clone.resolve();
	await until(() => sessions.get(created.id)?.state === "working");
	await until(() => messages.some((message) => message.type === "events"));
	assert.equal(f.workers.length, 1);
	assert.equal(f.workers[0]!.spec.cwd, created.cwd);
	assert.equal(f.workers[0]!.spec.trustDirectory, f.source);
	assert.equal(f.workers[0]!.requests[0]!.requestId, meta.pending[0]!.requestId);
	assert.deepEqual(sessions.changeBase(created.id), { cwd: created.cwd, base: "origin/main" });
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
	assert.deepEqual(reopened.changeBase(created.id), { cwd: created.cwd, base: "origin/release/stable" });
	assert.equal(await readFile(join(f.source, "keep"), "utf8"), "source");
	assert.deepEqual(f.workers[0]!.requests, before.pending);
	assert.deepEqual((await f.stored(created.id)).pending, []);
	await reopened.shutdown();
	const readyRestart = await f.manager({
		workspace: async () => {
			throw new Error("must reuse prepared base");
		},
	});
	assert.deepEqual(readyRestart.changeBase(created.id), { cwd: created.cwd, base: "origin/release/stable" });
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

for (const failure of ["clone", "factory", "ready"] as const) {
	test(`${failure} startup errors remain visible failed sessions across restart`, async (t) => {
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
		const created = await sessions.spawn({ projectId: f.project.id, message: "fail visibly" });
		const changes: SessionSummary[] = [];
		sessions.onChange((session) => changes.push(session));
		const batches: AgentEvent[][] = [];
		sessions.subscribe(created.id, (events) => batches.push(events));
		if (failure === "ready") {
			await until(() => f.workers.length === 1);
			f.workers[0]!.gate.reject(new Error("kernel unavailable"));
		}
		await until(() => changes.at(-1)?.state === "failed");
		assert.match(sessions.get(created.id)!.error!, /unavailable/);
		assert.equal(changes.at(-1)?.state, "failed");
		assert.deepEqual(batches.at(-1), [snapshot]);
		assert.equal((await f.stored(created.id)).pending.length, 1);
		await assert.rejects(sessions.send(created.id, "retry"), /unavailable/);
		await sessions.stop(created.id);
		sessions.subscribe(created.id, () => {});
		if (failure === "clone") {
			assert.equal(f.workers.length, 0);
			assert.throws(() => sessions.changeBase(created.id), /still preparing/);
		}
		await sessions.shutdown();
		const count = f.workers.length;
		const reopened = await f.manager();
		assert.equal(reopened.get(created.id)?.state, "failed");
		const recoveredBatches: AgentEvent[][] = [];
		reopened.subscribe(created.id, (events) => recoveredBatches.push(events));
		assert.deepEqual(recoveredBatches, [[snapshot]]);
		assert.equal(f.workers.length, count);
	});
}

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

test("worker usage updates reach summaries and are dropped when the worker exits", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "usage" });
	await until(() => sessions.get(created.id)?.state === "working");
	const changes: SessionSummary[] = [];
	sessions.onChange((session) => changes.push(session));
	const usage: SessionUsage = {
		context: { tokens: 100, contextWindow: 200_000, percent: 0.05 },
		subscription: { fetchedAt: 1, provider: "anthropic", windows: [{ label: "5h", usedPercent: 25 }] },
	};
	f.workers[0]!.reportUsage(usage);
	assert.deepEqual(sessions.get(created.id)?.usage, usage);
	assert.deepEqual(changes.at(-1)?.usage, usage);
	await f.workers[0]!.close();
	assert.equal(sessions.get(created.id)?.usage, undefined);
	assert.equal(changes.at(-1)?.usage, undefined);
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
		if (telemetry === "usage") worker.reportUsage({ subscription: { fetchedAt: now, windows: [] } });
		else sessions["onPacket"](sessions["metas"].get(created.id)!, worker, { type: telemetry });
		assert.equal(sessions["lastUse"].get(created.id), lastUse, "telemetry is not execution activity");
		await sessions["parkIdleWorkers"]();
		assert.equal(worker.closed, false, "the original inactivity deadline still applies");
		now += 2;
		if (telemetry === "usage") worker.reportUsage({ subscription: { fetchedAt: now, windows: [] } });
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

test("idle unwatched kernels without subprocesses park, and reopen only after releasing storage", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({}, { idleParkMs: 30 });
	const created = await sessions.spawn({ cwd: f.source, message: "work" });
	await until(() => sessions.get(created.id)?.state === "working");
	await delay(100);
	assert.equal(sessions.get(created.id)?.state, "working", "working kernels never park");
	await sessions.stop(created.id);
	await until(() => sessions.get(created.id)?.state === "idle");
	const first = f.workers[0]!;
	const off = sessions.subscribe(created.id, () => {});
	await delay(100);
	assert.equal(first.closed, false, "a viewer keeps the kernel open");
	first.children = true;
	off();
	await delay(100);
	assert.equal(first.closed, false, "background jobs and subagents keep the kernel open");
	const release = deferred();
	first.closeGate = release.promise;
	first.children = false;
	await until(() => sessions.get(created.id)?.state === "parked");
	assert.equal(first.closed, true);
	const events: AgentEvent[][] = [];
	sessions.subscribe(created.id, (batch) => events.push(batch));
	await delay(50);
	assert.equal(f.workers.length, 1, "viewing parked history never reopens the kernel");
	const sending = sessions.send(created.id, "resume work");
	await delay(50);
	assert.equal(f.workers.length, 1, "explicit execution waits for the parked kernel to release its lease");
	release.resolve();
	await sending;
	await until(() => f.workers.length === 2 && sessions.get(created.id)?.state === "working");
	await until(() => events.some((batch) => batch.some((event) => event.type === "snapshot")));
	assert.equal((await f.stored(created.id)).failure, undefined);
	assert.equal(sessions.get(created.id)?.error, undefined);
});

test("malformed preparing metadata never removes or runs in the source directory", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	const created = await sessions.spawn({ cwd: f.source, message: "corrupted destination" });
	await sessions.shutdown();
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
	assert.equal(f.workers.length, 1);
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
	const meta = { ...(await f.stored(created.id)), id: "../source" };
	await writeFile(join(f.home, "sessions", created.id, "meta.json"), JSON.stringify(meta));
	const warning = mock.method(console, "warn", () => {});
	t.after(() => warning.mock.restore());
	const reopened = await f.manager();
	assert.deepEqual(reopened.list(), []);
	assert.equal(warning.mock.callCount(), 1);
	assert.equal(f.workers.length, 1);
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

for (const recovery of ["restart", "demand"] as const) {
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
		const sessions = await f.manager({ worker: f.workerFactory(true, admit) });
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
		} else sessions.subscribe(created.id, () => {});
		await until(() => recovered.get(created.id)?.state === "working");
		assert.equal(admissions, 1);
		assert.equal(attempts, 2);
		assert.deepEqual(f.workers[1]!.requests, before.pending);
		await until(async () => (await f.stored(created.id)).pending.length === 0);
		assert.deepEqual((await f.stored(created.id)).pending, []);
	});
}

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
		reopened["ensureWorker"] = (id) => {
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
