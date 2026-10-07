import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { AgentEvent, SessionState, SessionSummary, SessionUsage } from "@pilot/protocol";
import { WebSocket } from "ws";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { CommandRejected, type SessionFactories, SessionManager, type SessionWorker } from "./sessions.ts";
import type { TerminalManager } from "./terminals.ts";

type Command = Extract<KernelCommand, { type: "input" | "abort" }>;
type Spec = Extract<KernelCommand, { type: "start" }>["spec"];
function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
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

	get busy(): boolean {
		return this.state === "starting" || this.state === "working";
	}

	constructor(
		readonly spec: Spec,
		private readonly onPacket: (packet: KernelPacket) => void,
		private readonly onExit: (worker: SessionWorker, code: number | null) => void,
		private readonly admit: (command: Command) => Promise<void> = async () => {},
	) {
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

	send(command: KernelCommand): void {
		this.sent.push(command);
		if (command.type === "watch") this.onPacket({ type: "events", watchId: command.watchId, events: [snapshot] });
	}

	async request(command: Command): Promise<void> {
		this.requests.push(command);
		await this.admit(command);
		this.state = command.type === "input" ? "working" : "idle";
		this.onPacket({ type: "working", working: this.state === "working" });
	}

	async close(): Promise<void> {
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
			workspace: async (_source, path, branch, _runner, signal) => {
				if (phase === "clone") await waitFor(gate.promise, signal);
				return { path, branch, base: "HEAD", jj: false };
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
			workspace: async (_source, path, branch) => {
				if (phase === "clone") throw new Error("terminal clone failure");
				return { path, branch, base: "HEAD", jj: false };
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

test("a new subscription drain is busy even during a reentrant idle worker factory notification", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const created = await sessions.spawn({ cwd: f.source, message: "initial" });
	await until(() => sessions.get(created.id)?.state === "working");
	await sessions.stop(created.id);
	await f.workers[0]!.close();
	const attempts: boolean[] = [];
	sessions.onChange(() => attempts.push(sessions.prepareUpdate().ready));
	const off = sessions.subscribe(created.id, () => {});
	assert.deepEqual(sessions.prepareUpdate(), { ready: false });
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
	const manager = async (factories: SessionFactories = {}) => {
		const sessions = new SessionManager(home, projects, undefined, { worker: workerFactory(), ...factories });
		managers.push(sessions);
		await sessions.load();
		return sessions;
	};
	const stored = async (
		id: string,
	): Promise<{
		cwd: string;
		initializing?: boolean;
		preparing?: { source: string; branch: string };
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

test("POST returns durable starting session before clone or worker, guarding changes and terminals", async (t) => {
	const f = await fixture(t);
	const clone = deferred();
	t.after(() => clone.resolve());
	const sessions = await f.manager({
		workspace: async (_source, path, branch, _runner, signal) => {
			await waitFor(clone.promise, signal);
			return { path, branch, base: "origin/main", jj: false };
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
		workspace: async (_source, path, branch, _runner, signal) => {
			entered.resolve();
			await waitFor(clone.promise, signal);
			return { path, branch, base: "HEAD", jj: false };
		},
	});
	const created = await sessions.spawn({ projectId: f.project.id, message: "recover clone" });
	await entered.promise;
	await mkdir(created.cwd);
	await writeFile(join(created.cwd, "partial"), "unfinished");
	await writeFile(join(f.source, "keep"), "source");
	await sessions.send(created.id, "second", "steer", "second-id");
	const before = await f.stored(created.id);
	await sessions.shutdown();
	clone.resolve();
	let clones = 0;
	const reopened = await f.manager({
		workspace: async (source, path, branch) => {
			clones++;
			assert.equal(source, f.source);
			assert.equal(path, created.cwd);
			assert.equal(branch, before.preparing!.branch);
			assert.equal(await stat(path).catch(() => undefined), undefined);
			return { path, branch, base: "HEAD", jj: false };
		},
	});
	await until(() => reopened.get(created.id)?.state === "working");
	assert.equal(clones, 1);
	assert.equal(await readFile(join(f.source, "keep"), "utf8"), "source");
	assert.deepEqual(f.workers[0]!.requests, before.pending);
	assert.deepEqual((await f.stored(created.id)).pending, []);
});

test("restart after clone but before ready reuses the workspace and recovers idle pending input", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({
		worker: f.workerFactory(false),
		workspace: async (_source, path, branch) => ({ path, branch, base: "HEAD", jj: true }),
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
		workspace: async (_source, path, branch, _runner, signal) => {
			await waitFor(clone.promise, signal);
			return { path, branch, base: "HEAD", jj: false };
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
			workspace: async (_source, path, branch, _runner, signal) => {
				if (phase === "clone") await waitFor(gate.promise, signal);
				return { path, branch, base: "HEAD", jj: false };
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
			workspace: async (_source, path, branch) => {
				if (failure === "clone") throw new Error("clone unavailable");
				return { path, branch, base: "HEAD", jj: false };
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
		workspace: async (_source, path, branch, _runner, signal) => {
			entered.resolve();
			await waitFor(clone.promise, signal);
			return { path, branch, base: "HEAD", jj: false };
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
	const workspace: SessionFactories["workspace"] = async (_source, path, branch, _runner, signal) => {
		await waitFor(gate.promise, signal);
		return { path, branch, base: "HEAD", jj: false };
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

test("malformed preparing metadata never removes or runs in the source directory", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager({ worker: f.workerFactory(false) });
	const created = await sessions.spawn({ cwd: f.source, message: "corrupted destination" });
	await sessions.shutdown();
	const file = join(f.home, "sessions", created.id, "meta.json");
	const meta = await f.stored(created.id);
	meta.preparing = { source: f.source, branch: "pilot/test" };
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
