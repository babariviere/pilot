// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private IPC and cleanup seams without a kernel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ArtifactNotFound, ArtifactStore, getLibrary } from "@pilot/artifacts";
import type { ArtifactRevision, ArtifactSummary, ServerMessage } from "@pilot/protocol";
import { WebSocket } from "ws";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { NotFound, SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

const sessionId = randomUUID();
const artifactId = randomUUID();
const summary: ArtifactSummary = {
	id: artifactId,
	sessionId,
	title: "Chart",
	kind: "html",
	revision: 2,
	createdAt: 1,
	updatedAt: 2,
};
const revision: ArtifactRevision = { ...summary, source: "<p>Chart</p>", html: "<p>Chart</p>", libraries: [] };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function registry(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-artifacts-"));
	const managers: SessionManager[] = [];
	const cleanups: (() => void | Promise<void>)[] = [];
	const addCleanup = (cleanup: () => void | Promise<void>) => cleanups.push(cleanup);
	t.after(async () => {
		try {
			for (const cleanup of cleanups.reverse()) await cleanup();
			for (const sessions of managers) {
				await sessions.shutdown();
				await Promise.allSettled([...sessions["starting"].values()]);
				await Promise.allSettled([...sessions["artifactNotifications"].values()]);
				await Promise.allSettled([...sessions["saving"].values()]);
			}
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, workspace: "direct" });
	const otherId = randomUUID();
	for (const [id, projectId] of [
		[sessionId, project.id],
		[otherId, undefined],
	] as const) {
		const dir = join(home, "sessions", id);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "meta.json"),
			JSON.stringify({
				id,
				projectId,
				title: "Parked",
				cwd: home,
				createdAt: 1,
				updatedAt: 20,
				working: false,
				outcome: "done",
				outcomeAt: 10,
				outcomeReason: "Review requested",
				lastOutcomeAt: 10,
				lastCompletionAt: 10,
			}),
		);
	}
	const launch = t.mock.fn(() => {
		throw new Error("Artifact tests must not launch a kernel");
	});
	const runner = t.mock.fn(async () => "[]");
	const manager = async () => {
		const sessions = new SessionManager(home, projects, undefined, { worker: launch }, { runner });
		managers.push(sessions);
		await sessions.load();
		// Artifact reads are independent of PR discovery. Drain the initial sweep and remove its timer.
		await sessions["pullRequests"].stop();
		return sessions;
	};
	const sessions = await manager();
	return { home, sessions, projects, project, otherId, manager, launch, runner, addCleanup };
}

test("artifact reads use committed storage and leave sessions parked", async (t) => {
	const { sessions, project, otherId } = await registry(t);
	// Store doubles avoid coupling daemon tests to the artifact on-disk format.
	t.mock.method(ArtifactStore.prototype, "list", async () => [{ ...summary, projectId: project.id }]);
	const read = t.mock.method(ArtifactStore.prototype, "get", async (id: string, number?: number) => {
		if (id !== artifactId || (number !== undefined && number > 2)) throw new ArtifactNotFound("Unknown artifact");
		return { ...revision, revision: number ?? 2 };
	});
	assert.equal((await sessions.artifacts(sessionId))[0]?.id, artifactId);
	assert.equal((await sessions.artifact(sessionId, artifactId)).revision, 2);
	assert.equal((await sessions.artifact(sessionId, artifactId, 1)).revision, 1);
	assert.equal(read.mock.callCount(), 2);
	await assert.rejects(sessions.artifact(sessionId, "missing"), NotFound);
	await assert.rejects(sessions.artifact(sessionId, artifactId, 3), NotFound);
	await assert.rejects(sessions.artifact(sessionId, artifactId, 0), /positive integer/);
	await assert.rejects(sessions.artifacts("missing"), NotFound);
	await assert.rejects(sessions.projectArtifacts("missing"), NotFound);
	const list = t.mock.method(sessions, "artifacts", async (id: string) => {
		assert.notEqual(id, otherId);
		return [{ ...summary, projectId: project.id }];
	});
	assert.deepEqual(await sessions.projectArtifacts(project.id), [{ ...summary, projectId: project.id }]);
	assert.equal(list.mock.callCount(), 1);
	assert.ok(sessions.list().every((session) => session.state === "parked"));
});

test("empty parked sessions have an empty artifact list", async (t) => {
	const { sessions, project } = await registry(t);
	assert.deepEqual(await sessions.artifacts(sessionId), []);
	assert.deepEqual(await sessions.projectArtifacts(project.id), []);
	await assert.rejects(sessions.artifact(sessionId, "missing"), NotFound);
	assert.equal(sessions.get(sessionId)?.state, "parked");
});

test("artifacts.changed reads committed lists and notifies listeners", { timeout: 2_000 }, async (t) => {
	const { home, sessions, launch, runner } = await registry(t);
	const before = sessions.get(sessionId);
	const metadata = await readFile(join(home, "sessions", sessionId, "meta.json"), "utf8");
	const changes = t.mock.fn();
	const unwatch = sessions.onChange(changes);
	const list = t.mock.method(sessions, "artifacts", async () => [summary]);
	let resolve!: () => void;
	const notified = new Promise<void>((done) => {
		resolve = done;
	});
	const stop = sessions.onArtifactsChanged((id, artifacts) => {
		assert.equal(id, sessionId);
		assert.deepEqual(artifacts, [summary]);
		resolve();
	});
	// Exercise the IPC boundary without spawning a kernel/model process.
	const ipc = sessions as unknown as {
		onPacket(meta: { id: string }, worker: undefined, packet: { type: "artifacts.changed" }): void;
	};
	ipc.onPacket(sessions["metas"].get(sessionId)!, undefined, { type: "artifacts.changed" });
	await notified;
	stop();
	unwatch();
	assert.equal(list.mock.callCount(), 1);
	assert.deepEqual(sessions.get(sessionId), before);
	assert.equal(await readFile(join(home, "sessions", sessionId, "meta.json"), "utf8"), metadata);
	assert.equal(changes.mock.callCount(), 0);
	assert.equal(launch.mock.callCount(), 0);
	assert.equal(runner.mock.callCount(), 0);
});

test("shutdown drains serialized artifact notifications without changing lifecycle metadata", {
	timeout: 2_000,
}, async (t) => {
	const { home, sessions, launch } = await registry(t);
	const reading = deferred();
	const started = deferred();
	const before = structuredClone(sessions["metas"].get(sessionId)!);
	const metadata = await readFile(join(home, "sessions", sessionId, "meta.json"), "utf8");
	const list = t.mock.method(sessions, "artifacts", async () => {
		started.resolve();
		await reading.promise;
		return [summary];
	});
	const changes = t.mock.fn();
	const unwatch = sessions.onArtifactsChanged(changes);
	const ipc = sessions as unknown as {
		onPacket(meta: { id: string }, worker: undefined, packet: { type: "artifacts.changed" }): void;
	};
	let stopping: Promise<void> | undefined;
	try {
		ipc.onPacket(sessions["metas"].get(sessionId)!, undefined, { type: "artifacts.changed" });
		ipc.onPacket(sessions["metas"].get(sessionId)!, undefined, { type: "artifacts.changed" });
		await started.promise;
		assert.equal(list.mock.callCount(), 1, "committed reads are serialized per session");
		let stopped = false;
		stopping = sessions.shutdown().then(() => {
			stopped = true;
		});
		await nextTurn();
		assert.equal(stopped, false, "shutdown must wait for outstanding artifact reads and notifications");
		reading.resolve();
		await stopping;
		assert.equal(list.mock.callCount(), 2);
		assert.equal(changes.mock.callCount(), 2);
		assert.deepEqual(sessions["metas"].get(sessionId), before);
		assert.equal(await readFile(join(home, "sessions", sessionId, "meta.json"), "utf8"), metadata);
		assert.equal(launch.mock.callCount(), 0);
	} finally {
		reading.resolve();
		await stopping;
		unwatch();
	}
});

async function api(t: TestContext, mockReads = true) {
	const fixture = await registry(t);
	const { home, sessions, projects, addCleanup } = fixture;
	if (mockReads) {
		t.mock.method(sessions, "artifacts", async (id: string) => {
			if (id !== sessionId) throw new NotFound("Unknown session");
			return [summary];
		});
		t.mock.method(sessions, "artifact", async (id: string, aid: string, number?: number) => {
			if (id !== sessionId) throw new NotFound("Unknown session");
			if (aid !== artifactId || (number !== undefined && number > 2)) throw new NotFound("Unknown artifact");
			return { ...revision, revision: number ?? 2 };
		});
	}
	t.mock.method(sessions, "subscribe", (id: string) => {
		if (id !== sessionId) throw new NotFound("Unknown session");
		return () => {};
	});
	let broadcast!: (id: string, list: ArtifactSummary[]) => void;
	t.mock.method(sessions, "onArtifactsChanged", (listener: typeof broadcast) => {
		broadcast = listener;
		return () => {};
	});
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		{} as ModelCatalog,
		terminals,
	);
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	addCleanup(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		terminals.shutdown();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { ...fixture, server, terminals, broadcast, base: `http://127.0.0.1:${address.port}` };
}

test("HTTP reads persisted artifact revisions and aggregates only the project's owning sessions", async (t) => {
	const { home, base, sessions, project, otherId } = await api(t, false);
	const secondId = randomUUID();
	const secondDir = join(home, "sessions", secondId);
	await mkdir(secondDir, { recursive: true });
	await writeFile(
		join(secondDir, "meta.json"),
		JSON.stringify({
			id: secondId,
			projectId: project.id,
			title: "Second",
			cwd: home,
			createdAt: 1,
			updatedAt: 1,
		}),
	);
	await sessions.load();
	const store = new ArtifactStore(join(home, "sessions", sessionId), { sessionId, projectId: project.id });
	const initial = await store.create({ title: "First", kind: "html", source: "<p>First</p>" });
	const latest = await store.update(initial.id, { title: "Updated", kind: "html", source: "<p>Updated</p>" });
	const second = await new ArtifactStore(secondDir, { sessionId: secondId, projectId: project.id }).create({
		title: "Second",
		kind: "html",
		source: "<p>Second</p>",
	});
	await new ArtifactStore(join(home, "sessions", otherId), { sessionId: otherId }).create({
		title: "Unassigned",
		kind: "html",
		source: "<p>Unassigned</p>",
	});
	const path = `${base}/api/sessions/${sessionId}/artifacts/${initial.id}`;
	assert.deepEqual(await (await fetch(path)).json(), latest);
	assert.deepEqual(await (await fetch(`${path}?revision=1`)).json(), initial);
	assert.equal((await fetch(`${path}?revision=3`)).status, 404);
	assert.equal((await fetch(`${base}/api/sessions/${sessionId}/artifacts/${second.id}`)).status, 404);
	const list = (await (await fetch(`${base}/api/projects/${project.id}/artifacts`)).json()) as ArtifactSummary[];
	assert.deepEqual(new Set(list.map((item) => item.id)), new Set([initial.id, second.id]));
	assert.ok(list.every((item) => item.projectId === project.id));
	assert.ok(list.every((item) => !("source" in item) && !("html" in item)));
	assert.ok(sessions.list().every((session) => session.state === "parked"));
});

test("archived owners retain project-visible artifacts and pinned revisions across restart without waking or restoring", async (t) => {
	const { home, base, sessions, project, otherId, manager, launch, runner } = await api(t, false);
	const store = new ArtifactStore(join(home, "sessions", sessionId), { sessionId, projectId: project.id });
	const initial = await store.create({ title: "Archived first revision", kind: "html", source: "<p>First</p>" });
	const latest = await store.update(initial.id, {
		title: "Archived latest revision",
		kind: "html",
		source: "<p>Latest</p>",
	});
	await new ArtifactStore(join(home, "sessions", otherId), { sessionId: otherId }).create({
		title: "Unassigned artifact",
		kind: "html",
		source: "<p>Unassigned</p>",
	});
	const before = sessions.get(sessionId)!;
	const response = await fetch(`${base}/api/sessions/${sessionId}/archive`, { method: "POST" });
	assert.equal(response.status, 200);
	const archived = sessions.get(sessionId)!;
	assert.ok(archived.archivedAt);
	assert.deepEqual(archived, { ...before, archivedAt: archived.archivedAt });
	const meta = structuredClone(sessions["metas"].get(sessionId)!);
	const metadata = await readFile(join(home, "sessions", sessionId, "meta.json"), "utf8");
	const changes = t.mock.fn();
	const unwatch = sessions.onChange(changes);
	const restore = t.mock.method(sessions, "restore");
	const read = async (path: string) => {
		const response = await fetch(`${base}${path}`);
		assert.equal(response.status, 200, path);
		return response.json();
	};
	const path = `/api/sessions/${sessionId}/artifacts/${initial.id}`;
	assert.deepEqual(await read(path), latest);
	assert.deepEqual(await read(`${path}?revision=1`), initial);
	const ownerItems = (await read(`/api/sessions/${sessionId}/artifacts`)) as ArtifactSummary[];
	assert.equal(ownerItems.length, 1);
	assert.equal(ownerItems[0]!.revision, 2);
	assert.deepEqual(await read(`/api/projects/${project.id}/artifacts`), ownerItems);
	assert.ok(ownerItems.every((item) => item.projectId === project.id));
	assert.ok(!sessions.list().some((session) => session.id === sessionId));
	assert.deepEqual(sessions.list({ archived: "true", projectId: project.id }), [archived]);
	assert.equal(sessions.list({ archived: "all" }).length, 2);
	assert.deepEqual(sessions.get(sessionId), archived);
	assert.deepEqual(sessions["metas"].get(sessionId), meta);
	assert.equal(await readFile(join(home, "sessions", sessionId, "meta.json"), "utf8"), metadata);
	assert.equal(changes.mock.callCount(), 0, "artifact reads must not publish lifecycle changes");
	assert.equal(restore.mock.callCount(), 0);
	unwatch();

	const reopened = await manager();
	const reopenedRestore = t.mock.method(reopened, "restore");
	assert.deepEqual(await reopened.artifacts(sessionId), ownerItems);
	assert.deepEqual(await reopened.projectArtifacts(project.id), ownerItems);
	assert.deepEqual(await reopened.artifact(sessionId, initial.id), latest);
	assert.deepEqual(await reopened.artifact(sessionId, initial.id, 1), initial);
	assert.deepEqual(reopened.get(sessionId), archived);
	assert.deepEqual(reopened["metas"].get(sessionId), meta);
	assert.equal(await readFile(join(home, "sessions", sessionId, "meta.json"), "utf8"), metadata);
	assert.equal(reopenedRestore.mock.callCount(), 0);
	assert.equal(sessions["workers"].size, 0);
	assert.equal(reopened["workers"].size, 0);
	assert.equal(launch.mock.callCount(), 0);
	assert.equal(runner.mock.callCount(), 0);
});

test("HTTP artifact routes return lists, latest and pinned revisions, and 404s", async (t) => {
	const { base, project } = await api(t);
	assert.deepEqual(await (await fetch(`${base}/api/sessions/${sessionId}/artifacts`)).json(), [summary]);
	assert.deepEqual(await (await fetch(`${base}/api/projects/${project.id}/artifacts`)).json(), [summary]);
	const path = `${base}/api/sessions/${sessionId}/artifacts/${artifactId}`;
	assert.deepEqual(await (await fetch(path)).json(), revision);
	assert.deepEqual(await (await fetch(`${path}?revision=1`)).json(), { ...revision, revision: 1 });
	for (const bad of ["0", "-1", "1.5", "NaN", "", "1e0", "9007199254740992", "1&revision=2"]) {
		assert.equal((await fetch(`${path}?revision=${bad}`)).status, 400, bad);
	}
	for (const missing of [
		"/api/sessions/missing/artifacts",
		`/api/sessions/missing/artifacts/${artifactId}`,
		`/api/sessions/${sessionId}/artifacts/missing`,
		`/api/sessions/${sessionId}/artifacts/${artifactId}?revision=3`,
		"/api/projects/missing/artifacts",
	])
		assert.equal((await fetch(`${base}${missing}`)).status, 404, missing);
});

test("library assets are JavaScript for native requests only", async (t) => {
	const { base } = await api(t);
	const path = `${base}/api/artifact-libraries/react`;
	const response = await fetch(path);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "text/javascript");
	assert.equal(await response.text(), await getLibrary("react"));
	const etag = response.headers.get("etag");
	assert.ok(etag);
	assert.equal(response.headers.get("cache-control"), "no-cache");
	const revalidated = await fetch(path, { headers: { "if-none-match": etag } });
	assert.equal(revalidated.status, 304);
	assert.equal(await revalidated.text(), "");
	assert.equal((await fetch(`${base}/api/artifact-libraries/unknown`)).status, 404);
	for (const origin of ["null", "https://example.org", base]) {
		assert.equal((await fetch(path, { headers: { origin } })).status, 403);
		assert.equal((await fetch(`${base}/api/sessions/${sessionId}/artifacts`, { headers: { origin } })).status, 403);
	}
});

function client(t: TestContext, server: Server) {
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`);
	t.after(() => ws.terminate());
	const messages: ServerMessage[] = [];
	let wake: (() => void) | undefined;
	ws.on("message", (raw) => {
		messages.push(JSON.parse(String(raw)) as ServerMessage);
		wake?.();
	});
	return {
		ws,
		messages,
		async next(type: ServerMessage["type"]): Promise<ServerMessage> {
			let expired = false;
			const timeout = setTimeout(() => {
				expired = true;
				wake?.();
			}, 2_000);
			try {
				while (true) {
					const index = messages.findIndex((message) => message.type === type);
					if (index >= 0) return messages.splice(index, 1)[0]!;
					assert.ok(!expired, `Missing ${type} message`);
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
			} finally {
				clearTimeout(timeout);
				wake = undefined;
			}
		},
	};
}

test("WS rejects malformed JSON shapes and unknown message types without dispatching or disconnecting", async (t) => {
	const { server, sessions, terminals, base } = await api(t);
	const subscribe = t.mock.method(sessions, "subscribe", () => () => {});
	const attach = t.mock.method(terminals, "attach", () => () => {});
	const resize = t.mock.method(terminals, "resize", () => {});
	const write = t.mock.method(terminals, "write", () => {});
	const close = t.mock.method(terminals, "close", () => {});
	const connection = client(t, server);
	await connection.next("sessions");
	for (const value of [
		null,
		{},
		[],
		["subscribe"],
		true,
		false,
		0,
		1,
		"subscribe",
		{ type: null, sessionId },
		{ type: 1, sessionId },
		{ type: {}, sessionId },
		{ type: "subscribe" },
		{ type: "subscribe", sessionId: null },
		{ type: "subscribe", sessionId: 1 },
		{ type: "subscribe", sessionId: [] },
		{ type: "subscribe", sessionId: "" },
		{ type: "subscribe", sessionId: "  " },
		{ type: "unknown", sessionId },
		{ type: "terminal.unknown", sessionId },
		{ type: "terminal.input", sessionId },
		{ type: "terminal.input", sessionId, data: {} },
		{ type: "terminal.attach", sessionId },
		{ type: "terminal.attach", sessionId, cols: 80, rows: 24, restart: "true" },
		{ type: "terminal.resize", sessionId, cols: "80", rows: 24 },
		{ type: "terminal.resize", sessionId, cols: 80, rows: null },
		{ type: "terminal.resize", sessionId, cols: 0, rows: 24 },
		{ type: "terminal.resize", sessionId, cols: 80.5, rows: 24 },
		{ type: "terminal.resize", sessionId, cols: 1001, rows: 24 },
	]) {
		connection.ws.send(JSON.stringify(value));
		assert.deepEqual(
			await connection.next("error"),
			{ type: "error", message: "Invalid client message" },
			JSON.stringify(value),
		);
	}
	connection.ws.send('{"type":"terminal.resize","sessionId":"test","cols":1e400,"rows":24}');
	assert.deepEqual(await connection.next("error"), { type: "error", message: "Invalid client message" });
	connection.ws.send("{");
	assert.deepEqual(await connection.next("error"), { type: "error", message: "Invalid JSON" });
	for (const method of [subscribe, attach, resize, write, close]) assert.equal(method.mock.callCount(), 0);
	assert.equal((await fetch(`${base}/api/sessions`)).status, 200);
	connection.ws.send(JSON.stringify({ type: "subscribe", sessionId }));
	assert.deepEqual(await connection.next("artifacts"), { type: "artifacts", sessionId, artifacts: [summary] });
	assert.equal(subscribe.mock.callCount(), 1);
	assert.equal(connection.ws.readyState, WebSocket.OPEN);
});

test("WS still dispatches every valid terminal message after validation", async (t) => {
	const { server, terminals } = await api(t);
	const detach = t.mock.fn(() => {});
	const attach = t.mock.method(terminals, "attach", () => detach);
	const resize = t.mock.method(terminals, "resize", () => {});
	const write = t.mock.method(terminals, "write", () => {});
	const close = t.mock.method(terminals, "close", () => {});
	const connection = client(t, server);
	await connection.next("sessions");
	for (const message of [
		{ type: "terminal.attach", sessionId, cols: 80, rows: 24, restart: true },
		{ type: "terminal.input", sessionId, data: "echo hello\n" },
		{ type: "terminal.resize", sessionId, cols: 100, rows: 30 },
		{ type: "terminal.detach", sessionId },
		{ type: "terminal.close", sessionId },
	])
		connection.ws.send(JSON.stringify(message));
	const pong = once(connection.ws, "pong");
	connection.ws.ping();
	await pong;
	assert.equal(attach.mock.callCount(), 1);
	assert.equal(attach.mock.calls[0]?.arguments[5], true);
	assert.deepEqual(write.mock.calls[0]?.arguments, [sessionId, "echo hello\n"]);
	assert.deepEqual(resize.mock.calls[0]?.arguments, [sessionId, 100, 30]);
	assert.equal(detach.mock.callCount(), 1);
	assert.deepEqual(close.mock.calls[0]?.arguments, [sessionId]);
	assert.ok(!connection.messages.some((message) => message.type === "error"));
});

test("WS subscription/reconnect snapshots and live broadcasts contain artifacts", async (t) => {
	const { server, broadcast } = await api(t);
	const first = client(t, server);
	await first.next("sessions");
	first.ws.send(JSON.stringify({ type: "subscribe", sessionId }));
	assert.deepEqual(await first.next("artifacts"), { type: "artifacts", sessionId, artifacts: [summary] });
	const second = client(t, server);
	await second.next("sessions");
	const updated = { ...summary, revision: 3 };
	broadcast(sessionId, [updated]);
	assert.deepEqual(await first.next("artifacts"), { type: "artifacts", sessionId, artifacts: [updated] });
	assert.deepEqual(await second.next("artifacts"), { type: "artifacts", sessionId, artifacts: [updated] });
	first.ws.terminate();
	second.ws.send(JSON.stringify({ type: "subscribe", sessionId }));
	assert.deepEqual(await second.next("artifacts"), { type: "artifacts", sessionId, artifacts: [summary] });
	second.ws.send(JSON.stringify({ type: "unsubscribe", sessionId }));
	second.ws.send(JSON.stringify({ type: "subscribe", sessionId }));
	assert.deepEqual(await second.next("artifacts"), { type: "artifacts", sessionId, artifacts: [summary] });
});

test("WS update supersedes an in-flight initial artifact snapshot", async (t) => {
	const { server, sessions, broadcast } = await api(t);
	let complete!: (value: ArtifactSummary[]) => void;
	const reading = new Promise<ArtifactSummary[]>((resolve) => {
		complete = resolve;
	});
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	t.mock.method(sessions, "artifacts", () => {
		started();
		return reading;
	});
	const connection = client(t, server);
	await connection.next("sessions");
	connection.ws.send(JSON.stringify({ type: "subscribe", sessionId }));
	await ready;
	broadcast(sessionId, [{ ...summary, revision: 3 }]);
	complete([summary]);
	assert.deepEqual(await connection.next("artifacts"), {
		type: "artifacts",
		sessionId,
		artifacts: [{ ...summary, revision: 3 }],
	});
	const pong = once(connection.ws, "pong");
	connection.ws.ping();
	await pong;
	assert.ok(!connection.messages.some((message) => message.type === "artifacts"));
});

test("WS unsubscribe suppresses an in-flight artifact snapshot", async (t) => {
	const { server, sessions } = await api(t);
	let complete!: (value: ArtifactSummary[]) => void;
	const reading = new Promise<ArtifactSummary[]>((resolve) => {
		complete = resolve;
	});
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	t.mock.method(sessions, "artifacts", () => {
		started();
		return reading;
	});
	const connection = client(t, server);
	await connection.next("sessions");
	connection.ws.send(JSON.stringify({ type: "subscribe", sessionId }));
	await ready;
	connection.ws.send(JSON.stringify({ type: "unsubscribe", sessionId }));
	let pong = once(connection.ws, "pong");
	connection.ws.ping();
	await pong;
	complete([summary]);
	pong = once(connection.ws, "pong");
	connection.ws.ping();
	await pong;
	assert.ok(!connection.messages.some((message) => message.type === "artifacts"));
});
