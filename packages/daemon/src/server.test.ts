import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent, ServerMessage, SessionSummary } from "@pilot/protocol";
import { WebSocket } from "ws";
import { RepositoryChanges } from "./changes.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("repository invalidation ignores title and quota updates, but preserves work and workspace refreshes", (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const initial: SessionSummary = {
		id: "one",
		cwd: "/work",
		title: "old",
		state: "working",
		createdAt: 1,
		updatedAt: 2,
	};
	t.mock.method(sessions, "list", () => [initial]);
	let updated!: Parameters<SessionManager["onChange"]>[0];
	t.mock.method(sessions, "onChange", (listener: typeof updated) => {
		updated = listener;
		return () => {};
	});
	const invalidated: string[] = [];
	t.mock.method(RepositoryChanges.prototype, "invalidate", (cwd: string) => invalidated.push(cwd));
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		new TerminalManager(),
	);
	t.after(() => server.close());
	updated({ ...initial, title: "generated" });
	updated({ ...initial, usage: { subscription: { fetchedAt: 3, windows: [] } } });
	updated({ ...initial, model: "other/model", thinking: "high" });
	assert.deepEqual(invalidated, [], "metadata-only updates keep repository cache hits, even during work");
	const working = { ...initial, updatedAt: 4 };
	updated(working);
	updated({ ...working, title: "new title" });
	assert.deepEqual(invalidated, ["/work"], "new work invalidates once");
	const completed = { ...working, state: "idle" as const, outcome: "done" as const, outcomeAt: 5 };
	updated(completed);
	updated({ ...completed, usage: { subscription: { fetchedAt: 6, windows: [] } } });
	assert.deepEqual(invalidated, ["/work", "/work"], "completion refreshes repository changes");
	updated({ ...completed, cwd: "/new-work" });
	assert.deepEqual(invalidated, ["/work", "/work", "/work", "/new-work"]);
});

test("project branches GET returns live origin heads/default, sensible empty lists and clear remote errors", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pilot-server-branches-"));
	const remote = join(root, "remote.git");
	const source = join(root, "source");
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	git(root, "init", "--quiet", "--bare", "-b", "main", remote);
	git(root, "clone", "--quiet", remote, source);
	writeFileSync(join(source, "a.txt"), "base\n");
	git(source, "add", ".");
	git(source, "commit", "--quiet", "-m", "base");
	git(source, "push", "--quiet", "origin", "HEAD:main", "HEAD:topic");
	const projects = new ProjectStore(join(root, "home"));
	await projects.load();
	const project = await projects.create({ path: source });
	const noOrigin = await projects.create({ path: root });
	const sessions = new SessionManager(root, projects);
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
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
	const url = `${base}/${project.id}/branches`;
	const response = await fetch(url);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { branches: ["main", "topic"], defaultBranch: "main" });
	assert.deepEqual(await (await fetch(`${base}/${noOrigin.id}/branches`)).json(), { branches: [] });
	for (const [path, options, status] of [
		[`${base}/missing/branches`, {}, 404],
		[url, { method: "POST" }, 404],
		[`${url}/extra`, {}, 404],
		[url, { headers: { origin: "https://example.com" } }, 403],
	] as const) {
		const rejected = await fetch(path, options);
		assert.equal(rejected.status, status);
		await rejected.arrayBuffer();
	}
	await projects.update(project.id, { workspace: "direct" });
	rmSync(remote, { recursive: true, force: true });
	assert.deepEqual(await (await fetch(url)).json(), { branches: [] });
	await projects.update(project.id, { workspace: "clone" });
	const unavailable = await fetch(url);
	assert.equal(unavailable.status, 503);
	assert.match(((await unavailable.json()) as { error: string }).error, /Unable to list origin branches/);
});

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
	let updated!: Parameters<SessionManager["onChange"]>[0];
	t.mock.method(sessions, "onChange", (listener: typeof updated) => {
		updated = listener;
		return () => {};
	});
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
	writeFileSync(join(root, "untracked.txt"), "new\nexternal edit\n");
	updated({ id: "session-1", title: "test", cwd: root, createdAt: 0, updatedAt: 1, state: "idle" });
	const invalidated = await fetch(`${url}/summary`);
	assert.equal(invalidated.status, 200);
	assert.deepEqual(await invalidated.json(), { base, branch: "main", fileCount: 2, additions: 3, deletions: 1 });
	const invalidatedFull = await fetch(url);
	assert.match(((await invalidatedFull.json()) as { diff: string }).diff, /\+external edit/);
	const missing = await fetch(`${url.replace("session-1", "missing")}/summary`);
	assert.equal(missing.status, 404);
	assert.match(((await missing.json()) as { error: string }).error, /Unknown session/);
	preparing = true;
	const pending = await fetch(`${url}/summary`);
	assert.equal(pending.status, 400);
	assert.deepEqual(await pending.json(), { error: "Session workspace is still preparing" });
});

test("websocket overload closes with a reconnect instruction and resubscription starts with a fresh snapshot", {
	timeout: 30_000,
}, async (t) => {
	const projects = new ProjectStore("/unused");
	const sessions = new SessionManager("/unused", projects);
	const snapshot: AgentEvent = {
		type: "snapshot",
		entries: [],
		tools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: { models: {}, tools: {} },
	};
	let deliver!: Parameters<SessionManager["subscribe"]>[1];
	let unsubscribed = 0;
	t.mock.method(sessions, "subscribe", (_id: string, listener: typeof deliver) => {
		deliver = listener;
		listener([snapshot]);
		return () => {
			unsubscribed++;
		};
	});
	t.mock.method(sessions, "artifacts", async () => []);
	const server = createDaemonServer(
		{ home: "/unused", host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		new TerminalManager(),
	);
	const sockets: WebSocket[] = [];
	t.after(async () => {
		for (const socket of sockets) socket.terminate();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`;
	const subscribe = async () => {
		const socket = new WebSocket(url);
		sockets.push(socket);
		const received = new Promise<ServerMessage>((resolve) => {
			socket.on("message", (data) => {
				const message = JSON.parse(String(data)) as ServerMessage;
				if (message.type === "events") resolve(message);
			});
		});
		await once(socket, "open");
		socket.send(JSON.stringify({ type: "subscribe", sessionId: "session-1" }));
		assert.deepEqual(await received, { type: "events", sessionId: "session-1", events: [snapshot] });
		return socket;
	};
	const first = await subscribe();
	const closed = once(first, "close");
	const buffered = t.mock.getter(WebSocket.prototype, "bufferedAmount", () => 128 * 1024 * 1024);
	deliver([{ type: "queue_update", items: [] }]);
	buffered.mock.restore();
	const [code, reason] = await closed;
	assert.equal(code, 1013);
	assert.match(String(reason), /Reconnect.*snapshot/);
	// The server close event releases the subscription before the next connection subscribes.
	await subscribe();
	assert.equal(unsubscribed, 1);
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

test("subagent routes decode names, validate bodies and forward transcript, message and stop requests", async (t) => {
	const projects = new ProjectStore("/tmp/pilot-server-test-unused");
	const sessions = new SessionManager("/tmp/pilot-server-test-unused", projects);
	const terminals = new TerminalManager();
	const transcript = t.mock.method(
		sessions,
		"subagentTranscript",
		async (_id: string, name: string, options: { after?: number; ifNoneMatch?: string } = {}) =>
			options.ifNoneMatch === "8/full/1:2"
				? { signature: "8/full/1:2", unchanged: true }
				: { signature: "8/full/1:2", transcript: { name, full: true, events: [] } },
	);
	let watched: { events(events: AgentEvent[]): void; error(message: string): void } | undefined;
	let unwatched = 0;
	const watch = t.mock.method(
		sessions,
		"watchSubagent",
		(_id: string, name: string, listener: { events(events: AgentEvent[]): void; error(message: string): void }) => {
			if (name === "missing") throw new Error("No subagent named missing");
			watched = listener;
			return () => {
				unwatched++;
			};
		},
	);
	const command = t.mock.method(sessions, "subagentCommand", async () => {});
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
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/session-1/subagents`;
	const name = encodeURIComponent("code review/1");
	const read = await fetch(`${base}/${name}/transcript`);
	assert.equal(read.status, 200);
	assert.equal(read.headers.get("etag"), '"8/full/1:2"');
	assert.deepEqual(await read.json(), { name: "code review/1", full: true, events: [] });
	assert.deepEqual(transcript.mock.calls[0]?.arguments, ["session-1", "code review/1", {}]);
	const cached = await fetch(`${base}/${name}/transcript?after=12`, { headers: { "if-none-match": '"8/full/1:2"' } });
	assert.equal(cached.status, 304);
	await cached.arrayBuffer();
	assert.deepEqual(transcript.mock.calls[1]?.arguments, [
		"session-1",
		"code review/1",
		{ after: 12, ifNoneMatch: "8/full/1:2" },
	]);
	const badCursor = await fetch(`${base}/${name}/transcript?after=-1`);
	assert.equal(badCursor.status, 400);
	await badCursor.arrayBuffer();

	// Live transcripts stream over the WebSocket and stop with the subscription or the socket.
	const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`);
	const messages: ServerMessage[] = [];
	socket.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await once(socket, "open");
	socket.send(JSON.stringify({ type: "subagent.subscribe", sessionId: "session-1", name: "code review/1" }));
	socket.send(JSON.stringify({ type: "subagent.subscribe", sessionId: "session-1", name: "missing" }));
	socket.send(JSON.stringify({ type: "subagent.subscribe", sessionId: "session-1", name: "" }));
	const waitFor = async (check: () => boolean) => {
		for (let n = 0; n < 100 && !check(); n++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(check(), JSON.stringify(messages));
	};
	await waitFor(() => watched !== undefined && messages.filter((message) => message.type === "error").length === 2);
	watched!.events([{ type: "entry_appended", entry: { id: 4 } } as unknown as AgentEvent]);
	await waitFor(() => messages.some((message) => message.type === "subagent.events"));
	assert.deepEqual(
		messages.find((message) => message.type === "subagent.events"),
		{
			type: "subagent.events",
			sessionId: "session-1",
			name: "code review/1",
			events: [{ type: "entry_appended", entry: { id: 4 } }],
		},
	);
	assert.ok(messages.some((message) => message.type === "error" && message.name === "missing"));
	socket.send(JSON.stringify({ type: "subagent.unsubscribe", sessionId: "session-1", name: "code review/1" }));
	await waitFor(() => unwatched === 1);
	socket.send(JSON.stringify({ type: "subagent.subscribe", sessionId: "session-1", name: "code review/1" }));
	await waitFor(() => watch.mock.callCount() === 3);
	socket.close();
	await waitFor(() => unwatched === 2);
	const post = (path: string, body: unknown) =>
		fetch(`${base}/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const sent = await post(`${name}/messages`, { message: "focus", mode: "followUp", requestId: "r-1" });
	assert.equal(sent.status, 202);
	await sent.arrayBuffer();
	assert.deepEqual(command.mock.calls[0]?.arguments, [
		"session-1",
		"code review/1",
		{ action: "send", message: "focus", mode: "followUp", requestId: "r-1" },
	]);
	const stopped = await post(`${name}/stop`, {});
	assert.equal(stopped.status, 202);
	await stopped.arrayBuffer();
	assert.deepEqual(command.mock.calls[1]?.arguments, ["session-1", "code review/1", { action: "stop" }]);
	for (const [path, body] of [
		[`${name}/messages`, { message: " " }],
		[`${name}/messages`, { message: "x", mode: "later" }],
		[`${name}/messages`, { message: "x", requestId: "../bad" }],
		["%E0%A4%A/messages", { message: "x" }],
	] as const) {
		const rejected = await post(path, body);
		assert.equal(rejected.status, 400);
		await rejected.arrayBuffer();
	}
	assert.equal(command.mock.callCount(), 2);
});
