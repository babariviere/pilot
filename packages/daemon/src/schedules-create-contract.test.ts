import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DaemonHello, ScheduledItem, ScheduleRequest } from "@pilot/protocol";
import type { ModelCatalog } from "./models.ts";
import { payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionManager } from "./sessions.ts";
import type { TerminalManager } from "./terminals.ts";

// Contract characterization, not a new admission policy. Never start a scheduler,
// advance a dispatch timer, or invoke any real session/provider in these fixtures.
async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
async function fixture(t: TestContext, name = "a") {
	const home = await mkdtemp(join(tmpdir(), "schedule-create-contract-"));
	const store = new ScheduleStore(join(home, "schedules.sqlite"));
	await store.load(100);
	let now = 100;
	const calls: string[] = [];
	const forbidden = (name: string): never => {
		calls.push(name);
		assert.fail(`unstarted creation fixture invoked ${name}`);
	};
	const session = {
		id: "same-session-id",
		projectId: `project-${name}`,
		title: "Same display title",
		cwd: home,
		state: "idle",
		createdAt: 1,
		updatedAt: 1,
	};
	const sessions = {
		setWorkspaceProcessGuard() {},
		list: () => [session],
		get: (id: string) => (id === session.id ? session : undefined),
		onChange: () => () => {},
		onArtifactsChanged: () => () => {},
		send: async () => forbidden("send"),
		spawn: async () => forbidden("spawn"),
	} as unknown as SessionManager;
	const projects = new ProjectStore(home);
	await projects.load();
	const schedules = new ScheduleService(store, {
		sessions,
		projects: { require: () => forbidden("project validation") },
		clock: {
			now: () => now,
			setTimeout: () => forbidden("timer"),
		},
		triggers: {
			online: true,
			subscribe: () => forbidden("detector subscription"),
			setActive: () => forbidden("detector activation"),
			refreshOnline: async () => forbidden("reachability"),
		},
	});
	const hello: DaemonHello = {
		daemonId: `daemon-${name}`,
		lineageId: `lineage-${name}`,
		daemonVersion: "synthetic",
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		platform: "synthetic",
		arch: "synthetic",
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
		{} as ModelCatalog,
		{ isRunning: () => false } as unknown as TerminalManager,
	];
	args[8] = schedules;
	args[12] = hello;
	const server = createDaemonServer(...args);
	const url = await listen(server);
	t.after(async () => {
		await close(server);
		// Deliberately never start/stop the scheduler or its detector. Only the
		// fixture-owned SQLite worker needs draining/closing.
		await store.close();
		await rm(home, { recursive: true, force: true });
		assert.deepEqual(calls, [], "creation/read checks never dispatched or probed");
	});
	// Join the server's independent empty-journal initialization before any test
	// can remove this home. Receipt lookup is read-only, never operation execute.
	const destination = { hostId: "local", daemonId: hello.daemonId, lineageId: hello.lineageId! };
	const receipt = await fetch(`${url}/api/operations/receipt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			schemaVersion: 1,
			operationId: "unsubmitted",
			producerId: "fixture",
			sequence: 1,
			origin: destination,
			destination,
			kind: "chat-send",
			targetId: session.id,
			payload: "{}",
			payloadHash: payloadHash("{}"),
		}),
	});
	assert.equal(receipt.status, 200);
	assert.deepEqual(await receipt.json(), { state: "unknown" });
	const request: ScheduleRequest = {
		trigger: "at",
		at: 200,
		target: { kind: "message", sessionId: session.id, message: "  日本語 👩‍💻\n é  \n" },
	};
	return { url, store, session, hello, request, setNow: (value: number) => (now = value) };
}
const post = (url: string, request: unknown, headers: Record<string, string> = {}) =>
	fetch(`${url}/api/schedules`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(request),
	});

// A deterministic stand-in for a loopback endpoint being rebound to a different
// data home between preflight and POST. No real daemon/profile is touched.
async function gateway(t: TestContext, upstream: string) {
	const route = { upstream, loseAck: false, posts: 0 };
	const server = createServer(async (req, res) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			if (req.method === "POST") route.posts++;
			const response = await fetch(`${route.upstream}${req.url}`, {
				method: req.method,
				redirect: "manual",
				headers: { "content-type": "application/json" },
				...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
			});
			const body = Buffer.from(await response.arrayBuffer());
			if (req.method === "POST" && route.loseAck) {
				route.loseAck = false;
				res.destroy(); // The backend has already answered; the caller sees no ACK.
				return;
			}
			res.writeHead(response.status, { "content-type": "application/json" });
			res.end(body);
		} catch (error) {
			res.destroy(error instanceof Error ? error : new Error(String(error)));
		}
	});
	const url = await listen(server);
	t.after(() => close(server));
	return { url, route };
}

test("schedule creation preserves exact message/session/epoch and returns a persisted pending row", async (t) => {
	const f = await fixture(t);
	const response = await post(f.url, f.request);
	assert.equal(response.status, 201);
	const item = (await response.json()) as ScheduledItem;
	assert.deepEqual(item.target, f.request.target);
	assert.equal(item.at, f.request.at);
	assert.equal(item.trigger, "at");
	assert.equal(item.projectId, f.session.projectId);
	assert.equal(item.sessionId, f.session.id);
	assert.equal(item.state, "pending");
	assert.equal(item.revision, 1);
	assert.deepEqual(JSON.parse(await f.store.snapshot()), [item], "worker SELECT observes the committed row");
});

test("a checked hello cannot bind schedule creation to that daemon/lineage at mutation time", async (t) => {
	const a = await fixture(t, "a");
	const b = await fixture(t, "b");
	const g = await gateway(t, a.url);
	const before = await (await fetch(`${g.url}/api/hello`)).json();
	assert.equal(before.daemonId, a.hello.daemonId);
	assert.equal(before.lineageId, a.hello.lineageId);
	assert.deepEqual(await (await fetch(`${g.url}/api/sessions/${a.session.id}`)).json(), a.session);
	g.route.upstream = b.url;
	const response = await post(g.url, a.request);
	assert.equal(response.status, 201, "the existing contract has no mutation-time identity precondition");
	const item = (await response.json()) as ScheduledItem;
	assert.deepEqual(item.target, a.request.target);
	assert.equal(item.projectId, b.session.projectId, "same session ID is resolved in the replacement home");
	assert.deepEqual(a.store.list(), []);
	assert.deepEqual(b.store.list(), [item]);
	const after = await (await fetch(`${g.url}/api/hello`)).json();
	assert.equal(after.daemonId, b.hello.daemonId);
	assert.equal(after.lineageId, b.hello.lineageId);
	assert.equal(g.route.posts, 1, "postflight detects a change only after creation");
});

test("matching pre/post hello and exact ACK fields still cannot prove the receiving home", async (t) => {
	const a = await fixture(t, "a");
	const b = await fixture(t, "b");
	// A copied/restored history may also contain the same project ID. The
	// response then contains every requested target field, but no home identity.
	b.session.projectId = a.session.projectId;
	const g = await gateway(t, a.url);
	const before = await (await fetch(`${g.url}/api/hello`)).json();
	g.route.upstream = b.url;
	const response = await post(g.url, a.request);
	assert.equal(response.status, 201);
	const item = (await response.json()) as ScheduledItem;
	assert.deepEqual(item.target, a.request.target);
	assert.equal(item.projectId, a.session.projectId);
	assert.equal(item.sessionId, a.session.id);
	assert.equal(item.at, a.request.at);
	assert.equal(item.trigger, "at");
	assert.equal(item.state, "pending");
	g.route.upstream = a.url;
	const after = await (await fetch(`${g.url}/api/hello`)).json();
	assert.deepEqual(after, before, "pre/post hello cannot detect an intervening home");
	assert.deepEqual(a.store.list(), []);
	assert.deepEqual(b.store.list(), [item]);
	assert.equal(g.route.posts, 1);
});

test("lost create ACK is not recoverable by matching a GET or replaying an idempotency key", async (t) => {
	const f = await fixture(t);
	const g = await gateway(t, f.url);
	g.route.loseAck = true;
	await assert.rejects(post(g.url, f.request));
	assert.equal(g.route.posts, 1, "no automatic replay");
	const rows = (await (await fetch(`${g.url}/api/schedules`)).json()) as ScheduledItem[];
	assert.equal(rows.length, 1);
	assert.deepEqual(rows[0]!.target, f.request.target);
	// A second explicit synthetic POST characterizes missing deduplication. It is
	// not proposed recovery behavior: a native client must never do this on loss.
	const first = await post(f.url, f.request, { "idempotency-key": "same-attempt" });
	const second = await post(f.url, f.request, { "idempotency-key": "same-attempt" });
	assert.equal(first.status, 201);
	assert.equal(second.status, 201);
	const x = (await first.json()) as ScheduledItem;
	const y = (await second.json()) as ScheduledItem;
	assert.notEqual(x.id, y.id);
	assert.deepEqual(x.target, y.target);
	assert.equal(f.store.list().length, 3);
});

test("expired time is accepted, and create errors do not distinguish pre-save from post-save failure", async (t) => {
	const f = await fixture(t);
	f.setNow(300); // A time future at capture can already be overdue on arrival.
	const expired = await post(f.url, f.request);
	assert.equal(expired.status, 201);
	const item = (await expired.json()) as ScheduledItem;
	assert.equal(item.at, 200);
	assert.equal(item.createdAt, 300);
	assert.equal(item.state, "pending", "no scheduler was started to dispatch the overdue row");
	const off = f.store.onChange(() => {
		throw new Error("synthetic post-save listener failure");
	});
	const failure = await post(f.url, { ...f.request, at: 400 });
	off();
	assert.equal(failure.status, 400);
	assert.deepEqual(await failure.json(), { error: "synthetic post-save listener failure" });
	assert.equal(f.store.list().length, 2, "400 can follow durable creation; it is not a rejection receipt");
	assert.equal((JSON.parse(await f.store.snapshot()) as ScheduledItem[]).length, 2);
});

test("creation validation rejects malformed time, empty/oversized payloads and missing sessions", async (t) => {
	const f = await fixture(t);
	for (const at of [null, -1, 0.5, 8.64e15 + 1]) {
		const response = await post(f.url, { ...f.request, at });
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "at must be epoch milliseconds" });
	}
	for (const [message, error] of [
		[" \n", "message is required"],
		["x".repeat(16_384), "Schedule target exceeds 16 KiB"],
	]) {
		const response = await post(f.url, { ...f.request, target: { ...f.request.target, message } });
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error });
	}
	const missing = await post(f.url, {
		...f.request,
		target: { kind: "message", sessionId: "missing", message: "exact" },
	});
	assert.equal(missing.status, 404);
	await missing.arrayBuffer();
	assert.deepEqual(f.store.list(), []);
});
