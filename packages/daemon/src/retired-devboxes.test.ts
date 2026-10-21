import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DelegationGrant } from "@pilot/protocol";
import { legacyRuntimeUpdateFrozen } from "./legacy-runtime-update.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { isRetiredDevboxOperation, RetiredDevboxes } from "./retired-devboxes.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

const host = { hostId: "local", daemonId: "mac", lineageId: "local-history" };
const target = { hostId: "box", daemonId: "linux", lineageId: "remote-history" };

function grant(state: DelegationGrant["state"]): DelegationGrant {
	return {
		delegationId: "grant",
		task: { mission: { home: host, missionId: "mission" }, taskId: "task" },
		executionEpoch: 1,
		bindingId: "binding",
		bindingGeneration: 1,
		target: { host: target, projectId: "project" },
		session: { host: target, sessionId: "remote-chat" },
		definitionRevision: 1,
		context: { mission: 1, memory: 1 },
		manifestId: "manifest",
		references: [],
		request: { message: "original scope" },
		state,
	};
}

test("retirement preserves every execution record, fences remote admission and leaves Local usable", async () => {
	for (const state of ["accepted", "cancel_requested", "sealed"] as const) {
		const store = new MissionStore(":memory:");
		try {
			const execution = { grant: grant(state), operationId: "original", state, sequence: 1 };
			store.sharingPut("execution-session", "remote-chat", { scope: "old-scope", id: "grant" });
			store.sharingPut("old-scope", "grant", execution);
			await store.durable();
			const retired = new RetiredDevboxes(host, store);
			assert.deepEqual(retired.membership("remote-chat"), execution);
			assert.throws(() => retired.assertAdmission("remote-chat"), /retired/);
			assert.throws(() => retired.assertCreate("remote-chat", "original"), /retired/);
			assert.throws(() => retired.assertCreate("remote-chat", "replacement"), /retired/);
			await assert.rejects(retired.assertRunnable("remote-chat"), /retired/);
			assert.throws(() => retired.context("remote-chat"), /retired/);
			await assert.rejects(retired.missionCall("remote-chat", "tasks", {}), /retired/);
			await assert.rejects(retired.memoryCall("remote-chat", "note", { text: "must not write" }), /retired/);
			await assert.rejects(retired.readArtifact("remote-chat", "artifact"), /retired/);
			retired.assertAdmission("local-chat");
			retired.assertCreate("local-chat", "local-input");
			await retired.assertRunnable("local-chat");
			assert.equal(retired.membership("local-chat"), undefined);
			assert.deepEqual(store.sharingGet("old-scope", "grant"), execution);
			assert.deepEqual(store.sharingGet("execution-session", "remote-chat"), { scope: "old-scope", id: "grant" });
			store.sharingPut("execution-session", "dangling", { scope: "missing", id: "grant" });
			assert.throws(() => retired.assertAdmission("dangling"), /retired/, "missing legacy records fail closed");
		} finally {
			await store.durable();
			store.close();
		}
	}
});

test("retained remote allocations never imply release or allow automatic reassignment", () => {
	let stored = grant("accepted");
	const lastKnown = { event: { kind: "result", payload: { working: false, runningJobs: [] } } };
	const retired = new RetiredDevboxes(host, {
		sharedMissionGrants: (id) => (id === "mission" ? [structuredClone(stored)] : []),
		sharingGet: <T>(namespace: string) =>
			namespace === "remote-projection" ? (structuredClone(lastKnown) as T) : undefined,
		sharingList: () => [],
	});
	assert.equal(retired.remoteOccupied("mission"), true, "stale completion evidence is not a seal");
	assert.equal(retired.remoteOccupied("other"), false);
	assert.deepEqual(retired.missionAllocations("mission"), [
		{
			grant: stored,
			lastKnown,
			artifacts: [],
			ownershipOccupied: true,
			availability: "remote-devboxes-retired",
		},
	]);
	stored = grant("sealed");
	assert.equal(retired.remoteOccupied("mission"), false);
	assert.equal(retired.missionAllocations("mission").length, 1, "sealed history is retained too");
});

test("local server works without admitting remote sharing or Control transports", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-retired-devboxes-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const op = {
		schemaVersion: 1 as const,
		operationId: randomUUID(),
		producerId: "app",
		sequence: 1,
		origin: target,
		destination: { ...host, hostId: "daemon" },
		kind: "control.start",
		targetId: randomUUID(),
		payload: "{}",
		payloadHash: payloadHash("{}"),
	};
	const journal = new OperationJournal(join(home, "operations"), op.destination);
	await journal.reserve(op);
	const receiptFile = join(home, "operations", `${payloadHash(op.operationId)}.json`);
	const before = await readFile(receiptFile);
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	];
	args[12] = {
		daemonId: host.daemonId,
		lineageId: host.lineageId,
		daemonVersion: "test",
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		platform: "darwin",
		arch: "arm64",
		capabilities: {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: false,
			coordinatorIsolation: false,
			independentExecution: true,
		},
	};
	const server = createDaemonServer(...args);
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		assert.equal((await fetch(`${base}/api/sessions`)).status, 200);
		const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) };
		assert.equal((await fetch(`${base}/api/operations`, request)).status, 410);
		const lookup = await fetch(`${base}/api/operations/receipt`, request);
		assert.equal(lookup.status, 200);
		assert.equal(((await lookup.json()) as { state: string }).state, "pending");
		assert.deepEqual(await readFile(receiptFile), before);
		for (const path of ["shared-contexts", "control-hosts", "runtime-update", "delegations"]) {
			const response = await fetch(`${base}/api/${path}`);
			assert.ok([404, 503].includes(response.status), `${path}: ${response.status}`);
		}
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await terminals.shutdown();
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	}
});

test("retired updater ownership is read-only and unresolved or corrupt records fail closed", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-legacy-update-"));
	const file = join(home, "runtime-update", "current.json");
	try {
		assert.equal(await legacyRuntimeUpdateFrozen(home), false);
		await assert.rejects(readFile(file), { code: "ENOENT" });
		await mkdir(join(home, "runtime-update"), { mode: 0o700 });
		for (const phase of ["staged", "requested", "waiting", "draining", "needs-repair", "completed", "cancelled"]) {
			const bytes = JSON.stringify({
				schema: 1,
				phase,
				id: randomUUID(),
				revision: 1,
				blockers: [],
				daemonId: host.daemonId,
				lineageId: host.lineageId,
				version: "1",
				from: "/old",
				to: "/new",
				oldUnit: "old",
				newUnit: "new",
				archive: "/archive",
				manifest: "/manifest",
				signature: "/signature",
				publicKey: "key",
			});
			await writeFile(file, bytes, { mode: 0o600 });
			await chmod(file, 0o600);
			assert.equal(await legacyRuntimeUpdateFrozen(home), !["completed", "cancelled"].includes(phase));
			assert.equal(await readFile(file, "utf8"), bytes);
		}
		await writeFile(file, JSON.stringify({ schema: 1, phase: "completed" }));
		assert.equal(await legacyRuntimeUpdateFrozen(home), true, "malformed terminal records never release ownership");
		await writeFile(file, "{corrupt");
		assert.equal(await legacyRuntimeUpdateFrozen(home), true);
		assert.equal(await readFile(file, "utf8"), "{corrupt");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Local recovery leaves retired operation receipts byte-for-byte pending", async () => {
	const home = await mkdtemp(join(tmpdir(), "pilot-legacy-operations-"));
	try {
		const journal = new OperationJournal(home, host);
		const payload = "{}";
		const operations = ["share-note", "control.start", "chat-create"].map((kind, index) => ({
			schemaVersion: 1 as const,
			operationId: randomUUID(),
			producerId: "app",
			sequence: index + 1,
			origin: target,
			destination: host,
			kind,
			targetId: randomUUID(),
			payload,
			payloadHash: payloadHash(payload),
		}));
		for (const op of operations) await journal.reserve(op);
		const files = operations.map((op) => join(home, `${payloadHash(op.operationId)}.json`));
		const before = await Promise.all(files.map((file) => readFile(file)));
		const calls: string[] = [];
		await new OperationJournal(home, host).recover(
			async (op) => {
				calls.push(op.kind);
				return {};
			},
			(op) => !isRetiredDevboxOperation(op.kind),
		);
		assert.deepEqual(calls, ["chat-create"]);
		for (let index = 0; index < 2; index++) {
			assert.deepEqual(await readFile(files[index]!), before[index]);
			assert.equal((await new OperationJournal(home, host).lookup(operations[index]!))?.state, "pending");
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
