// biome-ignore-all lint/complexity/useLiteralKeys: Exercise production lifecycle and durable storage seams.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type {
	NativeReviewCaptureStatus,
	NativeReviewComparison,
	NativeReviewSnapshot,
	SessionState,
} from "@pilot/protocol";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import type { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionManager, SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { fixture, jj } from "./testing/session-workspace.ts";

type NativeReviewPage = {
	comparisons: NativeReviewComparison[];
	next: number | null;
	capture?: NativeReviewCaptureStatus;
};
type ProjectReviewPage = { chats: { id: string }[] };

/** No provider or kernel SDK: the managed worker performs real jj writes in its assigned cwd. */
class FakeAgent implements SessionWorker {
	ready = Promise.resolve();
	state: SessionState = "idle";
	busy = false;
	inputs = 0;
	changes: { changeId: string; commitId: string }[] = [];
	cwd: string;
	onPacket: (packet: KernelPacket) => void;
	constructor(cwd: string, onPacket: (packet: KernelPacket) => void) {
		this.cwd = cwd;
		this.onPacket = onPacket;
	}
	send(_command: KernelCommand) {}
	async request(command: KernelCommand) {
		if (command.type !== "input") return;
		this.inputs++;
		this.state = "working";
		this.onPacket({ type: "working", working: true });
		for (let n = 0; n < 6; n++) {
			writeFileSync(join(this.cwd, "tracked.txt"), `agent layer ${n}\n`);
			jj(this.cwd, "commit", "-m", `Agent layer ${n}`);
			this.changes.push(this.revision("@-"));
		}
		this.state = "idle";
		this.onPacket({ type: "working", working: false });
	}
	revision(ref: string) {
		const [changeId, commitId] = jj(
			this.cwd,
			"--ignore-working-copy",
			"log",
			"--no-graph",
			"-r",
			ref,
			"-T",
			'change_id ++ " " ++ commit_id',
		).split(" ");
		return { changeId: changeId!, commitId: commitId! };
	}
	async close() {}
}

async function serve(
	t: TestContext,
	home: string,
	sessions: SessionManager,
	projects: ProjectStore,
	store: MissionStore,
	service: MissionService,
) {
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog("/unused"),
		terminals,
		{ store, service },
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		terminals.shutdown();
	});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function get<T>(url: string): Promise<T> {
	const response = await fetch(url);
	assert.equal(response.status, 200, await response.clone().text());
	return response.json() as Promise<T>;
}

for (const legacyMission of [false, true])
	test(`managed ${legacyMission ? "legacy-mission" : "standalone"} agent drains six changes from one turn and reopens exact revisions`, async (t) => {
		const agents: FakeAgent[] = [];
		const f = await fixture(
			t,
			{},
			{
				worker: (spec, onPacket) => {
					const agent = new FakeAgent(spec.cwd, onPacket);
					agents.push(agent);
					return agent;
				},
			},
		);
		const stores: MissionStore[] = [];
		const services: MissionService[] = [];
		t.after(async () => {
			for (const service of services) await service.notices.stop();
			for (const store of stores) store.close();
		});
		const connect = (sessions: SessionManager) => {
			const store = new MissionStore(join(f.home, "missions.sqlite"));
			const service = new MissionService(store, sessions, f.projects);
			stores.push(store);
			services.push(service);
			return { store, service };
		};
		const { store, service } = connect(f.sessions);
		const mission = store.create({ projectId: f.project.id, title: "Legacy work" });
		assert.equal(mission.planningVersion, undefined);
		const task = store.addTask(mission.id, { title: "Write changes" });
		const spawn = async (taskId = task.id) => {
			const chat = await f.sessions.spawn(
				{
					projectId: f.project.id,
					message: "Write six layers",
					...(legacyMission ? { missionId: mission.id } : {}),
				},
				false,
				legacyMission ? taskId : undefined,
			);
			await f.sessions["starting"].get(chat.id);
			assert.equal(f.sessions["metas"].get(chat.id)!.failure, undefined);
			await f.sessions["workerReviewDelivery"]["tail"];
			return f.sessions.get(chat.id)!;
		};
		const chat = await spawn();
		const agent = agents[0]!;
		assert.equal(agent.inputs, 1, "no extra prompt/ready/Review GET is needed to finish capture");
		const root = await serve(t, f.home, f.sessions, f.projects, store, service);
		const route = `${root}/sessions/${chat.id}/review`;
		const first = await get<NativeReviewPage>(route);
		assert.equal(first.comparisons.length, 6);
		assert.deepEqual(first.capture, { pending: 0, failed: 0 });
		assert.equal(first.next, null);
		assert.deepEqual(
			first.comparisons.map((c) => c.request.head).sort((a, b) => a.changeId.localeCompare(b.changeId)),
			[...agent.changes].sort((a, b) => a.changeId.localeCompare(b.changeId)),
		);
		const inventory = await get<ProjectReviewPage>(`${root}/projects/${f.project.id}/review`);
		assert.deepEqual(
			inventory.chats.map((c) => c.id),
			[chat.id],
		);
		const snapshots = [];
		const patches = new Map<string, { patch: string }>();
		for (const c of first.comparisons) {
			const snapshot = await get<NativeReviewSnapshot>(`${route}/${c.snapshotId}`);
			assert.equal(snapshot.workerId, chat.id);
			assert.deepEqual(snapshot.enrollmentTaskIds, legacyMission ? [task.id] : []);
			assert.equal(snapshot.enrollmentProjectId, legacyMission ? undefined : f.project.id);
			const patch = await get<{ patch: string }>(`${route}/${c.snapshotId}/patch`);
			assert.match(patch.patch, /agent layer/);
			patches.set(c.snapshotId, patch);
			snapshots.push(snapshot);
		}
		assert.deepEqual(
			(await get<{ requests: unknown[] }>(`${root}/review/requests?sessionId=${chat.id}&after=0`)).requests,
			[],
			"capture/browsing never creates optional or required requests",
		);
		const selected = first.comparisons[0]!;
		jj(chat.cwd, "describe", "-r", selected.request.changeId, "-m", "Exact revised change");
		const revisedHead = agent.revision(selected.request.changeId);
		// A fresh completion can arrive after the idle edge (for example a job follow-up).
		agent.onPacket({ type: "working", working: false, completion: { outcome: "done", outcomeAt: Date.now() } });
		await f.sessions["workerReviewDelivery"]["tail"];
		const revised = await get<NativeReviewPage>(route);
		assert.ok(revised.comparisons.some((c) => c.request.head.commitId === revisedHead.commitId));
		assert.notEqual(revisedHead.commitId, selected.request.head.commitId);
		assert.deepEqual(await get(`${route}/${selected.snapshotId}`), snapshots[0]);
		assert.equal(agent.inputs, 1);
		// A different, newly managed agent cannot borrow these comparisons. Failures
		// are visible in the same production inventory even with no retained bytes.
		const capture = t.mock.method(f.sessions["reviewSnapshots"], "capture", async () => {
			throw new Error("retention quota reached");
		});
		const peerTask = store.addTask(mission.id, { title: "Independent changes" });
		const peer = await spawn(peerTask.id);
		capture.mock.restore();
		const failed = await get<NativeReviewPage>(`${root}/sessions/${peer.id}/review`);
		assert.deepEqual(failed.comparisons, []);
		assert.deepEqual(failed.capture, { pending: 0, failed: 6 });
		assert.deepEqual(await get(route), revised, "another worker failure does not alter the first inventory");
		assert.deepEqual(
			new Set((await get<ProjectReviewPage>(`${root}/projects/${f.project.id}/review`)).chats.map((c) => c.id)),
			new Set([chat.id, peer.id]),
		);
		const peerMeta = f.sessions["metas"].get(peer.id)!;
		const peerBinding = legacyMission
			? await f.sessions["sharedWorkspaces"].ownership.sessionBinding(
					peer.id,
					mission.id,
					peerMeta.workspace!.shared!.repository,
					peerMeta.workspace!.shared!.name,
				)
			: await f.sessions["sharedWorkspaces"].ownership.projectSessionBinding(
					peer.id,
					f.project.id,
					peerMeta.workspace!.shared!.repository,
					peerMeta.workspace!.shared!.name,
				);
		assert.ok(peerBinding);
		for (const change of agents[1]!.changes) {
			const owned = await f.sessions["sharedWorkspaces"].ownership.get(peerBinding.repositoryId, change.changeId);
			assert.equal(owned.ownership.status, "owned");
			if (owned.ownership.status === "owned") {
				assert.equal(owned.ownership.binding.sessionId, peer.id);
				assert.equal(owned.ownership.taskAttribution, "unknown");
			}
		}
		await service.notices.stop();
		await store.durable();
		await f.sessions.shutdown();
		store.close();
		stores.splice(stores.indexOf(store), 1);
		const reopened = await f.manager();
		const recovered = connect(reopened);
		const reopenedRoot = await serve(t, f.home, reopened, f.projects, recovered.store, recovered.service);
		assert.deepEqual(await get(`${reopenedRoot}/sessions/${chat.id}/review`), revised);
		for (const snapshot of snapshots) {
			assert.deepEqual(await get(`${reopenedRoot}/sessions/${chat.id}/review/${snapshot.snapshotId}`), snapshot);
			assert.deepEqual(
				await get(`${reopenedRoot}/sessions/${chat.id}/review/${snapshot.snapshotId}/patch`),
				patches.get(snapshot.snapshotId),
			);
		}
		assert.deepEqual(await get(`${reopenedRoot}/sessions/${peer.id}/review`), failed);
		assert.equal(agents.length, 2, "passive reopened reads never start a worker");
		await f.assertSourceUnchanged();
	});

test("an unmarked legacy mission recipe and a later assignment do not adopt existing work", async (t) => {
	const f = await fixture(t);
	const store = new MissionStore(join(f.home, "missions.sqlite"));
	const service = new MissionService(store, f.sessions, f.projects);
	t.after(async () => {
		await service.notices.stop();
		store.close();
	});
	const mission = store.create({ projectId: f.project.id, title: "Existing mission" });
	const task = store.addTask(mission.id, { title: "Original assignment" });
	f.sessions["sleepPause"] = { since: Date.now() };
	const chat = await f.sessions.spawn(
		{ projectId: f.project.id, missionId: mission.id, message: "Original recipe" },
		false,
		task.id,
	);
	const meta = f.sessions["metas"].get(chat.id)!;
	assert.equal(meta.retainedMissionCreation, true);
	// Model an older saved recipe, not an already-enrolled binding.
	delete meta.retainedMissionCreation;
	await f.sessions["save"](meta, undefined, undefined, true);
	delete f.sessions["sleepPause"];
	await f.sessions["start"](chat.id);
	assert.equal(meta.failure, undefined);
	assert.ok(meta.workspace?.shared);
	await f.sessions.stop(chat.id);
	writeFileSync(join(meta.cwd, "tracked.txt"), "unbound legacy bytes\n");
	jj(meta.cwd, "commit", "-m", "Unbound history");
	store.addTask(mission.id, { title: "Later assignment", sessionId: chat.id });
	await f.sessions["checkpointWorkerReview"](meta);
	const root = await serve(t, f.home, f.sessions, f.projects, store, service);
	const page = await get<NativeReviewPage & { unavailable?: string }>(`${root}/sessions/${chat.id}/review`);
	assert.deepEqual(page.comparisons, []);
	assert.match(page.unavailable!, /No retained managed ownership binding/);
	assert.deepEqual((await get<ProjectReviewPage>(`${root}/projects/${f.project.id}/review`)).chats, []);
});
