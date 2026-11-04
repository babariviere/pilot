import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { fixture, jj } from "./testing/shared-workspace.ts";

test("real session host custody admits a committed checkpoint and rejects project, repository, worker and membership changes", async (t) => {
	const f = fixture();
	const home = join(realpathSync(f.root), "home");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: f.source });
	const sessions = new SessionManager(home, projects, undefined, { title: async () => undefined });
	const store = new MissionStore(":memory:");
	const service = new MissionService(store, sessions, projects);
	const mission = store.create({ projectId: project.id, title: "Capture", planningVersion: 1 });
	const id = randomUUID();
	store.join(id, mission.id);
	const task = store.addTask(mission.id, { title: "Build", sessionId: id });
	const scope = sessions["missions"]!.ownershipScope!(id)!;
	const w = await f.store.create(f.source, join(home, "sessions", id, "workspace"), undefined, undefined, scope);
	const meta = {
		id,
		title: "Real retained worker",
		cwd: w.path,
		projectId: project.id,
		workspace: { source: project.path, base: w.base, jj: true, shared: w.shared! },
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	sessions["metas"].set(id, meta);
	const worker: SessionWorker = {
		ready: Promise.resolve(),
		state: "idle",
		busy: false,
		send: () => {},
		request: async () => {},
		close: async () => {},
	};
	sessions["workers"].set(id, worker);
	const authorize = () => {
		assert.equal(store.membership(id)?.missionId, mission.id);
		assert.equal(sessions.get(id)?.projectId, project.id);
	};
	const reader = sessions.nativeReviewReader(id, mission.id, project.id, authorize);
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
		{ store, service },
	);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/missions/${mission.id}/review/${id}`;
	const chatRoot = root.replace(`/missions/${mission.id}/review/${id}`, `/sessions/${id}/review`);
	const projectRoot = root.replace(`/missions/${mission.id}/review/${id}`, `/projects/${project.id}/review`);
	try {
		writeFileSync(join(w.path, "a.txt"), "session retained\n");
		jj(w.path, "commit", "-m", "Committed session revision");
		// Genuine production lifecycle hook and bridge, not a caller-authored capture request.
		sessions["onPacket"](meta, worker, { type: "ready", model: "test/model", working: false, usage: {} });
		await sessions["workerReviewDelivery"]["tail"];
		const first = (await reader.list(0)).comparisons;
		assert.equal(first.length, 1);
		assert.match(await reader.diff(first[0]!.snapshotId), /session retained/);
		const response = await fetch(`${root}?after=0`);
		assert.equal(response.status, 200);
		assert.deepEqual(((await response.json()) as { comparisons: unknown[] }).comparisons, first);
		const selected = first[0]!;
		const snapshotResponse = await fetch(`${root}/${selected.snapshotId}`);
		assert.equal(snapshotResponse.status, 200);
		const snapshot = (await snapshotResponse.json()) as { after: { path: string; sha256: string }[] };
		assert.equal((await fetch(`${root}/${selected.snapshotId}/patch`)).status, 200);
		const entry = snapshot.after.find((e) => e.path === "a.txt")!;
		const source = await fetch(`${root}/${selected.snapshotId}/source?side=after&path=a.txt&sha256=${entry.sha256}`);
		assert.equal(source.status, 200);
		assert.deepEqual(await source.json(), { snapshotId: selected.snapshotId, text: "session retained\n" });
		assert.equal((await fetch(root, { method: "POST" })).status, 405, "read transport cannot trigger capture");
		assert.deepEqual(await (await fetch(projectRoot)).json(), {
			projectId: project.id,
			chats: [{ id, title: meta.title, missionId: mission.id }],
			more: false,
		});
		for (const suffix of [
			"?after=0",
			`/${selected.snapshotId}`,
			`/${selected.snapshotId}/patch`,
			`/${selected.snapshotId}/records`,
			`/${selected.snapshotId}/source?side=after&path=a.txt&sha256=${entry.sha256}`,
		]) {
			const oldResponse = await fetch(`${root}${suffix}`);
			const chatResponse = await fetch(`${chatRoot}${suffix}`);
			assert.equal(chatResponse.status, oldResponse.status);
			assert.deepEqual(await chatResponse.json(), await oldResponse.json(), "new routes preserve existing bodies");
		}
		const ownership = sessions["sharedWorkspaces"].ownership;
		const lookup = ownership.sessionBinding.bind(ownership);
		const originalShared = meta.workspace.shared;
		const changing = t.mock.method(ownership, "sessionBinding", async (...args: Parameters<typeof lookup>) => {
			const binding = await lookup(...args);
			meta.workspace.shared = { ...originalShared, repository: home };
			return binding;
		});
		assert.equal(
			(await fetch(`${chatRoot}/${selected.snapshotId}`)).status,
			403,
			"real custody changes during binding I/O refuse content",
		);
		meta.workspace.shared = originalShared;
		assert.equal((await fetch(projectRoot)).status, 403, "discovery also checks custody around binding I/O");
		changing.mock.restore();
		meta.workspace.shared = originalShared;
		store.updateTask(mission.id, task.id, { status: "done" });
		await sessions["checkpointWorkerReview"](meta);
		assert.equal((await reader.list(0)).comparisons.length, 1, "task completion is neither capture nor acceptance");
		const other = await projects.create({ path: home });
		meta.projectId = other.id;
		await assert.rejects(sessions["checkpointWorkerReview"](meta), /custody/);
		await assert.rejects(reader.diff(first[0]!.snapshotId));
		assert.equal((await fetch(`${chatRoot}/${selected.snapshotId}`)).status, 403);
		assert.deepEqual(((await (await fetch(projectRoot)).json()) as any).chats, []);
		meta.projectId = project.id;
		const original = meta.workspace.shared;
		meta.workspace.shared = { ...original, repository: home };
		await sessions["checkpointWorkerReview"](meta); // Unknown binding is never enrolled.
		await assert.rejects(reader.get(first[0]!.snapshotId), /enrollment/);
		const unbound = await fetch(chatRoot);
		assert.equal(unbound.status, 200);
		assert.match(
			((await unbound.json()) as any).unavailable,
			/No retained worker enrollment|No retained managed ownership binding/,
		);
		meta.workspace.shared = original;
		await assert.rejects(
			sessions.nativeReviewReader(randomUUID(), mission.id, project.id, () => {}).get(first[0]!.snapshotId),
			/custody/,
		);
		store.leave(id);
		await sessions["checkpointWorkerReview"](meta);
		await assert.rejects(reader.get(first[0]!.snapshotId));
		assert.equal((await fetch(`${root}/${selected.snapshotId}/patch`)).status, 403);
		assert.equal((await fetch(`${chatRoot}/${selected.snapshotId}/patch`)).status, 403);
		assert.deepEqual(((await (await fetch(projectRoot)).json()) as any).chats, []);
		assert.match(((await (await fetch(chatRoot)).json()) as any).unavailable, /Not captured/);
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
		terminals.shutdown();
		await service.notices.stop();
		await sessions.shutdown();
		await f.store.close();
		store.close();
		f.close();
	}
});
