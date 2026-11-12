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
import { canonicalJSON, payloadHash } from "./operation-journal.ts";
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
	const checkpointReply = (
		command: Extract<KernelCommand, { type: "checkpointLifecycle" }>,
		census = { jobs: 0, hasChildren: false },
	) =>
		report({
			type: "lifecycle.checkpointed",
			requestId: command.requestId,
			operationId: command.operationId,
			conversationId: "root",
			...(command.notifyUpdate ? { updateNoticeOperationId: command.operationId } : {}),
			children: [],
			...census,
		});
	const worker: SessionWorker = {
		ready: Promise.resolve(),
		state: "idle",
		busy: false,
		send(command) {
			commands.push(command);
			if (command.type === "update.pause") report({ type: "update.paused", id: command.id });
		},
		request: async (command) => {
			commands.push(command);
			if (command.type === "checkpointLifecycle") checkpointReply(command);
		},
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
	const server = createDaemonServer(...args);
	owner.ready(hello);
	t.after(async () => {
		await owner.close();
		await sessions.shutdown();
		await terminals.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	await server.runtimeReady;
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
	return {
		home,
		owner,
		sessions,
		worker,
		report: (packet: KernelPacket) => report(packet),
		checkpointReply,
		terminals,
		commands,
		chat,
		request,
		shellStarts: () => shellStarts,
		base: `http://127.0.0.1:${port}`,
		hello,
	};
}

test("native global preparation binds original target/capture and exposes lookup only", async (t) => {
	const f = await fixture(t);
	const host = { hostId: "daemon", daemonId: f.hello.daemonId, lineageId: f.hello.lineageId! };
	const payload = canonicalJSON({ captureHash: "c".repeat(64), app: { source: "a".repeat(40), build: "1000.1" } });
	const op = {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: host,
		destination: host,
		targetId: "global-update",
		kind: "global-update-prepare",
		payload,
		payloadHash: payloadHash(payload),
	};
	const prepared = await f.request("prepare", { globalUpdate: op });
	assert.equal(prepared.status, 200);
	assert.equal(prepared.receipt.state, "accepted");
	const commands = f.commands.length;
	assert.deepEqual((await f.request("inspect", { globalUpdate: op })).receipt, prepared.receipt);
	assert.deepEqual((await f.request("prepare", { globalUpdate: op })).receipt, prepared.receipt);
	assert.equal(f.commands.length, commands, "lookup/repeated prepare never re-enters pause/cancel");
	assert.equal(
		(await f.request("prepare", { globalUpdate: { ...op, operationId: randomUUID(), producerId: randomUUID() } }))
			.status,
		409,
	);
	assert.equal(
		(await f.request("prepare", { operationId: randomUUID() })).status,
		409,
		"legacy updater cannot supersede the global hold",
	);
	assert.equal((await f.request("cancel", { globalUpdate: op })).status, 409, "no unverified release authority");
	const verified = await f.request("verify", { globalUpdate: op });
	assert.equal(verified.status, 200);
	assert.deepEqual(verified.receipt.receipt, prepared.receipt);
	assert.deepEqual(verified.receipt.blockers, []);
	assert.equal(f.commands.length, commands, "fresh verification never re-enters checkpoint/cancellation");
});

test("update blocker GET pins identity and only observes work", async (t) => {
	const f = await fixture(t);
	const before = f.commands.length;
	const checkpoint = t.mock.method(f.sessions, "blockers", async () => {
		throw new Error("must not checkpoint");
	});
	const pause = t.mock.method(f.sessions, "pauseForUpdate", () => {
		throw new Error("must not pause");
	});
	const stop = t.mock.method(f.sessions, "stop", async () => {
		throw new Error("must not stop");
	});
	f.worker.jobs = async () => [
		{ id: "job", name: "live", state: "running", startedAt: 1, outputPath: "/private/job" },
	];
	f.worker.hasChildren = async () => true;
	const path = `${f.base}/api/update/blockers`;
	for (const query of ["", "?daemonId=wrong&lineageId=wrong"]) {
		const response = await fetch(`${path}${query}`);
		assert.equal(response.status, 409);
		await response.arrayBuffer();
	}
	const response = await fetch(
		`${path}?${new URLSearchParams({ daemonId: f.hello.daemonId, lineageId: f.hello.lineageId! })}`,
	);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	const body = (await response.json()) as import("@pilot/protocol").DaemonUpdateBlockers;
	assert.equal(body.daemonId, f.hello.daemonId);
	assert.equal(body.lineageId, f.hello.lineageId);
	assert.equal(body.processId, process.pid);
	assert.ok(body.blockers.some((b) => b.kind === "job" && b.sessionId === f.chat.id));
	assert.ok(body.blockers.some((b) => b.kind === "child-process" && b.sessionId === f.chat.id));
	assert.ok(body.blockers.length <= 256);
	assert.equal(JSON.stringify(body).includes("/private/job"), false);
	assert.equal(f.commands.length, before);
	assert.equal(checkpoint.mock.callCount(), 0);
	assert.equal(pause.mock.callCount(), 0);
	assert.equal(stop.mock.callCount(), 0);
	checkpoint.mock.restore();
	pause.mock.restore();
	stop.mock.restore();
});

for (const purpose of ["daemon-upgrade", "daemon-stop", "daemon-restart"] as const) {
	test(`${purpose} explicit interruption journals recovery before closing active kernels`, async (t) => {
		const f = await fixture(t);
		f.worker.state = "working";
		f.worker.jobs = async () => [
			{ id: "active", name: "job", state: "running", startedAt: 1, outputPath: "/synthetic/log" },
		];
		f.worker.hasChildren = async () => true;
		let checkpoints = 0;
		f.worker.request = async (command) => {
			assert.equal(command.type, "checkpointLifecycle");
			const journal = JSON.parse(await readFile(join(f.home, ".daemon-lifecycle.json"), "utf8"));
			assert.equal(journal.purpose, purpose);
			assert.equal(journal.phase, "checkpointing");
			const meta = JSON.parse(await readFile(join(f.home, "sessions", f.chat.id, "meta.json"), "utf8"));
			assert.equal(meta.updatePaused, true);
			assert.equal(meta.lifecycleCheckpoint.operationId, input.operationId);
			assert.equal(meta.lifecycleCheckpoint.phase, "checkpointing");
			assert.equal(meta.lifecycleCheckpoint.inputGeneration, meta.inputGeneration ?? 0);
			assert.ok(meta.lifecycleCheckpoint.incarnation);
			checkpoints++;
			f.checkpointReply(command as Extract<KernelCommand, { type: "checkpointLifecycle" }>);
		};
		const input = { operationId: randomUUID(), purpose, interrupt: true };
		const held = await f.request("prepare", input);
		assert.equal(held.status, 200);
		assert.equal(held.receipt.interrupt, true);
		assert.equal(checkpoints, 1);
		assert.equal((await f.request("verify", held.receipt)).status, 200);
		assert.equal((await f.request("prepare", input)).status, 409);
		assert.equal(checkpoints, 1);
		assert.equal(JSON.parse(await readFile(join(f.home, ".daemon-lifecycle.json"), "utf8")).phase, "checkpointed");
		const manifest = f.sessions.lifecycleManifest(input.operationId);
		assert.equal(manifest.length, 1);
		assert.equal(manifest[0]!.sessionId, f.chat.id);
		assert.equal(manifest[0]!.checkpoint.phase, "checkpointed");
		assert.equal(
			f.commands.some((command) => command.type === "abort"),
			false,
			"no durable Stop/cancellation is synthesized",
		);
	});
	for (const busy of ["job", "child", "unknown", "terminal"] as const) {
		test(`${purpose} refuses ${busy} despite pause.ready and GUI reservation acceptance`, async (t) => {
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
			const input = { operationId: randomUUID(), purpose };
			assert.equal(
				(await f.request("prepare", input)).status,
				409,
				"daemon upgrade must defer without stopping work",
			);
			assert.equal((await f.request("prepare", input)).status, 409, "no replay of failed attempt");
			assert.equal(
				f.commands.some((c) => c.type === "abort" || c.type === "shutdown"),
				false,
			);
			assert.equal(f.shellStarts(), 0);
		});
	}
}

for (const purpose of ["daemon-stop", "daemon-restart"] as const) {
	test(`${purpose} admits idle work through the existing signed channel`, async (t) => {
		const f = await fixture(t);
		const held = await f.request("prepare", { operationId: randomUUID(), purpose });
		assert.equal(held.status, 200);
		assert.equal(held.receipt.purpose, purpose);
		assert.equal((await f.request("verify", held.receipt)).status, 200);
		assert.equal((await f.request("cancel", held.receipt)).status, 200);
	});
}

test("Stop and Restart refuse a working run even with acknowledged tool pause", async (t) => {
	const f = await fixture(t);
	f.worker.state = "working";
	assert.equal(f.sessions.pauseForUpdate().ready, true);
	for (const purpose of ["daemon-stop", "daemon-restart"]) {
		assert.equal((await f.request("prepare", { operationId: randomUUID(), purpose })).status, 409);
	}
	// Preserve the prior upgrade contract, which can checkpoint unfinished work.
	const upgrade = await f.request("prepare", { operationId: randomUUID(), purpose: "daemon-upgrade" });
	assert.equal(upgrade.status, 200);
	assert.equal((await f.request("cancel", upgrade.receipt)).status, 200);
	assert.equal(
		f.commands.some((c) => c.type === "abort" || c.type === "shutdown"),
		false,
	);
});

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

test("parked Stop commits its generation and abort under the upgrade fence", async (t) => {
	const f = await fixture(t);
	f.report({ type: "working", working: true });
	const held = await f.request("prepare", { operationId: randomUUID(), purpose: "daemon-upgrade", interrupt: true });
	assert.equal(held.status, 200);
	const before = f.commands.length;
	assert.deepEqual(await f.sessions.stop(f.chat.id), { ok: true });
	const meta = JSON.parse(await readFile(join(f.home, "sessions", f.chat.id, "meta.json"), "utf8"));
	assert.equal(meta.inputGeneration, 1);
	assert.equal(meta.lifecycleCheckpoint.phase, "stopped");
	assert.equal(meta.pending[0].type, "abort");
	assert.equal(f.commands.length, before, "parked Stop cannot open or resume a worker under the fence");
	assert.equal((await f.request("cancel", held.receipt)).status, 200);
	await f.sessions.resumeMaintenance();
	const deadline = Date.now() + 3_000;
	while (!f.commands.some((command) => command.type === "abort")) {
		assert.ok(Date.now() < deadline);
		await delay(1);
	}
	assert.equal(
		f.commands.slice(before).some((command) => command.type === "input" || command.type === "update.resume"),
		false,
	);
});

test("Stop during checkpoint cannot be overwritten by the late close ACK", async (t) => {
	const f = await fixture(t);
	f.report({ type: "working", working: true });
	let entered!: () => void;
	const checkpointing = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.worker.request = async (command) => {
		if (command.type === "checkpointLifecycle") {
			entered();
			await gate;
			f.checkpointReply(command);
		}
		if (command.type === "abort")
			f.report({
				type: "aborted",
				requestId: command.requestId,
				withdrawn: [{ requestId: "queued", content: "exact queued draft" }],
			});
	};
	const input = { operationId: randomUUID(), purpose: "daemon-upgrade", interrupt: true };
	const preparing = f.request("prepare", input);
	try {
		await checkpointing;
		assert.deepEqual(await f.sessions.stop(f.chat.id), { ok: true, draft: "exact queued draft" });
	} finally {
		release();
	}
	const held = await preparing;
	assert.equal(held.status, 200);
	const checkpoint = f.sessions.lifecycleManifest(input.operationId)[0]!.checkpoint;
	assert.equal(checkpoint.phase, "stopped");
	assert.equal(checkpoint.inputGeneration, 0, "original ownership must not follow later user intent");
});

test("lost explicit checkpoint ACK remains unknown after cancellation, even with no worker", async (t) => {
	const f = await fixture(t);
	const input = { operationId: randomUUID(), purpose: "daemon-upgrade", interrupt: true };
	f.worker.request = async () => {
		throw new Error("checkpoint reply lost");
	};
	assert.equal((await f.request("prepare", input)).status, 409);
	await f.sessions.resumeMaintenance();
	assert.equal(f.sessions.lifecycleManifest(input.operationId)[0]!.checkpoint.phase, "unknown");
	assert.equal(
		f.commands.some((command) => command.type === "update.resume"),
		false,
	);
	assert.equal((await f.request("prepare", { operationId: randomUUID(), purpose: "daemon-upgrade" })).status, 409);
});

test("unproven job descendant exit stays durable Unknown and refuses fresh replacement", async (t) => {
	const f = await fixture(t);
	const input = { operationId: randomUUID(), purpose: "daemon-upgrade", interrupt: true };
	let entered = 0;
	f.worker.request = async (command) => {
		if (command.type === "checkpointLifecycle") {
			entered++;
			throw new Error("Lifecycle job descendant exit is unconfirmed");
		}
	};
	assert.equal((await f.request("prepare", input)).status, 409);
	const checkpoint = f.sessions.lifecycleManifest(input.operationId)[0]!.checkpoint;
	assert.equal(checkpoint.phase, "unknown");
	assert.equal(checkpoint.quiescent, undefined);
	assert.equal(checkpoint.childrenConfirmed, undefined);
	const stored = JSON.parse(await readFile(join(f.home, "sessions", f.chat.id, "meta.json"), "utf8"));
	assert.equal(stored.lifecycleCheckpoint.phase, "unknown");
	assert.equal(stored.lifecycleCheckpoint.quiescent, undefined);
	await f.sessions.resumeMaintenance();
	assert.equal((await f.request("prepare", input)).status, 409, "lookup cannot retry cancelled work");
	assert.equal((await f.request("prepare", { ...input, operationId: randomUUID() })).status, 409);
	assert.equal(entered, 1, "empty/no worker cannot erase the held uncertainty");
});

for (const census of [
	{ jobs: 1, hasChildren: false },
	{ jobs: 0, hasChildren: true },
]) {
	test(`explicit close ACK does not override jobs=${census.jobs} children=${census.hasChildren}`, async (t) => {
		const f = await fixture(t);
		f.worker.request = async (command) => {
			if (command.type === "checkpointLifecycle") f.checkpointReply(command, census);
		};
		const input = { operationId: randomUUID(), purpose: "daemon-upgrade", interrupt: true };
		assert.equal((await f.request("prepare", input)).status, 409);
		const checkpoint = f.sessions.lifecycleManifest(input.operationId)[0]!.checkpoint;
		assert.equal(checkpoint.phase, "unknown");
		assert.equal(checkpoint.quiescent, undefined);
		assert.deepEqual(checkpoint.census, census);
		const refusal = JSON.parse(await readFile(join(f.home, ".daemon-lifecycle.json"), "utf8"));
		assert.equal(refusal.operationId, input.operationId);
		assert.equal(refusal.phase, "refused");
		assert.equal(refusal.affectedSessions[0].checkpoint.operationId, input.operationId);
		assert.equal(refusal.affectedSessions[0].checkpoint.quiescent, undefined);
		assert.deepEqual(refusal.affectedSessions[0].checkpoint.census, census);
	});
}

test("clear census without a durable update notice never authorizes replacement", async (t) => {
	const f = await fixture(t);
	f.worker.request = async (command) => {
		if (command.type === "checkpointLifecycle") {
			assert.equal(command.notifyUpdate, true);
			f.checkpointReply({ ...command, notifyUpdate: undefined });
		}
	};
	const input = { operationId: randomUUID(), purpose: "daemon-upgrade", interrupt: true };
	assert.equal((await f.request("prepare", input)).status, 409);
	const checkpoint = f.sessions.lifecycleManifest(input.operationId)[0]!.checkpoint;
	assert.equal(checkpoint.childrenConfirmed, true);
	assert.deepEqual(checkpoint.census, { jobs: 0, hasChildren: false });
	assert.equal(checkpoint.updateNoticeSaved, undefined);
	assert.equal(checkpoint.quiescent, undefined);
	assert.equal(checkpoint.phase, "unknown");
});

test("close ACK without the exact operation child inventory never proves quiescence", async (t) => {
	const f = await fixture(t);
	f.worker.request = async (command) => {
		if (command.type === "checkpointLifecycle") f.checkpointReply({ ...command, operationId: randomUUID() });
	};
	const input = { operationId: randomUUID(), purpose: "daemon-upgrade", interrupt: true };
	assert.equal((await f.request("prepare", input)).status, 409);
	assert.equal(f.sessions.lifecycleManifest(input.operationId)[0]!.checkpoint.childrenConfirmed, undefined);
});

test("close ACK and clear child census still wait for the exact worker exit", async (t) => {
	const f = await fixture(t);
	let entered!: () => void;
	const closing = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let exit!: () => void;
	const exitGate = new Promise<void>((resolve) => {
		exit = resolve;
	});
	f.worker.close = async () => {
		entered();
		await exitGate;
	};
	const input = { operationId: randomUUID(), purpose: "daemon-upgrade", interrupt: true };
	const preparing = f.request("prepare", input);
	try {
		await closing;
		const checkpoint = f.sessions.lifecycleManifest(input.operationId)[0]!.checkpoint;
		assert.equal(checkpoint.phase, "checkpointing");
		assert.equal(checkpoint.quiescent, undefined);
		await assert.rejects(f.sessions.send(f.chat.id, "admission race"), /update/);
	} finally {
		exit();
	}
	assert.equal((await preparing).status, 200);
	assert.equal(f.sessions.lifecycleManifest(input.operationId)[0]!.checkpoint.quiescent, true);
});

test("failed ownership save cannot interrupt or replace the existing worker", async (t) => {
	const f = await fixture(t);
	const internal = f.sessions as unknown as { save(meta: unknown, ...args: unknown[]): Promise<void> };
	const save = internal.save;
	const mocked = t.mock.method(internal, "save", async (meta: unknown, ...args: unknown[]) => {
		if ((meta as { lifecycleCheckpoint?: { phase: string } }).lifecycleCheckpoint?.phase === "checkpointing")
			throw new Error("checkpoint ownership fsync failed");
		return save.call(f.sessions, meta, ...args);
	});
	const before = f.commands.length;
	const input = { operationId: randomUUID(), purpose: "daemon-upgrade", interrupt: true };
	assert.equal((await f.request("prepare", input)).status, 409);
	assert.equal(
		f.commands
			.slice(before)
			.some(
				(command) =>
					command.type === "checkpointLifecycle" ||
					command.type === "shutdown" ||
					command.type === "update.resume",
			),
		false,
	);
	mocked.mock.restore();
});

test("replacement shutdown joins a parked Stop admitted after the checkpoint", async (t) => {
	const f = await fixture(t);
	f.report({ type: "working", working: true });
	assert.equal(
		(await f.request("prepare", { operationId: randomUUID(), purpose: "daemon-upgrade", interrupt: true })).status,
		200,
	);
	const internal = f.sessions as unknown as { save(meta: unknown, ...args: unknown[]): Promise<void> };
	const save = internal.save;
	let entered!: () => void;
	const savingStop = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const saveGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let held = false;
	const mocked = t.mock.method(internal, "save", async (meta: unknown, ...args: unknown[]) => {
		if (!held && (meta as { lifecycleCheckpoint?: { phase: string } }).lifecycleCheckpoint?.phase === "stopped") {
			held = true;
			entered();
			await saveGate;
		}
		return save.call(f.sessions, meta, ...args);
	});
	const stopped = f.sessions.stop(f.chat.id);
	await savingStop;
	let exited = false;
	const shuttingDown = f.sessions.shutdown().then(() => {
		exited = true;
	});
	try {
		await delay(20);
		assert.equal(exited, false, "a replacement cannot release the profile before its admitted Stop commits");
	} finally {
		release();
	}
	await stopped;
	await shuttingDown;
	mocked.mock.restore();
	const meta = JSON.parse(await readFile(join(f.home, "sessions", f.chat.id, "meta.json"), "utf8"));
	assert.equal(meta.inputGeneration, 1);
	assert.equal(meta.pending[0].type, "abort");
	assert.equal(meta.lifecycleCheckpoint.phase, "stopped");
});
