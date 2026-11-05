// biome-ignore-all lint/complexity/useLiteralKeys: Exercise production creation, lifecycle and durable custody seams.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { Worker } from "node:worker_threads";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { fixture, jj } from "./testing/session-workspace.ts";

async function serve(
	t: TestContext,
	f: Awaited<ReturnType<typeof fixture>>,
	sessions: SessionManager = f.sessions,
	missions?: { store: MissionStore; service: MissionService },
) {
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		sessions,
		f.projects,
		new ModelCatalog("/unused"),
		terminals,
		missions,
	);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	t.after(async () => {
		await new Promise<void>((r) => server.close(() => r()));
		terminals.shutdown();
	});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

test("new standalone Build creation retains exact committed changes and revisions through HTTP and restart", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const sessions = f.sessions;
	const meta = sessions["metas"].get(chat.id)!;
	const worker = sessions["workers"].get(chat.id)!;
	const checkpoint = async () => {
		sessions["onPacket"](meta, worker, { type: "ready", model: "test/model", working: false, usage: {} });
		await sessions["workerReviewDelivery"]["tail"];
	};
	const root = await serve(t, f);
	const route = `${root}/sessions/${chat.id}/review`;
	const get = async (url: string) => {
		const response = await fetch(url);
		assert.equal(response.status, 200);
		return response.json() as Promise<any>;
	};
	assert.deepEqual((await get(route)).comparisons, []);
	await writeFile(join(chat.cwd, "tracked.txt"), "first retained\n");
	await writeFile(join(chat.cwd, "code.ts"), "export function first() { return 1; }\n");
	jj(chat.cwd, "commit", "-m", "First standalone change");
	const firstHead = jj(chat.cwd, "log", "--no-graph", "-r", "@-", "-T", "commit_id");
	await writeFile(join(chat.cwd, "tracked.txt"), "UNSAVED NOT CAPTURED\n");
	await checkpoint();
	const first = (await get(route)).comparisons;
	assert.equal(first.length, 1, "managed new standalone creation must supply a real capture producer");
	assert.equal(first[0].request.head.commitId, firstHead);
	const selected = first[0].snapshotId;
	const snapshot = await get(`${route}/${selected}`);
	assert.deepEqual(snapshot.enrollmentTaskIds, []);
	assert.equal(snapshot.enrollmentProjectId, f.project.id);
	const entry = snapshot.after.find((e: any) => e.path === "tracked.txt");
	assert.equal(entry.sha256, createHash("sha256").update("first retained\n").digest("hex"));
	const beforeEntry = snapshot.before.find((e: any) => e.path === "tracked.txt");
	assert.equal(
		(await get(`${route}/${selected}/source?side=before&path=tracked.txt&sha256=${beforeEntry.sha256}`)).text,
		"base\n",
	);
	assert.equal(
		(await fetch(`${route}/${selected}/call-changes`)).status,
		200,
		"v2 captures feed the same exact retained analysis reads",
	);
	assert.equal(
		(await get(`${route}/${selected}/source?side=after&path=tracked.txt&sha256=${entry.sha256}`)).text,
		"first retained\n",
	);
	assert.match((await get(`${route}/${selected}/patch`)).patch, /first retained/);
	assert.doesNotMatch((await get(`${route}/${selected}/patch`)).patch, /UNSAVED/);
	await writeFile(join(chat.cwd, "tracked.txt"), "second retained\n");
	jj(chat.cwd, "commit", "-m", "Second standalone change");
	await checkpoint();
	const second = (await get(route)).comparisons;
	assert.equal(second.length, 2);
	assert.notEqual(second[0].request.changeId, second[1].request.changeId);
	jj(chat.cwd, "describe", "-r", first[0].request.changeId, "-m", "Revised first description");
	await checkpoint();
	const revised = (await get(route)).comparisons;
	const firstRevisions = revised.filter((c: any) => c.request.changeId === first[0].request.changeId);
	assert.equal(firstRevisions.length, 2);
	assert.notEqual(firstRevisions[0].request.head.commitId, firstRevisions[1].request.head.commitId);
	assert.deepEqual(await get(`${route}/${selected}`), snapshot, "old exact pair survives newer revisions");
	assert.deepEqual(await get(`${root}/projects/${f.project.id}/review`), {
		projectId: f.project.id,
		chats: [{ id: chat.id, title: sessions.get(chat.id)!.title }],
		more: false,
	});
	assert.equal((await fetch(`${route}/${selected}/records`)).status, 422);
	await checkpoint();
	assert.deepEqual((await get(route)).comparisons, revised, "duplicate lifecycle events do not recapture");
	await sessions.shutdown();
	const reopened = await f.manager();
	const reader = reopened.nativeReviewReader(chat.id, undefined, f.project.id, () => {});
	assert.deepEqual((await reader.list(0)).comparisons, revised);
	assert.deepEqual(await reader.get(selected), snapshot);
	const reopenedRoot = await serve(t, f, reopened);
	assert.deepEqual(await get(`${reopenedRoot}/sessions/${chat.id}/review/${selected}`), snapshot);
	assert.equal(
		(
			await get(
				`${reopenedRoot}/sessions/${chat.id}/review/${selected}/source?side=after&path=tracked.txt&sha256=${entry.sha256}`,
			)
		).text,
		"first retained\n",
	);
	await f.assertSourceUnchanged();
});

test("existing standalone workspace and pending creation recipes are never silently enrolled", async (t) => {
	const f = await fixture(t);
	const legacyId = randomUUID();
	const pendingId = randomUUID();
	const destination = join(f.home, "sessions", legacyId, "workspace");
	const w = await f.sessions["sharedWorkspaces"].create(f.source, destination);
	const base = { title: "Existing Build", mode: "build", projectId: f.project.id, createdAt: 1, updatedAt: 1 };
	await writeFile(
		join(f.home, "sessions", legacyId, "meta.json"),
		JSON.stringify({
			...base,
			id: legacyId,
			cwd: w.path,
			workspace: { source: f.project.path, base: w.base, jj: true, shared: w.shared },
		}),
	);
	await mkdir(join(f.home, "sessions", pendingId), { recursive: true });
	await writeFile(
		join(f.home, "sessions", pendingId, "meta.json"),
		JSON.stringify({
			...base,
			id: pendingId,
			cwd: join(f.home, "sessions", pendingId, "workspace"),
			preparing: { source: f.source },
		}),
	);
	await f.sessions.shutdown();
	const sessions = await f.manager();
	for (const id of [legacyId, pendingId]) {
		await sessions["start"](id);
		const meta = sessions["metas"].get(id)!;
		assert.ok(meta.workspace?.shared);
		await writeFile(join(meta.cwd, "tracked.txt"), "old chat cannot gain enrollment\n");
		jj(meta.cwd, "commit", "-m", "Existing chat change");
		await sessions["checkpointWorkerReview"](meta);
		const result = await sessions.nativeReviewReader(id, undefined, f.project.id, () => {}).list(0);
		assert.deepEqual(result.comparisons, []);
		assert.ok("unavailable" in result);
	}
});

test("new Ask, direct, cwd override and legacy mission chats never acquire project enrollment", async (t) => {
	const f = await fixture(t);
	const store = new MissionStore(":memory:");
	const service = new MissionService(store, f.sessions, f.projects);
	t.after(async () => {
		await service.notices.stop();
		store.close();
	});
	const mission = store.create({ projectId: f.project.id, title: "Legacy" });
	for (const request of [
		{ mode: "ask" as const },
		{ workspace: "direct" as const },
		{ cwd: f.source },
		{ missionId: mission.id },
	]) {
		const chat = await f.sessions.spawn({ projectId: f.project.id, message: "No new capture scope", ...request });
		await f.sessions["starting"].get(chat.id);
		const meta = f.sessions["metas"].get(chat.id)!;
		assert.equal(meta.failure, undefined);
		assert.equal(meta.retainedScope, undefined);
		if (meta.workspace?.shared) {
			assert.equal(
				await f.sessions["sharedWorkspaces"].ownership.projectSessionBinding(
					chat.id,
					f.project.id,
					meta.workspace.shared.repository,
					meta.workspace.shared.name,
				),
				undefined,
			);
		}
	}
});

test("marked new creation resumes after host reopen without enrolling an older recipe", async (t) => {
	const f = await fixture(t);
	f.sessions["sleepPause"] = { since: Date.now() };
	const chat = await f.sessions.spawn({ projectId: f.project.id, message: "Marked new creation" });
	const admitted = await f.stored(chat.id);
	assert.deepEqual(admitted.retainedScope, { version: 2, sessionId: chat.id, projectId: f.project.id });
	assert.ok(admitted.preparing);
	assert.equal(admitted.workspace, undefined);
	await f.sessions.shutdown();
	const sessions = await f.manager();
	await sessions["start"](chat.id);
	const meta = sessions["metas"].get(chat.id)!;
	assert.equal(meta.failure, undefined);
	assert.ok(meta.workspace?.shared);
	await writeFile(join(meta.cwd, "tracked.txt"), "resumed marked creation\n");
	jj(meta.cwd, "commit", "-m", "After reopen");
	await sessions["checkpointWorkerReview"](meta);
	const root = await serve(t, f, sessions);
	const response = await fetch(`${root}/sessions/${chat.id}/review`);
	assert.equal(response.status, 200);
	assert.equal(((await response.json()) as any).comparisons.length, 1);
});

test("project custody rechecks, later membership, collision and removal remain explicit", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const meta = f.sessions["metas"].get(chat.id)!;
	await writeFile(join(chat.cwd, "tracked.txt"), "owned standalone\n");
	jj(chat.cwd, "commit", "-m", "Project custody");
	await f.sessions["checkpointWorkerReview"](meta);
	const store = new MissionStore(":memory:");
	const service = new MissionService(store, f.sessions, f.projects);
	t.after(async () => {
		await service.notices.stop();
		store.close();
	});
	const root = await serve(t, f, f.sessions, { store, service });
	const route = `${root}/sessions/${chat.id}/review`;
	const page = (await (await fetch(route)).json()) as any;
	const selected = page.comparisons[0].snapshotId;
	const expected = `${route}/${selected}?expectedProjectId=${f.project.id}`;
	const snapshot = await (await fetch(expected)).json();
	const binding = await f.sessions["retainedWorkerBinding"](chat.id, undefined, f.project.id, () => {}, true);
	assert.equal(binding.version, 2);
	const mission = store.create({ projectId: f.project.id, title: "Later membership", planningVersion: 1 });
	store.join(chat.id, mission.id);
	store.addTask(mission.id, { title: "Later task", sessionId: chat.id });
	assert.deepEqual(await (await fetch(expected)).json(), snapshot);
	await f.sessions["checkpointWorkerReview"](meta);
	assert.deepEqual(
		await f.sessions["retainedWorkerBinding"](chat.id, undefined, f.project.id, () => {}, true),
		binding,
	);
	assert.equal(
		(await fetch(`${root}/missions/${mission.id}/review/${chat.id}/${selected}`)).status,
		403,
		"mission authorization cannot fall back to project/chat custody",
	);
	assert.equal((await fetch(`${route}/${selected}/records`)).status, 422);
	store.leave(chat.id);
	assert.deepEqual(await (await fetch(expected)).json(), snapshot, "project binding is not mission membership");
	const ledger = f.sessions["sharedWorkspaces"].ownership;
	const lookup = ledger.projectSessionBinding.bind(ledger);
	const original = meta.workspace!.shared!;
	const moving = t.mock.method(ledger, "projectSessionBinding", async (...args: Parameters<typeof lookup>) => {
		const result = await lookup(...args);
		meta.workspace!.shared = { ...original, repository: f.home };
		return result;
	});
	assert.equal((await fetch(expected)).status, 403, "changed custody during binding I/O refuses bytes");
	moving.mock.restore();
	meta.workspace!.shared = original;
	assert.equal((await fetch(`${route}/${selected}?expectedProjectId=wrong`)).status, 403);
	const record = (await ledger.get(binding.repositoryId, page.comparisons[0].request.changeId)).ownership;
	assert.equal(record.status, "owned");
	if (record.status !== "owned") throw new Error("Expected managed owner");
	await ledger.register(
		{ ...binding, workspace: `pilot-collision-${"e".repeat(16)}` },
		{
			...record.creation,
			kind: "workspace-created",
		},
	);
	assert.equal((await fetch(expected)).status, 403, "collision invalidates retained disclosure");
	await f.projects.remove(f.project.id);
	assert.equal((await fetch(route)).status, 404);
	assert.equal((await fetch(`${root}/projects/${f.project.id}/review`)).status, 404);
});

test("interrupted real SQLite capture reopens the same request; shared quota refuses without eviction", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	await f.sessions["workerReviewDelivery"]["tail"];
	const meta = f.sessions["metas"].get(chat.id)!;
	await writeFile(join(chat.cwd, "tracked.txt"), "exact interrupted source\n");
	jj(chat.cwd, "commit", "-m", "Interrupted capture");
	await f.sessions["sharedWorkspaces"].observeOwnership(meta.cwd, meta.workspace!.shared!);
	const binding = await f.sessions["retainedWorkerBinding"](chat.id, undefined, f.project.id, () => {}, true);
	const ledger = f.sessions["sharedWorkspaces"].ownership;
	const [request] = await ledger.deliveries(binding);
	assert.ok(request);
	const file = join(f.home, "review-snapshots.sqlite");
	const provenance = {
		capturedAt: 123,
		ledger: await ledger.get(request.repositoryId, request.changeId),
		taskAttribution: "unknown",
	};
	const worker = new Worker(new URL("./review-snapshot-worker.ts", import.meta.url), { workerData: { file } });
	try {
		const cancelled = new Promise<{ error?: string }>((resolve, reject) => {
			worker.on("error", reject);
			worker.on("message", (message) => {
				if (message.id === 1) resolve(message);
			});
		});
		worker.postMessage({ id: 1, method: "capture", args: { request, provenance } });
		worker.postMessage({ cancel: 1 });
		assert.match((await cancelled).error!, /cancel/i);
	} finally {
		await worker.terminate();
	}
	assert.deepEqual(await f.sessions["reviewSnapshots"].lookup(request), { status: "interrupted" });
	await f.sessions.shutdown();
	const sessions = await f.manager();
	const root = await serve(t, f, sessions);
	const route = `${root}/sessions/${chat.id}/review`;
	let response = await fetch(route);
	assert.equal(response.status, 200);
	const interrupted = (await response.json()) as any;
	assert.equal(interrupted.capture.pending, 1);
	assert.equal(interrupted.comparisons.length, 0);
	const reopenedMeta = sessions["metas"].get(chat.id)!;
	await sessions["checkpointWorkerReview"](reopenedMeta);
	response = await fetch(route);
	const recovered = (await response.json()) as any;
	assert.equal(recovered.comparisons.length, 1);
	assert.deepEqual(recovered.comparisons[0].request, request);
	const selected = recovered.comparisons[0].snapshotId;
	assert.equal((await sessions["reviewSnapshots"].get(selected)).manifest.provenance.capturedAt, 123);
	// Fill the existing shared request budget, without changing its production limit.
	const db = new DatabaseSync(file);
	try {
		db.exec("BEGIN");
		const insert = db.prepare("INSERT INTO captures VALUES(?,?,?,NULL)");
		for (let i = 1; i < 10_000; i++) insert.run(`quota-${i}`, "{}", "{}");
		db.exec("COMMIT");
	} finally {
		db.close();
	}
	await writeFile(join(chat.cwd, "tracked.txt"), "cannot evict older source\n");
	jj(chat.cwd, "commit", "-m", "Quota refusal");
	await sessions["checkpointWorkerReview"](reopenedMeta);
	const full = (await (await fetch(route)).json()) as any;
	assert.equal(full.capture.failed, 1);
	assert.equal(full.comparisons.length, 1);
	assert.equal((await fetch(`${route}/${selected}/patch`)).status, 200);
	const status = new DatabaseSync(join(f.home, "jj-ownership.sqlite"));
	try {
		assert.equal(
			status.prepare("SELECT failure FROM delivery_checkpoints WHERE state='failed'").get()!.failure,
			"retention-quota",
		);
	} finally {
		status.close();
	}
});
