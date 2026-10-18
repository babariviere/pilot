// biome-ignore-all lint/complexity/useLiteralKeys: Verify exact private ownership/recovery boundaries without workers.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DaemonHello, DurableOperation, OperationReceipt } from "@pilot/protocol";
import { ModelCatalog } from "./models.ts";
import { OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager, type SessionMissionBridge } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

const host = { hostId: "box", daemonId: "remote", lineageId: "remote-lineage" };
const barrier = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
};
const hello: DaemonHello = {
	daemonId: host.daemonId,
	lineageId: host.lineageId,
	daemonVersion: "test",
	protocolVersion: 1,
	minimumClientProtocolVersion: 1,
	platform: "linux",
	arch: "x64",
	capabilities: {
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
		coordinatorIsolation: true,
		independentExecution: true,
	},
};

function intent(home: string, message = "say hello world"): DurableOperation {
	const payload = JSON.stringify({ cwd: home, message });
	return {
		schemaVersion: 1,
		operationId: randomUUID().toUpperCase(),
		producerId: randomUUID().toUpperCase(),
		sequence: 1,
		origin: { hostId: "local", daemonId: "mac", lineageId: "mac-lineage" },
		destination: host,
		kind: "chat-create",
		// Foundation UUID.uuidString uses uppercase. Never rewrite a persisted operation's target.
		targetId: "ABCDEF01-2345-4678-9ABC-DEF012345678",
		payload,
		payloadHash: payloadHash(payload),
	};
}

async function fixture(t: TestContext, home: string) {
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	// Real admission, metadata, journal and HTTP. Only model/worker startup is suppressed.
	t.mock.method(sessions as unknown as { start(): Promise<Map<string, Error>> }, "start", async () => new Map());
	await sessions.load();
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		hello,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/operations`;
	const post = async (op: DurableOperation, lookup = false) => {
		const response = await fetch(base + (lookup ? "/receipt" : ""), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(op),
		});
		assert.equal(response.status, 200);
		return (await response.json()) as OperationReceipt | { state: "unknown" };
	};
	const close = async () => {
		terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await sessions.shutdown();
	};
	return { sessions, post, close };
}

test("native uppercase create returns a durable receipt and lost-response lookup opens the exact one chat", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-native-create-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const f = await fixture(t, home);
	t.after(f.close);
	const op = intent(home);
	assert.deepEqual(await f.post(op, true), { state: "unknown" });
	const receipt = await f.post(op);
	assert.equal(receipt.state, "accepted", "Native uppercase target IDs must not get stuck pending");
	// The app may lose the response after this durable write. Check is receipt-only.
	assert.deepEqual(await f.post(op, true), receipt);
	assert.deepEqual(await f.post(op), receipt, "Even an explicit retry cannot allocate another chat");
	assert.deepEqual(
		f.sessions.list().map((session) => session.id),
		[op.targetId],
	);
	const meta = JSON.parse(await readFile(join(home, "sessions", op.targetId, "meta.json"), "utf8"));
	assert.equal(meta.createOperationId, op.operationId);
	assert.equal(meta.pending.length, 1);
	assert.equal(meta.pending[0].requestId, op.operationId);
});

test("startup recovers an already-pending uppercase create without rewriting identity or duplicating input", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-native-create-recover-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const op = intent(home);
	const journal = new OperationJournal(join(home, "operations"), host);
	await journal.execute(op, async () => {
		throw new Error("old admission rejected uppercase target");
	});
	assert.equal((await journal.lookup(op))?.state, "pending");
	const first = await fixture(t, home);
	try {
		// Join startup recovery via the same original POST, never a fresh operation/target.
		assert.equal((await first.post(op)).state, "accepted");
		assert.equal((await first.post(op, true)).state, "accepted");
		assert.deepEqual(
			first.sessions.list().map((session) => session.id),
			[op.targetId],
		);
	} finally {
		await first.close();
	}
	const restarted = await fixture(t, home);
	t.after(restarted.close);
	assert.equal((await restarted.post(op, true)).state, "accepted");
	assert.deepEqual(
		restarted.sessions.list().map((session) => session.id),
		[op.targetId],
		"Session load retains exact uppercase path",
	);
	assert.equal((await restarted.post(op)).state, "accepted");
	const meta = JSON.parse(await readFile(join(home, "sessions", op.targetId, "meta.json"), "utf8"));
	assert.equal(meta.pending.filter((input: { requestId: string }) => input.requestId === op.operationId).length, 1);
});

test("not found is not rejection; a rejected ordinary create has a durable reason and no chat", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-native-create-reject-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const f = await fixture(t, home);
	t.after(f.close);
	const op = intent(home, "");
	assert.deepEqual(await f.post(op, true), { state: "unknown" });
	const receipt = await f.post(op);
	assert.equal(receipt.state, "rejected");
	assert.deepEqual(await f.post(op, true), receipt);
	assert.equal("reason" in receipt && receipt.reason, "message is required");
	assert.deepEqual(f.sessions.list(), []);
});

test("reserved targets still reject malformed, path-like and wrong-length IDs before creating a chat", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-native-create-invalid-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const sessions = new SessionManager(home, new ProjectStore(home));
	t.after(() => sessions.shutdown());
	for (const id of [
		"../ABCDEF01-2345-4678-9ABC-DEF012345678",
		"G".repeat(36),
		"A".repeat(35),
		"A".repeat(37),
		`${"A".repeat(35)}/`,
	]) {
		await assert.rejects(
			sessions.spawnDurable({ cwd: home, message: "no" }, id, randomUUID()),
			/Invalid reserved session ID/,
		);
	}
	assert.deepEqual(sessions.list(), []);
});

for (const firstCase of ["upper", "lower"] as const) {
	test(`case-alias create cannot overwrite ${firstCase}-case admission, concurrently or after restart`, async (t) => {
		const home = await mkdtemp(join(tmpdir(), "pilot-native-create-alias-"));
		t.after(() => rm(home, { recursive: true, force: true }));
		const original = intent(home);
		const id = firstCase === "upper" ? original.targetId : original.targetId.toLowerCase();
		const alias = firstCase === "upper" ? id.toLowerCase() : id.toUpperCase();
		const sessions = new SessionManager(home, new ProjectStore(home));
		t.mock.method(sessions as unknown as { start(): Promise<Map<string, Error>> }, "start", async () => new Map());
		const gate = barrier();
		const entered = barrier();
		// Pause real new-session admission before metadata exists to exercise the reservation race.
		const boundary = sessions as unknown as { spawnAdmitted(...args: unknown[]): Promise<unknown> };
		const admit = boundary.spawnAdmitted.bind(sessions);
		t.mock.method(boundary, "spawnAdmitted", async (...args: unknown[]) => {
			entered.resolve();
			await gate.promise;
			return admit(...args);
		});
		const request = { cwd: home, message: "original opening input" };
		const first = sessions.spawnDurable(request, id, original.operationId);
		try {
			await entered.promise;
			await assert.rejects(
				sessions.spawnDurable({ ...request, message: "must never overwrite" }, alias, randomUUID()),
				/aliases/,
			);
			const exactReplay = sessions.spawnDurable(request, id, original.operationId);
			await assert.rejects(sessions.spawnDurable(request, id, randomUUID()), /another admission/);
			gate.resolve();
			assert.equal((await first).id, id);
			assert.equal((await exactReplay).id, id);
			await assert.rejects(sessions.spawnDurable(request, alias, randomUUID()), /aliases/);
		} finally {
			gate.resolve();
			await first.catch(() => undefined);
			await sessions.shutdown();
		}
		const metadataPath = join(home, "sessions", id, "meta.json");
		const before = await readFile(metadataPath, "utf8");
		const restarted = new SessionManager(home, new ProjectStore(home));
		t.mock.method(restarted as unknown as { start(): Promise<Map<string, Error>> }, "start", async () => new Map());
		await restarted.load();
		t.after(() => restarted.shutdown());
		await assert.rejects(
			restarted.spawnDurable({ ...request, message: "overwrite after restart" }, alias, randomUUID()),
			/aliases/,
		);
		assert.equal((await restarted.spawnDurable(request, id, original.operationId)).id, id);
		assert.equal(await readFile(metadataPath, "utf8"), before, "No metadata rewrite, including on APFS alias paths");
		const meta = JSON.parse(before);
		assert.equal(meta.id, id);
		assert.equal(meta.createOperationId, original.operationId);
		assert.deepEqual(
			meta.pending.map((input: { content: string; requestId: string }) => [input.content, input.requestId]),
			[[request.message, original.operationId]],
		);
		assert.deepEqual(
			await readdir(join(home, "sessions")),
			[id],
			"Exactly one original-cased directory and no second session",
		);
	});
}

test("uppercase workspace origins and continuation recovery preserve exact ownership and reject case substitutions", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-native-create-ownership-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const op = intent(home);
	const sessions = new SessionManager(home, new ProjectStore(home));
	t.mock.method(sessions as unknown as { start(): Promise<Map<string, Error>> }, "start", async () => new Map());
	await sessions.spawnDurable({ cwd: home, message: "original input" }, op.targetId, op.operationId);
	const source = sessions["metas"].get(op.targetId)!;
	const workspace = { ...source, workspaceOriginId: source.id, cwd: join(home, "sessions", source.id, "workspace") };
	assert.doesNotThrow(() => sessions["assertOwnedWorkspace"](workspace));
	assert.throws(
		() => sessions["assertOwnedWorkspace"]({ ...workspace, workspaceOriginId: source.id.toLowerCase() }),
		/Invalid session workspace/,
	);
	assert.throws(
		() => sessions["assertOwnedWorkspace"]({ ...workspace, workspaceOriginId: `../${source.id}` }),
		/Invalid session workspace/,
	);
	const target = { ...source, id: "FEDCBA98-7654-4321-9ABC-DEF012345678", continuationOf: source.id };
	const journal = join(home, "sessions", source.id, "continuation.json");
	await writeFile(journal, JSON.stringify({ ...target, continuationOf: source.id.toLowerCase() }));
	await assert.rejects(sessions["recoverContinuations"](), /Invalid session continuation journal/);
	assert.equal(sessions.get(source.id)?.continuedTo, undefined);
	await writeFile(journal, JSON.stringify(target));
	await sessions.shutdown();
	const restarted = new SessionManager(home, new ProjectStore(home));
	t.mock.method(restarted as unknown as { start(): Promise<Map<string, Error>> }, "start", async () => new Map());
	await restarted.load();
	t.after(() => restarted.shutdown());
	assert.equal(restarted.get(source.id)?.continuedTo, target.id);
	assert.equal(restarted.get(target.id)?.continuationOf, source.id);
	const persisted = JSON.parse(await readFile(join(home, "sessions", target.id, "meta.json"), "utf8"));
	assert.equal(persisted.id, target.id);
	assert.equal(persisted.continuationOf, source.id);
	await assert.rejects(readFile(journal), { code: "ENOENT" });
});

test("ordinary creation paused before metadata fences a durable case alias without any overwrite", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-native-create-ordinary-race-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const sessions = new SessionManager(home, new ProjectStore(home));
	t.mock.method(sessions as unknown as { start(): Promise<Map<string, Error>> }, "start", async () => new Map());
	const gate = barrier(),
		entered = barrier();
	let selectedId = "";
	const save = sessions["save"].bind(sessions);
	sessions["save"] = async (meta, ...args) => {
		selectedId = meta.id;
		entered.resolve();
		await gate.promise;
		return save(meta, ...args);
	};
	const ordinary = sessions.spawn({ cwd: home, message: "ordinary original" });
	try {
		await entered.promise;
		assert.notEqual(selectedId, selectedId.toUpperCase());
		await assert.rejects(
			sessions.spawnDurable({ cwd: home, message: "must not overwrite" }, selectedId.toUpperCase(), randomUUID()),
			/active creation/,
		);
		await assert.rejects(readFile(join(home, "sessions", selectedId, "meta.json")), { code: "ENOENT" });
		assert.deepEqual(await readdir(join(home, "sessions")), [selectedId]);
		gate.resolve();
		assert.equal((await ordinary).id, selectedId);
		const persisted = JSON.parse(await readFile(join(home, "sessions", selectedId, "meta.json"), "utf8"));
		assert.equal(persisted.id, selectedId);
		assert.equal(persisted.createOperationId, undefined);
		assert.deepEqual(
			persisted.pending.map((input: { content: string }) => input.content),
			["ordinary original"],
		);
		assert.equal(sessions["newSessionAdmissions"].size, 0);
	} finally {
		gate.resolve();
		await ordinary.catch(() => undefined);
		await sessions.shutdown();
	}
});

test("failed admission holds its case fence through rollback then releases it for an exact retry", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-native-create-rollback-fence-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const op = intent(home);
	const sessions = new SessionManager(home, new ProjectStore(home));
	t.mock.method(sessions as unknown as { start(): Promise<Map<string, Error>> }, "start", async () => new Map());
	const gate = barrier(),
		cleaning = barrier();
	const save = sessions["save"].bind(sessions);
	let fail = true;
	sessions["save"] = async (...args) => {
		if (fail) throw new Error("injected admission write failure");
		return save(...args);
	};
	const discard = sessions["aiUsage"].discard.bind(sessions["aiUsage"]);
	t.mock.method(sessions["aiUsage"], "discard", async (id: string) => {
		cleaning.resolve();
		await gate.promise;
		return discard(id);
	});
	const request = { cwd: home, message: "original after retry" };
	const admission = sessions.spawnDurable(request, op.targetId, op.operationId);
	// Attach rejection handling before opening any barriers.
	const rejected = assert.rejects(admission, /injected admission write failure/);
	try {
		await cleaning.promise;
		assert.equal(sessions["newSessionAdmissions"].size, 1);
		await assert.rejects(sessions.spawnDurable(request, op.targetId.toLowerCase(), randomUUID()), /aliases/);
		gate.resolve();
		await rejected;
		assert.equal(sessions["newSessionAdmissions"].size, 0);
		assert.equal(sessions["durableCreateAdmissions"].size, 0);
		assert.deepEqual(await readdir(join(home, "sessions")), []);
		fail = false;
		assert.equal((await sessions.spawnDurable(request, op.targetId, op.operationId)).id, op.targetId);
		assert.deepEqual(await readdir(join(home, "sessions")), [op.targetId]);
		const persisted = JSON.parse(await readFile(join(home, "sessions", op.targetId, "meta.json"), "utf8"));
		assert.equal(persisted.createOperationId, op.operationId);
		assert.equal(persisted.pending.length, 1);
	} finally {
		gate.resolve();
		await rejected;
		await sessions.shutdown();
	}
});

test("failure after metadata save rolls back membership and disk before releasing the new-ID fence", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-native-create-durability-failure-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const op = intent(home);
	const projects = new ProjectStore(home);
	const project = await projects.create({ path: home, workspace: "direct" });
	const sessions = new SessionManager(home, projects);
	const start = t.mock.method(
		sessions as unknown as { start(): Promise<Map<string, Error>> },
		"start",
		async () => new Map(),
	);
	const gate = barrier(),
		saved = barrier();
	const members = new Set<string>();
	let fail = true;
	const bridge: SessionMissionBridge = {
		spawnProject: () => project.id,
		joinSpawn: (id) => {
			members.add(id);
		},
		leaveSpawn: (id) => {
			members.delete(id);
		},
		membership: (id) => (members.has(id) ? { missionId: "m", active: true } : undefined),
		context: () => undefined,
		call: async () => undefined,
		whenDurable: async () => {
			saved.resolve();
			await gate.promise;
			if (fail) throw new Error("injected post-save durability failure");
		},
	};
	sessions.setMissionBridge(bridge);
	const request = { missionId: "m", message: "one original input" };
	const admission = sessions.spawnDurable(request, op.targetId, op.operationId);
	const rejected = assert.rejects(admission, /injected post-save durability failure/);
	try {
		await saved.promise;
		const path = join(home, "sessions", op.targetId, "meta.json");
		const before = await readFile(path, "utf8");
		assert.equal(JSON.parse(before).createOperationId, op.operationId);
		assert.equal(members.has(op.targetId), true);
		assert.equal(sessions["newSessionAdmissions"].size, 1);
		await assert.rejects(sessions.spawnDurable(request, op.targetId.toLowerCase(), randomUUID()), /aliases/);
		assert.equal(await readFile(path, "utf8"), before);
		assert.equal(start.mock.callCount(), 0);
		gate.resolve();
		await rejected;
		assert.equal(sessions["newSessionAdmissions"].size, 0);
		assert.equal(sessions["durableCreateAdmissions"].size, 0);
		assert.equal(members.size, 0);
		assert.deepEqual(sessions.list(), []);
		assert.deepEqual(await readdir(join(home, "sessions")), []);
		fail = false;
		assert.equal((await sessions.spawnDurable(request, op.targetId, op.operationId)).id, op.targetId);
		assert.equal(start.mock.callCount(), 1);
		const after = JSON.parse(await readFile(path, "utf8"));
		assert.equal(after.pending.length, 1);
		assert.equal(after.pending[0].requestId, op.operationId);
		assert.deepEqual(await readdir(join(home, "sessions")), [op.targetId]);
	} finally {
		gate.resolve();
		await rejected;
		await sessions.shutdown();
	}
});

test("mkdir failure releases only its own new-ID fence so the original operation can retry", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-native-create-mkdir-failure-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const op = intent(home);
	const sessions = new SessionManager(home, new ProjectStore(home));
	t.mock.method(sessions as unknown as { start(): Promise<Map<string, Error>> }, "start", async () => new Map());
	t.after(() => sessions.shutdown());
	await writeFile(join(home, "sessions"), "disposable directory blocker");
	const request = { cwd: home, message: "original input" };
	await assert.rejects(sessions.spawnDurable(request, op.targetId, op.operationId), { code: "ENOTDIR" });
	assert.equal(sessions["newSessionAdmissions"].size, 0);
	assert.equal(sessions["durableCreateAdmissions"].size, 0);
	await rm(join(home, "sessions"));
	assert.equal((await sessions.spawnDurable(request, op.targetId, op.operationId)).id, op.targetId);
	assert.deepEqual(await readdir(join(home, "sessions")), [op.targetId]);
});
