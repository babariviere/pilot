import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { payloadHash } from "./canonical.ts";
import { ConnectionControls } from "./connection-controls.ts";
import { daemonHello } from "./hello.ts";
import { ModelCatalog } from "./models.ts";
import { NativeAppCapability } from "./native-app-capability.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { createDaemonFixtureServer } from "./testing/daemon-server.ts";

test("native controls hide receipts without capability and never enter a pending effect during recovery", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-control-recovery-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const hello = await daemonHello(home, {
		independentExecution: true,
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
		coordinatorIsolation: false,
	});
	const host = { hostId: "daemon", daemonId: hello.daemonId, lineageId: hello.lineageId! };
	const nativeAuthority = new NativeAppCapability(home, host);
	const server = createDaemonFixtureServer({
		config: { home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		models: new ModelCatalog(home),
		terminals,
		hello,
		nativeAuthority,
	});
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await server.closeServices();
		await sessions.shutdown();
		await terminals.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await server.runtimeReady;
	await nativeAuthority.open();
	const { token } = JSON.parse(await readFile(join(home, "github-app-capability"), "utf8"));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const post = async (op: DurableOperation, suffix: string, capability?: string) => {
		const response = await fetch(`${root}/api/operations${suffix}`, {
			method: "POST",
			body: JSON.stringify(op),
			headers: {
				"content-type": "application/json",
				...(capability ? { "x-pilot-github-capability": capability } : {}),
			},
		});
		assert.equal(response.headers.get("cache-control"), "no-store");
		return { status: response.status, body: await response.json() };
	};

	const journal = server.services.journal!;
	const payload = JSON.stringify({ purpose: "connection-controls", binding: "saved", action: "cancel", value: {} });
	const op: DurableOperation = {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: "native-test",
		sequence: 1,
		origin: { ...host, hostId: "local" },
		destination: host,
		kind: "connection-controls",
		targetId: "global-connections",
		payload,
		payloadHash: payloadHash(payload),
	};
	const pending = await journal.reserve(op);
	assert.equal(pending.state, "pending");
	const admit = t.mock.method(ConnectionControls.prototype, "admit", async () => {
		throw new Error("Recovery must not enter the control");
	});
	// Use a conflicting retry to prove authentication rejects the request before any lookup.
	assert.deepEqual(await post({ ...op, targetId: "other" }, "/receipt"), {
		status: 403,
		body: { error: "This operation requires the native app's host-authenticated GitHub action." },
	});
	assert.deepEqual(await post(op, "/receipt", token), { status: 200, body: pending });
	assert.deepEqual(await post(op, "/other", token), { status: 404, body: { error: "Not found" } });
	assert.deepEqual(await post({ ...op, kind: "diagnostics-controls" }, "/receipt", token), {
		status: 503,
		body: { error: "Native diagnostics unavailable" },
	});

	const recover = t.mock.method(journal, "recover");
	server.services.recoverOperations();
	assert.equal(recover.mock.callCount(), 1);
	await recover.mock.calls[0]?.result;
	assert.deepEqual(await post(op, "/receipt", token), { status: 200, body: pending });
	assert.equal(admit.mock.callCount(), 0);
});
