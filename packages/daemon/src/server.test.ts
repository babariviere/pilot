import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("queued message PATCH forwards the message ID and content and reports stale edits", async (t) => {
	const projects = new ProjectStore("/tmp/pilot-server-test-unused");
	const sessions = new SessionManager("/tmp/pilot-server-test-unused", projects);
	const terminals = new TerminalManager();
	let stale = false;
	const edit = t.mock.method(sessions, "editQueuedMessage", async () => {
		if (stale) throw new Error("Message is no longer queued. Your edit has not been sent.");
	});
	const server = createDaemonServer(
		{ home: "/tmp/pilot-server-test-unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/tmp/pilot-server-test-unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/session-1/queue/42`;
	const request = {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "Edited\nDetails" }),
	};
	const response = await fetch(url, request);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	assert.deepEqual(edit.mock.calls[0]?.arguments, ["session-1", 42, "Edited\nDetails"]);
	stale = true;
	const rejected = await fetch(url, request);
	assert.equal(rejected.status, 400);
	assert.deepEqual(await rejected.json(), { error: "Message is no longer queued. Your edit has not been sent." });
	assert.equal(edit.mock.callCount(), 2, "a stale edit must not fall back to sending a new message");
	const wrongMethod = await fetch(url, { ...request, method: "POST" });
	assert.equal(wrongMethod.status, 404);
	await wrongMethod.arrayBuffer();
	const malformed = await fetch(url, { ...request, body: "{" });
	assert.equal(malformed.status, 400);
	await malformed.arrayBuffer();
	const wrongContentType = await fetch(url, { ...request, headers: { "content-type": "text/plain" } });
	assert.equal(wrongContentType.status, 415);
	await wrongContentType.arrayBuffer();
	const browser = await fetch(url, { ...request, headers: { ...request.headers, origin: "https://example.com" } });
	assert.equal(browser.status, 403);
	await browser.arrayBuffer();
	assert.equal(edit.mock.callCount(), 2);
});

test("prepare uses the origin-protected route and paused admissions return HTTP 503", async () => {
	// Isolated ephemeral HTTP server. No stores are loaded, workers forked, or terminals started.
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		new TerminalManager(),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	try {
		const browser = await fetch(`${base}/update/prepare`, {
			method: "POST",
			headers: { origin: "http://localhost" },
		});
		assert.equal(browser.status, 403);
		// Rejected browser preparation did not freeze admission.
		await assert.rejects(sessions.send("missing", "hello"), /Unknown session/);
		assert.equal((await fetch(`${base}/update/prepare`)).status, 404);
		const ready = await fetch(`${base}/update/prepare`, { method: "POST" });
		assert.equal(ready.status, 200);
		assert.deepEqual(await ready.json(), { ready: true });
		for (const [path, method] of [
			["sessions", "POST"],
			["sessions/missing/messages", "POST"],
			["sessions/missing/queue/42", "PATCH"],
		]) {
			const response = await fetch(`${base}/${path}`, {
				method,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd: "/unused", message: "hello" }),
			});
			assert.equal(response.status, 503);
			assert.match(((await response.json()) as { error: string }).error, /temporarily paused/);
		}
		// Preparation never stops the server; existing read endpoints still work.
		assert.equal((await fetch(`${base}/sessions`)).status, 200);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
