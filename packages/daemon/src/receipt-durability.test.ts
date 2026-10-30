import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { OperationJournal, OperationRejected, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

test("receipt HTTP lookup is isolated from unrelated mission durability", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-receipt-barrier-"));
	const host = { hostId: "daemon", daemonId: "daemon", lineageId: "lineage" };
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const store = new MissionStore(":memory:");
	const service = new MissionService(store, sessions, projects);
	const terminals = new TerminalManager();
	const journal = new OperationJournal(join(home, "operations"), host);
	const op = (sequence: number) => ({
		schemaVersion: 1 as const,
		operationId: randomUUID(),
		producerId: "app",
		sequence,
		origin: host,
		destination: host,
		kind: "control.start",
		targetId: randomUUID(),
		payload: "{}",
		payloadHash: payloadHash("{}"),
	});
	const pending = op(1),
		accepted = op(2),
		rejected = op(3),
		unknown = op(4);
	const expected = [
		await journal.reserve(pending),
		await journal.execute(accepted, async () => ({ ok: true })),
		await journal.execute(rejected, async () => {
			throw new OperationRejected("no");
		}),
	];
	const mission = store.create({ projectId: "project", title: "Control" });
	const hello = {
		daemonId: host.daemonId,
		lineageId: host.lineageId,
		daemonVersion: "test",
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		platform: "darwin" as const,
		arch: "arm64" as const,
		capabilities: {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: false,
			coordinatorIsolation: false,
			independentExecution: true,
		},
	};
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
		{ service, store },
	];
	args[12] = hello;
	const server = createDaemonServer(...args);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const durable = store.durable.bind(store);
	t.after(async () => {
		store.durable = durable;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
		await sessions.shutdown();
		await store.durable();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	const post = (path: string, body: unknown) =>
		fetch(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const lifecycle = {
		operationId: randomUUID(),
		home: { daemonId: "daemon", lineageId: "lineage" },
		projectId: "project",
		expectedStatus: "active",
		action: "archive",
	};
	const gate = deferred(),
		entered = deferred(),
		otherEntered = deferred(),
		parseEntered = deferred();
	let calls = 0;
	store.durable = () => {
		calls++;
		entered.resolve();
		if (calls === 2) otherEntered.resolve();
		if (calls === 3) parseEntered.resolve();
		return gate.promise;
	};
	let answered = false;
	const control = post(`/api/missions/${mission.id}/lifecycle`, lifecycle).then((response) => {
		answered = true;
		return response;
	});
	// http.request preserves dot segments that fetch normalizes before sending.
	const rawPost = (path: string, body: unknown) =>
		new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
			const req = request(
				{
					hostname: "127.0.0.1",
					port: (server.address() as AddressInfo).port,
					path,
					method: "POST",
					headers: { "content-type": "application/json" },
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () =>
						resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }),
					);
				},
			);
			req.on("error", reject);
			req.end(JSON.stringify(body));
		});
	let other: Promise<Response> | undefined;
	let malformed: Promise<{ status: number | undefined; body: unknown }> | undefined;
	let otherAnswered = false;
	let malformedAnswered = false;
	try {
		await entered.promise;
		assert.equal(store.require(mission.id).status, "archived");
		for (const [index, value] of [pending, accepted, rejected].entries()) {
			const response = await post("/api/operations/receipt", value);
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), expected[index]);
		}
		for (const path of [
			"/api/operations/receipt?x=1",
			"/api//operations/receipt/",
			"/api/operations/other/../receipt",
		]) {
			const response = await rawPost(path, pending);
			assert.equal(response.status, 200);
			assert.deepEqual(response.body, expected[0]);
		}
		const missing = await post("/api/operations/receipt", unknown);
		assert.deepEqual(await missing.json(), { state: "unknown" });
		for (const value of [
			{ ...pending, payload: "changed" },
			{ ...pending, targetId: randomUUID() },
			{ ...pending, destination: { ...host, lineageId: "other" } },
			{},
		]) {
			const response = await post("/api/operations/receipt", value);
			assert.equal(response.status, 400);
		}
		other = post("/api//operations/release-attachments/", {}).then((response) => {
			otherAnswered = true;
			return response;
		});
		await otherEntered.promise;
		malformed = rawPost("http://[", {}).then((response) => {
			malformedAnswered = true;
			return response;
		});
		await parseEntered.promise;
		assert.equal(calls, 3);
		assert.equal(answered, false);
		assert.equal(otherAnswered, false);
		assert.equal(malformedAnswered, false);
	} finally {
		gate.resolve();
	}
	assert.equal((await control).status, 200);
	assert.equal((await other!).status, 400);
	assert.equal((await malformed!).status, 400);
	const failed = deferred();
	const failedEntered = deferred();
	store.durable = () => {
		failedEntered.resolve();
		return failed.promise;
	};
	const rejectedControl = post(`/api/missions/${mission.id}/lifecycle`, lifecycle);
	await failedEntered.promise;
	failed.reject(new Error("unrelated mission disk failure"));
	await assert.rejects(rejectedControl);
	const receipt = await post("/api/operations/receipt", pending);
	assert.equal(receipt.status, 200);
	assert.deepEqual(await receipt.json(), expected[0]);
});

test("receipt HTTP lookup reports journal initialization failure", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-receipt-fault-"));
	await mkdir(join(home, "operations"));
	await writeFile(join(home, "operations", "floors.json"), "not json");
	const projects = new ProjectStore(home),
		sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager(),
		store = new MissionStore(":memory:");
	const service = new MissionService(store, sessions, projects);
	const args: Parameters<typeof createDaemonServer> = [
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
		{ store, service },
	];
	args[12] = {
		daemonId: "daemon",
		lineageId: "lineage",
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
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
		await sessions.shutdown();
		await store.durable();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	const host = { hostId: "daemon", daemonId: "daemon", lineageId: "lineage" };
	const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/operations/receipt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: "app",
			sequence: 1,
			origin: host,
			destination: host,
			kind: "chat-create",
			targetId: randomUUID(),
			payload: "{}",
			payloadHash: payloadHash("{}"),
		}),
	});
	assert.equal(response.status, 400);
	assert.notDeepEqual(await response.json(), { state: "unknown" });
});
