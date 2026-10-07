import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("changes summary GET returns only metadata and counts and preserves route guards", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-server-summary-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	git("init", "--quiet", "-b", "main");
	writeFileSync(join(root, "a.txt"), "base\n");
	git("add", ".");
	git("commit", "--quiet", "-m", "base");
	const base = git("rev-parse", "HEAD").trim();
	writeFileSync(join(root, "a.txt"), "changed\n");
	writeFileSync(join(root, "untracked.txt"), "new\n");
	const projects = new ProjectStore(root);
	const sessions = new SessionManager(root, projects);
	const originalChangeBase = sessions.changeBase.bind(sessions);
	let preparing = false;
	const changeBase = t.mock.method(sessions, "changeBase", (id: string) => {
		if (id !== "session-1") return originalChangeBase(id);
		if (preparing) throw new Error("Session workspace is still preparing");
		return { cwd: root, base };
	});
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: root, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(root),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/session-1/changes`;
	const response = await fetch(`${url}/summary`);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /application\/json/);
	assert.deepEqual(await response.json(), { base, branch: "main", fileCount: 2, additions: 2, deletions: 1 });
	assert.deepEqual(changeBase.mock.calls[0]?.arguments, ["session-1"]);
	const full = await fetch(url);
	assert.equal(full.status, 200);
	const changes = (await full.json()) as { base: string; files: unknown[]; diff: string };
	assert.equal(changes.base, base);
	assert.equal(changes.files.length, 2);
	assert.match(changes.diff, /\+changed/);
	for (const [path, options, status] of [
		[`${url}/summary`, { method: "POST" }, 404],
		[`${url}/summary/extra`, {}, 404],
		[`${url}/summary`, { headers: { origin: "https://example.com" } }, 403],
	] as const) {
		const rejected = await fetch(path, options);
		assert.equal(rejected.status, status);
		await rejected.arrayBuffer();
	}
	assert.equal(changeBase.mock.callCount(), 2, "method, path and origin guards run before resolving the session");
	const missing = await fetch(`${url.replace("session-1", "missing")}/summary`);
	assert.equal(missing.status, 404);
	assert.match(((await missing.json()) as { error: string }).error, /Unknown session/);
	preparing = true;
	const pending = await fetch(`${url}/summary`);
	assert.equal(pending.status, 400);
	assert.deepEqual(await pending.json(), { error: "Session workspace is still preparing" });
});

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
			["sessions/missing/queue/42", "DELETE"],
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

test("queued message DELETE forwards only the ID, reports stale removal, and rejects invalid IDs and origins", async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const terminals = new TerminalManager();
	let stale = false;
	const remove = t.mock.method(sessions, "removeQueuedMessage", async () => {
		if (stale) throw new Error("Message is no longer queued. It has not been removed.");
	});
	const send = t.mock.method(sessions, "send", async () => assert.fail("removal must never submit input"));
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
	);
	t.after(async () => {
		terminals.shutdown();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/session-1/queue`;
	const response = await fetch(`${base}/42`, { method: "DELETE" });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	assert.deepEqual(remove.mock.calls[0]?.arguments, ["session-1", 42]);
	stale = true;
	const rejected = await fetch(`${base}/42`, { method: "DELETE" });
	assert.equal(rejected.status, 400);
	assert.deepEqual(await rejected.json(), { error: "Message is no longer queued. It has not been removed." });
	for (const id of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "1e2", "0x2a", "42oops"]) {
		const invalid = await fetch(`${base}/${id}`, { method: "DELETE" });
		assert.equal(invalid.status, 400);
		assert.deepEqual(await invalid.json(), { error: "Invalid queued message ID" });
	}
	const browser = await fetch(`${base}/42`, { method: "DELETE", headers: { origin: "https://example.com" } });
	assert.equal(browser.status, 403);
	await browser.arrayBuffer();
	assert.equal(remove.mock.callCount(), 2);
	assert.equal(send.mock.callCount(), 0);
});
