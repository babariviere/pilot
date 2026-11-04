import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("reload API observes passively, validates intent and pushes status without opening chats", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-pi-reload-"));
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects, undefined, {
		worker: () => assert.fail("must not open a worker"),
	});
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const ws = new WebSocket(`${origin.replace("http:", "ws:")}/api/ws`);
	t.after(async () => {
		ws.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await sessions.shutdown();
		await terminals.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	const initial = once(ws, "message");
	await once(ws, "open");
	assert.deepEqual(JSON.parse(String((await initial)[0])), { type: "pi.reload", reload: sessions.piReload.status() });
	const path = `${origin}/api/pi/reload`;
	assert.equal((await (await fetch(path)).json()).operationId, null);
	for (const body of [{}, { operationId: "bad" }, { operationId: 1 }]) {
		const response = await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.equal(response.status, 400);
		await response.arrayBuffer();
	}
	assert.equal(sessions.piReload.status().operationId, null);
	const operationId = randomUUID();
	const pushed = new Promise<unknown>((resolve) =>
		ws.on("message", (bytes) => {
			const message = JSON.parse(String(bytes));
			if (message.type === "pi.reload" && message.reload.operationId === operationId) resolve(message.reload);
		}),
	);
	const response = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ operationId }),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), await pushed);
	assert.deepEqual(await (await fetch(path)).json(), sessions.piReload.status());
	const release = sessions.freezeAdmissions();
	const blocked = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ operationId: randomUUID() }),
	});
	assert.equal(blocked.status, 503);
	await blocked.arrayBuffer();
	release();
});
