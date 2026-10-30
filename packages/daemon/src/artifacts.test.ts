// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private IPC and cleanup seams without a kernel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ArtifactNotFound, ArtifactStore, getLibrary } from "@pilot/artifacts";
import type { ArtifactRevision, ArtifactSummary, MissionDetail, ServerMessage } from "@pilot/protocol";
import { WebSocket } from "ws";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
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

test("artifact ID lookup bounds pointer probes and stops after a matching batch", async (t) => {
	const { sessions } = await registry(t);
	const meta = sessions["metas"].get(sessionId)!;
	for (let index = 0; index < 1_000; index++) {
		const id = `lookup-${index}`;
		sessions["metas"].set(id, { ...meta, id });
	}
	let active = 0;
	let peak = 0;
	let found = false;
	const pointers = t.mock.method(ArtifactStore.prototype, "summary", async () => {
		active++;
		peak = Math.max(peak, active);
		await nextTurn();
		active--;
		if (found) return summary;
		throw new ArtifactNotFound("Unknown artifact");
	});
	await assert.rejects(sessions.resolveArtifact(artifactId), NotFound);
	assert.equal(peak, 4);
	assert.equal(pointers.mock.callCount(), 1_002);
	found = true;
	assert.deepEqual(await sessions.resolveArtifact(artifactId), summary);
	assert.equal(pointers.mock.callCount(), 1_006);
	await assert.rejects(sessions.resolveArtifact("invalid"), NotFound);
	assert.equal(pointers.mock.callCount(), 1_006);
	// These synthetic entries are not persisted session fixtures.
	for (let index = 0; index < 1_000; index++) sessions["metas"].delete(`lookup-${index}`);
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

async function api(t: TestContext, mockReads = true, withMissions = false) {
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
	const missions = withMissions ? new MissionStore(":memory:") : undefined;
	if (missions)
		addCleanup(async () => {
			await missions.durable();
			missions.close();
		});
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		{} as ModelCatalog,
		terminals,
		missions ? { store: missions, service: new MissionService(missions, sessions, projects) } : undefined,
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
	return { ...fixture, server, terminals, broadcast, missions, base: `http://127.0.0.1:${address.port}` };
}

test("mission detail keeps independent exact pins readable without latest inference or owner work", async (t) => {
	const { home, base, sessions, project, missions, launch, runner } = await api(t, false, true);
	assert.ok(missions);
	const mission = missions.create({ projectId: project.id, title: "Pinned sources", tasks: [{ title: "Older pin" }] });
	missions.join(sessionId, mission.id);
	const directory = join(home, "sessions", sessionId);
	const store = new ArtifactStore(directory, { sessionId });
	const old = await store.create({ title: "Task body", kind: "html", source: "<p>Exact older task source</p>" });
	missions.linkArtifact(mission.id, {
		artifactId: old.id,
		sessionId,
		revision: old.revision,
		kind: old.kind,
		title: old.title,
		taskId: "1",
	});
	const pinned = await store.update(old.id, {
		title: "Mission image",
		kind: "image",
		source:
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==",
	});
	missions.linkArtifact(mission.id, {
		artifactId: pinned.id,
		sessionId,
		revision: pinned.revision,
		kind: pinned.kind,
		title: pinned.title,
	});
	await store.update(old.id, { title: "Not linked latest", kind: "html", source: "<p>Never substitute latest</p>" });
	await missions.durable();
	const read = t.mock.method(sessions, "artifact");
	const before = missions.detail(mission.id);
	const response = await fetch(`${base}/api/missions/${mission.id}`);
	assert.equal(response.status, 200);
	const detail = (await response.json()) as MissionDetail;
	assert.deepEqual(detail.artifacts, before.artifacts);
	assert.equal(read.mock.callCount(), 0, "listing links does not fetch artifact bodies");
	assert.equal(detail.artifacts.length, 2);
	for (const link of detail.artifacts) {
		assert.equal(link.sessionId, sessionId);
		const exact = await fetch(
			`${base}/api/sessions/${link.sessionId}/artifacts/${link.artifactId}?revision=${link.revision}`,
		);
		assert.equal(exact.status, 200);
		assert.deepEqual(await exact.json(), link.taskId ? old : pinned);
	}
	await rename(join(directory, "artifacts", old.id, "2.json"), join(home, "missing-mission-pin.json"));
	assert.equal((await fetch(`${base}/api/sessions/${sessionId}/artifacts/${old.id}?revision=2`)).status, 404);
	assert.deepEqual(
		((await (await fetch(`${base}/api/missions/${mission.id}`)).json()) as MissionDetail).artifacts,
		before.artifacts,
		"a retained link does not promise its body remains available",
	);
	assert.deepEqual(read.mock.calls.map((c) => c.arguments[2]).sort(), [1, 2, 2]);
	assert.deepEqual(missions.detail(mission.id), before, "all reads leave link/task revisions unchanged");
	assert.equal(sessions.get(sessionId)?.state, "parked");
	assert.equal(launch.mock.callCount(), 0);
	assert.equal(runner.mock.callCount(), 0);
});

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

test("latest artifact metadata is not a readable revision catalogue", async (t) => {
	const { home, base, sessions, launch, runner } = await api(t, false);
	const directory = join(home, "sessions", sessionId);
	const store = new ArtifactStore(directory, { sessionId });
	const first = await store.create({ title: "First", kind: "html", source: "<p>Stored legacy source</p>" });
	const image = await store.update(first.id, {
		title: "Pixel",
		kind: "image",
		source:
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==",
	});
	const latest = await store.update(first.id, { title: "Latest", kind: "html", source: "<p>Latest source</p>" });
	const listPath = `${base}/api/sessions/${sessionId}/artifacts`;
	const path = `${listPath}/${first.id}`;
	const before = await (await fetch(listPath)).json();
	assert.deepEqual(before, [await store.summary(first.id)]);
	assert.equal(before[0].revision, 3);
	assert.equal(before[0].kind, "html");
	assert.ok(!("source" in before[0]) && !("revisions" in before[0]));

	// Simulate an unavailable historical file in this disposable fixture only.
	// A latest pointer cannot certify that all preceding revision bodies still exist.
	await rename(join(directory, "artifacts", first.id, "1.json"), join(home, "unavailable-revision.json"));
	assert.deepEqual(await (await fetch(listPath)).json(), before);
	const read = t.mock.method(sessions, "artifact");
	assert.equal((await fetch(`${path}?revision=1`)).status, 404);
	const historical = await fetch(`${path}?revision=2`);
	assert.equal(historical.status, 200);
	assert.deepEqual(await historical.json(), image, "historical kind/source belong to the exact revision");
	assert.deepEqual(
		read.mock.calls.map((call) => call.arguments),
		[
			[sessionId, first.id, 1],
			[sessionId, first.id, 2],
		],
		"an unavailable exact read never falls back to latest",
	);
	assert.deepEqual(await (await fetch(path)).json(), latest);
	assert.equal(sessions.get(sessionId)?.state, "parked");
	assert.equal(launch.mock.callCount(), 0);
	assert.equal(runner.mock.callCount(), 0);
});

test("artifact revision catalogue route is unavailable and does not read bodies", async (t) => {
	const { base, sessions, launch } = await api(t);
	const read = t.mock.method(sessions, "artifact", async () => {
		throw new Error("A missing catalogue route must not probe revision bodies");
	});
	const response = await fetch(`${base}/api/sessions/${sessionId}/artifacts/${artifactId}/revisions`);
	assert.equal(response.status, 404);
	assert.equal(read.mock.callCount(), 0);
	assert.equal(launch.mock.callCount(), 0);
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
	assert.deepEqual(await read(`/api/artifacts/${initial.id}`), ownerItems[0]);
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
	assert.deepEqual(await reopened.resolveArtifact(initial.id), ownerItems[0]);
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

test("artifact ID lookup returns only committed metadata and never reads bodies or wakes owners", async (t) => {
	const { base, home, sessions, launch } = await api(t, false);
	const store = new ArtifactStore(join(home, "sessions", sessionId), { sessionId });
	const created = await store.create({ title: "Linked preview", kind: "html", source: "<p>Preview</p>" });
	const expected = (await store.list())[0];
	const bodies = t.mock.method(ArtifactStore.prototype, "get", async () => {
		throw new Error("ID lookup must not read artifact bodies");
	});
	const response = await fetch(`${base}/api/artifacts/${created.id}`);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), expected);
	assert.equal((await fetch(`${base}/api/artifacts/${randomUUID()}`)).status, 404);
	assert.equal((await fetch(`${base}/api/artifacts/invalid`)).status, 404);
	assert.equal((await fetch(`${base}/api/artifacts/${created.id}`, { headers: { origin: "null" } })).status, 403);
	assert.equal(bodies.mock.callCount(), 0);
	assert.equal(launch.mock.callCount(), 0);
	assert.equal(sessions["workers"].size, 0);
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

function client(t: TestContext, server: Server, path = "/api/ws") {
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const ws = new WebSocket(`ws://127.0.0.1:${address.port}${path}`);
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

const chat = (t: TestContext, server: Server) => client(t, server, `/api/sessions/${sessionId}/ws`);

test("WS rejects malformed JSON shapes and unknown message types without dispatching or disconnecting", async (t) => {
	const { server, sessions, terminals, base } = await api(t);
	const subscribe = t.mock.method(sessions, "subscribe", () => () => {});
	const watch = t.mock.method(sessions, "watchSubagent", () => () => {});
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
		{ type: "unknown", sessionId },
		// Transcripts, terminals and subagents have dedicated sockets, never the control socket.
		{ type: "subscribe", sessionId },
		{ type: "unsubscribe", sessionId },
		{ type: "subagent.subscribe", sessionId, name: "review" },
		{ type: "terminal.attach", sessionId, cols: 80, rows: 24 },
		{ type: "terminal.input", sessionId, data: "ls" },
		{ type: "terminal.resize", sessionId, cols: 80, rows: 24 },
		{ type: "terminal.close", sessionId },
		{ type: "mission.subscribe" },
		{ type: "dashboard.subscribe", projectId: "" },
		{ type: "focus", sessionIds: [1] },
	]) {
		connection.ws.send(JSON.stringify(value));
		assert.deepEqual(
			await connection.next("error"),
			{ type: "error", message: "Invalid client message" },
			JSON.stringify(value),
		);
	}
	connection.ws.send("{");
	assert.deepEqual(await connection.next("error"), { type: "error", message: "Invalid JSON" });
	for (const method of [subscribe, watch, attach, resize, write, close]) assert.equal(method.mock.callCount(), 0);
	assert.equal((await fetch(`${base}/api/sessions`)).status, 200);
	assert.equal(connection.ws.readyState, WebSocket.OPEN);
});

test("terminal sockets validate their messages and dispatch every valid one", async (t) => {
	const { server, sessions, terminals } = await api(t);
	t.mock.method(sessions, "assertWritable", () => {});
	t.mock.method(sessions, "changeBase", () => ({ cwd: "/tmp" }));
	const detach = t.mock.fn(() => {});
	const terminalId = randomUUID();
	const attach = t.mock.method(
		terminals,
		"attach",
		(
			_id: string,
			_cwd: string,
			_cols: number,
			_rows: number,
			listener: import("./terminals.ts").TerminalListener,
		) => {
			listener.ready?.(terminalId);
			return detach;
		},
	);
	const resize = t.mock.method(terminals, "resize", () => {});
	const write = t.mock.method(terminals, "write", () => {});
	const connection = client(t, server, `/api/sessions/${sessionId}/terminal/ws?protocol=2&cols=80&rows=24`);
	await once(connection.ws, "open");
	await connection.next("terminal.hello");
	connection.ws.send(
		JSON.stringify({ type: "terminal.open", bootId: terminals.bootId, requestId: randomUUID(), restart: true }),
	);
	await connection.next("terminal.ready");
	for (const value of [
		null,
		{},
		{ type: "terminal.input" },
		{ type: "terminal.input", data: {} },
		{ type: "terminal.resize", cols: "80", rows: 24 },
		{ type: "terminal.resize", cols: 80, rows: null },
		{ type: "terminal.resize", cols: 0, rows: 24 },
		{ type: "terminal.resize", cols: 80.5, rows: 24 },
		{ type: "terminal.resize", cols: 1001, rows: 24 },
		{ type: "terminal.close" },
	]) {
		connection.ws.send(JSON.stringify(value));
		assert.deepEqual(
			await connection.next("error"),
			{ type: "error", sessionId, message: "Invalid terminal message" },
			JSON.stringify(value),
		);
	}
	connection.ws.send('{"type":"terminal.resize","cols":1e400,"rows":24}');
	assert.deepEqual(await connection.next("error"), { type: "error", sessionId, message: "Invalid terminal message" });
	assert.equal(write.mock.callCount() + resize.mock.callCount(), 0);
	connection.ws.send(JSON.stringify({ type: "terminal.input", terminalId, data: "echo hello\n" }));
	connection.ws.send(JSON.stringify({ type: "terminal.resize", terminalId, cols: 100, rows: 30 }));
	const pong = once(connection.ws, "pong");
	connection.ws.ping();
	await pong;
	assert.equal(attach.mock.callCount(), 1);
	assert.deepEqual(attach.mock.calls[0]?.arguments.slice(0, 4), [sessionId, "/tmp", 80, 24]);
	assert.equal(attach.mock.calls[0]?.arguments[5], true);
	assert.deepEqual(write.mock.calls[0]?.arguments, [sessionId, "echo hello\n", terminalId]);
	assert.deepEqual(resize.mock.calls[0]?.arguments, [sessionId, 100, 30, terminalId]);
	assert.equal(connection.ws.readyState, WebSocket.OPEN);
	connection.ws.close();
	await once(connection.ws, "close");
	while (!detach.mock.callCount()) await new Promise((resolve) => setTimeout(resolve, 5));
});

test("chat sockets start with the artifact index, and live broadcasts reach chats and the control socket", async (t) => {
	const { server, broadcast } = await api(t);
	const first = chat(t, server);
	assert.deepEqual(await first.next("artifacts"), { type: "artifacts", sessionId, artifacts: [summary] });
	const control = client(t, server);
	await control.next("sessions");
	const updated = { ...summary, revision: 3 };
	broadcast(sessionId, [updated]);
	assert.deepEqual(await first.next("artifacts"), { type: "artifacts", sessionId, artifacts: [updated] });
	assert.deepEqual(await control.next("artifacts"), { type: "artifacts", sessionId, artifacts: [updated] });
	first.ws.terminate();
	const reconnected = chat(t, server);
	assert.deepEqual(await reconnected.next("artifacts"), { type: "artifacts", sessionId, artifacts: [summary] });
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
	const connection = chat(t, server);
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
