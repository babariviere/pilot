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

test("real session host custody admits a committed checkpoint and rejects project, repository, worker and membership changes", async () => {
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
		store.updateTask(mission.id, task.id, { status: "done" });
		await sessions["checkpointWorkerReview"](meta);
		assert.equal((await reader.list(0)).comparisons.length, 1, "task completion is neither capture nor acceptance");
		const other = await projects.create({ path: home });
		meta.projectId = other.id;
		await assert.rejects(sessions["checkpointWorkerReview"](meta), /custody/);
		await assert.rejects(reader.diff(first[0]!.snapshotId));
		meta.projectId = project.id;
		const original = meta.workspace.shared;
		meta.workspace.shared = { ...original, repository: home };
		await sessions["checkpointWorkerReview"](meta); // Unknown binding is never enrolled.
		await assert.rejects(reader.get(first[0]!.snapshotId), /enrollment/);
		meta.workspace.shared = original;
		await assert.rejects(
			sessions.nativeReviewReader(randomUUID(), mission.id, project.id, () => {}).get(first[0]!.snapshotId),
			/custody/,
		);
		store.leave(id);
		await sessions["checkpointWorkerReview"](meta);
		await assert.rejects(reader.get(first[0]!.snapshotId));
		assert.equal((await fetch(`${root}/${selected.snapshotId}/patch`)).status, 403);
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
