import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import { daemonHello } from "./hello.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { ownRuntime } from "./runtime-owner.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-upgrade-reservation-"));
	const home = join(root, "profile");
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const port = (probe.address() as { port: number }).port;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	const owner = await ownRuntime(home, port, true, null, "/synthetic/runtime");
	const projects = new ProjectStore(home);
	const commands: KernelCommand[] = [];
	let report!: (packet: KernelPacket) => void;
	const worker: SessionWorker = {
		ready: Promise.resolve(),
		state: "idle",
		busy: false,
		send(command) {
			commands.push(command);
			if (command.type === "update.pause") report({ type: "update.paused", id: command.id });
		},
		request: async () => {},
		close: async () => {},
		jobs: async () => [],
		hasChildren: async () => false,
	};
	const sessions = new SessionManager(home, projects, undefined, {
		title: async () => undefined,
		worker: (_spec, receive) => {
			report = receive;
			return worker;
		},
	});
	let shellStarts = 0;
	const terminals = new TerminalManager(() => {
		shellStarts++;
		throw new Error("No real PTYs in fixture");
	});
	const hello = await daemonHello(home, {
		independentExecution: true,
		coordinatorIsolation: false,
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
	});
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	];
	args[12] = hello;
	args[21] = owner;
	createDaemonServer(...args);
	owner.ready(hello);
	t.after(async () => {
		await owner.close();
		await sessions.shutdown();
		await terminals.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	await sessions.load();
	const chat = await sessions.spawn({ cwd: home, message: "synthetic initial input" });
	const deadline = Date.now() + 3_000;
	while (!sessions.pauseForUpdate().ready) {
		assert.ok(Date.now() < deadline, "synthetic pause did not settle");
		await delay(1);
	}
	const record = JSON.parse(await readFile(join(home, ".daemon-owner.json"), "utf8"));
	const mac = (raw: string) =>
		createHmac("sha256", Buffer.from(record.secret, "hex")).update(`update/v1\n${raw}`).digest("hex");
	async function request(action: string, receipt: unknown, signal?: AbortSignal) {
		const raw = JSON.stringify({ boot: record.boot, nonce: "a".repeat(64), action, receipt });
		const response = await fetch(`http://127.0.0.1:${port}/__pilot_runtime_update/v1`, {
			method: "POST",
			headers: { "x-pilot-update-proof": mac(raw) },
			body: raw,
			signal,
		});
		if (response.status !== 200) return { status: response.status, receipt: undefined };
		const envelope = (await response.json()) as { body: string; mac: string };
		assert.equal(envelope.mac, mac(envelope.body));
		const proof = JSON.parse(envelope.body);
		assert.equal(proof.boot, record.boot);
		return { status: response.status, receipt: proof.receipt };
	}
	return { home, owner, sessions, worker, terminals, commands, chat, request, shellStarts: () => shellStarts };
}

for (const busy of ["job", "child", "unknown", "terminal"] as const) {
	test(`daemon upgrade refuses ${busy} despite pause.ready and GUI reservation acceptance`, async (t) => {
		const f = await fixture(t);
		if (busy === "job")
			f.worker.jobs = async () => [
				{ id: "live", name: "job", state: "running", startedAt: 1, outputPath: "/synthetic/log" },
			];
		if (busy === "child") f.worker.hasChildren = async () => true;
		if (busy === "unknown")
			f.worker.jobs = async () => {
				throw new Error("IPC disconnected");
			};
		if (busy === "terminal") t.mock.method(f.terminals, "blockers", () => [{ kind: "terminal", id: "live-pty" }]);
		assert.equal(f.sessions.pauseForUpdate().ready, true, "tool drain is not process exit proof");
		const gui = await f.request("prepare", { operationId: randomUUID() });
		assert.equal(gui.status, 200, "legacy GUI-only behavior stays unchanged");
		assert.equal((await f.request("verify", { ...gui.receipt, purpose: "daemon-upgrade" })).status, 409);
		assert.equal((await f.request("cancel", gui.receipt)).status, 200);
		const input = { operationId: randomUUID(), purpose: "daemon-upgrade" };
		assert.equal((await f.request("prepare", input)).status, 409, "daemon upgrade must defer without stopping work");
		assert.equal((await f.request("prepare", input)).status, 409, "no replay of failed attempt");
		assert.equal(
			f.commands.some((c) => c.type === "abort" || c.type === "shutdown"),
			false,
		);
		assert.equal(f.shellStarts(), 0);
	});
}

test("daemon reservation checkpoints owned subagents before the unchanged process census", async (t) => {
	const f = await fixture(t);
	let child = true;
	let checkpoints = 0;
	f.worker.hasChildren = async () => child;
	f.worker.request = async (command) => {
		assert.equal(command.type, "checkpointUpdate");
		checkpoints++;
		child = false; // Synthetic durable ACK plus child exit, not a pause-only allowlist.
	};
	const held = await f.request("prepare", { operationId: randomUUID(), purpose: "daemon-upgrade" });
	assert.equal(held.status, 200);
	assert.equal(checkpoints, 1);
	assert.equal((await f.request("cancel", held.receipt)).status, 200);
	await f.sessions.resumeMaintenance();
	assert.equal(f.commands.filter((command) => command.type === "update.resume").length, 1);
});

test("failed child checkpoint cannot be accepted through an empty jobs/process census", async (t) => {
	const f = await fixture(t);
	f.worker.request = async () => {
		throw new Error("Child checkpoint ACK unavailable");
	};
	assert.equal((await f.request("prepare", { operationId: randomUUID(), purpose: "daemon-upgrade" })).status, 409);
	assert.equal(
		f.commands.some((command) => command.type === "abort" || command.type === "shutdown"),
		false,
	);
});

test("daemon reservation echoes purpose, fences admission races, and cancellation releases without replay", async (t) => {
	const f = await fixture(t);
	const initialInputs = f.commands.filter((c) => c.type === "input").length;
	let finish!: () => void;
	let entered!: () => void;
	const inspecting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	f.worker.jobs = async () => {
		entered();
		await gate;
		return [];
	};
	const input = { operationId: randomUUID(), purpose: "daemon-upgrade" };
	const preparing = f.request("prepare", input);
	try {
		await inspecting;
		await assert.rejects(f.sessions.send(f.chat.id, "must not be admitted"), /update/);
		assert.throws(() => f.terminals.attach("new", f.home, 80, 24, { data() {}, exit() {} }), /frozen/);
		assert.equal((await f.request("prepare", { operationId: randomUUID() })).status, 409);
	} finally {
		finish();
	}
	const held = await preparing;
	assert.equal(held.status, 200);
	assert.equal(held.receipt.purpose, "daemon-upgrade");
	assert.equal((await f.request("verify", held.receipt)).status, 200);
	const { purpose: _, ...guiReceipt } = held.receipt;
	assert.equal((await f.request("verify", guiReceipt)).status, 409, "receipts cannot change purpose");
	assert.equal((await f.request("cancel", { ...held.receipt, token: "wrong" })).status, 409);
	assert.throws(() => f.terminals.attach("new", f.home, 80, 24, { data() {}, exit() {} }), /frozen/);
	assert.equal((await f.request("cancel", held.receipt)).status, 200);
	assert.equal((await f.request("verify", held.receipt)).status, 409);
	assert.equal((await f.request("prepare", input)).status, 409);
	await f.sessions.resumeMaintenance();
	assert.equal(
		f.commands.filter((c) => c.type === "input").length,
		initialInputs,
		"resume never synthesizes another input",
	);
	assert.equal(f.commands.filter((c) => c.type === "update.resume").length, 1);
	assert.equal(f.shellStarts(), 0);
	const resumed = f.terminals.freezeAdmissions();
	resumed(); // independent owner is not stranded by cancellation
	assert.throws(() => f.terminals.attach("new", f.home, 80, 24, { data() {}, exit() {} }), /No real PTYs/);
	assert.equal(f.shellStarts(), 1);
});

test("disconnected preparation is not replayed; daemon close releases the orphaned hold", async (t) => {
	const f = await fixture(t);
	const initialInputs = f.commands.filter((c) => c.type === "input").length;
	let finish!: () => void;
	let entered!: () => void;
	const inspecting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	f.worker.jobs = async () => {
		entered();
		await gate;
		return [];
	};
	const input = { operationId: randomUUID(), purpose: "daemon-upgrade" };
	const abort = new AbortController();
	const preparing = f.request("prepare", input, abort.signal);
	const rejected = assert.rejects(preparing, { name: "AbortError" });
	try {
		await inspecting;
		abort.abort();
		await rejected;
		assert.equal((await f.request("prepare", input)).status, 409);
		assert.throws(() => f.terminals.attach("new", f.home, 80, 24, { data() {}, exit() {} }), /frozen/);
	} finally {
		finish();
	}
	await f.owner.close();
	await f.sessions.resumeMaintenance();
	assert.equal(f.commands.filter((c) => c.type === "input").length, initialInputs);
	assert.throws(() => f.terminals.attach("new", f.home, 80, 24, { data() {}, exit() {} }), /No real PTYs/);
});

test("daemon reservation never substitutes an idle worker for an acknowledged tool drain", async (t) => {
	const f = await fixture(t);
	await f.sessions.resumeMaintenance();
	const pauses = f.commands.filter((c) => c.type === "update.pause").length;
	assert.equal(f.worker.state, "idle");
	assert.equal((await f.request("prepare", { operationId: randomUUID(), purpose: "daemon-upgrade" })).status, 409);
	assert.equal(
		f.commands.filter((c) => c.type === "update.pause").length,
		pauses,
		"reservation never drains work itself",
	);
});
