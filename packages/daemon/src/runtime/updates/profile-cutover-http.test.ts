import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelCatalog } from "../../models/models.ts";
import { OperationJournal, payloadHash } from "../../transport/operations/operation-journal.ts";
import { ProjectStore } from "../../projects/projects.ts";
import { SessionManager } from "../../sessions/sessions.ts";
import { TerminalManager } from "../../sessions/terminals/terminals.ts";
import { createDaemonFixtureServer as createDaemonServer } from "../../testing/daemon-server.ts";

const host = { hostId: "local", daemonId: "mac", lineageId: "local-history" };
const target = { hostId: "box", daemonId: "linux", lineageId: "remote-history" };

test("Local HTTP works without admitting foreign drafts or legacy routes", async () => {
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
		kind: "chat-create",
		targetId: randomUUID(),
		payload: "{}",
		payloadHash: payloadHash("{}"),
	};
	const journal = new OperationJournal(join(home, "operations"), op.destination);
	const send = "chat-send";
	const operations = [
		op,
		{ ...op, operationId: randomUUID(), sequence: 3, kind: send },
		{
			...op,
			operationId: randomUUID(),
			sequence: 4,
			kind: send,
			origin: host,
			destination: { ...op.destination, hostId: "box" },
		},
		{ ...op, operationId: randomUUID(), sequence: 5, kind: send, origin: { ...host, hostId: "box" } },
	];
	const local = { ...op, operationId: randomUUID(), sequence: 6, kind: "chat-create", origin: host };
	for (const operation of [...operations, local]) await journal.reserve(operation);
	const receipts = operations.map((operation) =>
		join(home, "operations", `${payloadHash(operation.operationId)}.json`),
	);
	const before = await Promise.all(receipts.map((path) => readFile(path)));
	const args: Parameters<typeof createDaemonServer>[0] = {
		config: { home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		models: new ModelCatalog("/unused"),
		terminals,
	};
	args.hello = {
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
	const server = createDaemonServer(args);
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		assert.equal((await fetch(`${base}/api/sessions`)).status, 200);
		const request = (operation: typeof op) => ({
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(operation),
		});
		server.services.recoverOperations();
		for (const operation of operations) {
			assert.equal((await fetch(`${base}/api/operations`, request(operation))).status, 409);
		}
		for (const kind of ["share-note", "control.start"]) {
			const removed = { ...local, kind, operationId: randomUUID() };
			assert.equal((await fetch(`${base}/api/operations`, request(removed))).status, 400);
			const file = join(home, "operations", `${payloadHash(removed.operationId)}.json`);
			await assert.rejects(readFile(file), { code: "ENOENT" });
		}
		const lookupLocal = async () =>
			((await (await fetch(`${base}/api/operations/receipt`, request(local))).json()) as { state: string }).state;
		for (let remaining = 100; remaining > 0 && (await lookupLocal()) === "pending"; remaining--)
			await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(await lookupLocal(), "rejected", "Local startup recovery still processes its own operation");
		assert.deepEqual(await Promise.all(receipts.map((path) => readFile(path))), before);
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
