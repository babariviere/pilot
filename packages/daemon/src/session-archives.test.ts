// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without launching a kernel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ServerMessage, SessionState, SessionSummary } from "@pilot/protocol";
import { WebSocket } from "ws";
import { Conflict, NotFound } from "./errors.ts";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { applyActivity } from "./session-outcomes.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { legacyGitHub } from "./testing/legacy-github.ts";

type Meta = Parameters<SessionManager["save"]>[0];
type Command = Parameters<SessionWorker["request"]>[0];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

class FakeWorker implements SessionWorker {
	readonly gate = deferred();
	readonly ready = this.gate.promise;
	state: SessionState = "idle";
	busy = false;
	toolsRunning = false;
	compacting = false;
	runningJobs: SessionWorker["runningJobs"] = [];
	awaitingJobFollowUp = false;
	readonly commands: Command[] = [];

	send(): void {}

	async request(command: Command): Promise<void> {
		this.commands.push(command);
	}

	async close(): Promise<void> {
		this.gate.resolve();
	}
}

/** `git` answers the archive tests' non-repository workspaces unless a test emulates one. */
async function fixture(gitRunner?: (args: string[]) => string | undefined) {
	const home = await mkdtemp(join(tmpdir(), "pilot-archives-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const first = await projects.create({ path: home, name: "First" });
	const otherDir = join(home, "other");
	await mkdir(otherDir);
	const second = await projects.create({ path: otherDir, name: "Second" });
	const ids = [randomUUID(), randomUUID(), randomUUID()];
	for (const [index, id] of ids.entries()) {
		const dir = join(home, "sessions", id);
		await mkdir(join(dir, "workspace"), { recursive: true });
		await mkdir(join(dir, "durable"));
		await writeFile(join(dir, "durable", "history"), "retained transcript");
		await writeFile(join(dir, "workspace", "work.txt"), "retained changes");
		await writeFile(
			join(dir, "meta.json"),
			JSON.stringify({
				id,
				title: `Chat ${index}`,
				cwd: join(dir, "workspace"),
				...(index < 2 ? { projectId: index === 0 ? first.id : second.id } : {}),
				workspace: {
					source: home,
					branch: `pilot/chat-${index}`,
					upstream: "https://github.com/example/archive-tests.git",
					base: "base",
					jj: true,
				},
				createdAt: 100,
				updatedAt: 200 + index,
				working: false,
				outcome: "done",
				outcomeAt: 150,
				outcomeReason: "Review requested",
				lastOutcomeAt: 150,
				lastCompletionAt: 150,
				pullRequest: {
					number: 11,
					url: "https://github.com/example/archive-tests/pull/11",
					title: "Cached archive PR",
					state: "open",
					checkedAt: 160,
				},
			}),
		);
	}
	const managers: SessionManager[] = [];
	const manager = async (
		bridge?: Parameters<SessionManager["setMissionBridge"]>[0],
		configure?: (sessions: SessionManager) => void,
	) => {
		const sessions = new SessionManager(
			home,
			projects,
			undefined,
			{
				worker: () => {
					throw new Error("Archive tests must not launch a kernel");
				},
			},
			{
				runner: legacyGitHub(async (file, args) => {
					const answer = file === "git" ? gitRunner?.(args) : undefined;
					if (answer !== undefined) return answer;
					return file === "git" && args[0] === "branch" ? "" : "[]";
				}),
			},
		);
		managers.push(sessions);
		configure?.(sessions);
		if (bridge) sessions.setMissionBridge(bridge);
		await sessions.load();
		await sessions["pullRequests"].settled();
		return sessions;
	};
	const cleanup = async () => {
		await Promise.all(
			managers.map(async (sessions) => {
				await sessions.shutdown();
				await Promise.allSettled([...sessions["starting"].values()]);
				await Promise.allSettled([...sessions["saving"].values()]);
			}),
		);
		await rm(home, { recursive: true, force: true });
	};
	const sessions = await manager();
	return { home, projects, first, second, sessions, ids, manager, cleanup };
}

async function coordinatorFixture(t: TestContext) {
	const f = await fixture();
	// Archival needs no repository role transition or real kernel.
	t.mock.method(
		f.sessions as unknown as { prepareCoordinatorRole(id: string): Promise<void> },
		"prepareCoordinatorRole",
		async () => {},
	);
	const store = new MissionStore(":memory:");
	const service = new MissionService(store, f.sessions, f.projects);
	t.after(async () => {
		await service.notices.stop();
		await f.cleanup();
		store.close();
	});
	const mission = store.create({ projectId: f.first.id, title: "Shared work" });
	const id = f.ids[0]!;
	store.join(id, mission.id);
	store.update(mission.id, { coordinatorSessionId: id });
	await f.sessions["coordinatorUnbindings"].get(id);
	return { ...f, service, store, mission, id, meta: f.sessions["metas"].get(id)! };
}

test("archiving a mission immediately archives its idle coordinator, even pinned, but not its members", async (t) => {
	const f = await coordinatorFixture(t);
	const member = f.ids[1]!;
	f.store.join(member, f.mission.id);
	await f.sessions.setPinned(f.id, true);
	f.store.update(f.mission.id, { status: "done" });
	assert.equal(f.sessions.get(f.id)?.archivedAt, undefined, "done is not archived");
	f.store.update(f.mission.id, { status: "archived" });
	await f.sessions["archiveTransitions"].get(f.id)?.promise;
	assert.ok(f.sessions.get(f.id)?.archivedAt);
	assert.equal(f.sessions.get(f.id)?.pinned, true);
	assert.equal(f.sessions.get(member)?.archivedAt, undefined);
	assert.equal(f.sessions.get(f.id)?.missionId, f.mission.id);
	assert.equal(await readFile(join(f.home, "sessions", f.id, "durable", "history"), "utf8"), "retained transcript");
	assert.equal(f.sessions["workers"].size, 0);
});

test("a working coordinator archives on completion without aborting its turn", async (t) => {
	const f = await coordinatorFixture(t);
	const worker = new FakeWorker();
	f.sessions["workers"].set(f.id, worker);
	f.meta.working = true;
	worker.state = "working";
	f.store.update(f.mission.id, { status: "archived" });
	assert.equal(f.sessions.get(f.id)?.archivedAt, undefined);
	assert.deepEqual(worker.commands, []);
	f.meta.working = false;
	worker.state = "idle";
	f.sessions["emit"](f.meta);
	await f.sessions["archiveTransitions"].get(f.id)?.promise;
	assert.ok(f.sessions.get(f.id)?.archivedAt);
	assert.deepEqual(worker.commands, [], "archival must not send Stop or reopen the worker");
});

test("coordinator archival waits for children, tools, compaction and background-job follow-ups", async (t) => {
	const f = await coordinatorFixture(t);
	const worker = new FakeWorker();
	f.sessions["workers"].set(f.id, worker);
	f.meta.working = true;
	f.store.update(f.mission.id, { status: "archived" });
	f.meta.working = false;
	const holds: Array<[() => void, () => void]> = [
		[() => (worker.toolsRunning = true), () => (worker.toolsRunning = false)],
		[() => (worker.compacting = true), () => (worker.compacting = false)],
		[() => (worker.awaitingJobFollowUp = true), () => (worker.awaitingJobFollowUp = false)],
		[
			() =>
				(f.meta.subagents = [
					{ name: "child", task: "Work", createdAt: 1, cwd: f.home, storage: f.home, state: "working" },
				]),
			() => delete f.meta.subagents,
		],
		[
			() =>
				(worker.runningJobs = [
					{ id: "job", name: "Work", state: "running", startedAt: 1, outputPath: join(f.home, "job.log") },
				]),
			() => (worker.runningJobs = []),
		],
		[
			() => (f.meta.pending = [{ type: "input", requestId: "follow-up", content: "Finish", mode: "followUp" }]),
			() => delete f.meta.pending,
		],
	];
	for (const [hold, release] of holds) {
		hold();
		f.sessions["emit"](f.meta);
		await f.sessions["archiveMissionCoordinator"](f.meta);
		assert.equal(f.sessions.get(f.id)?.archivedAt, undefined);
		release();
	}
	f.sessions["emit"](f.meta);
	await f.sessions["archiveTransitions"].get(f.id)?.promise;
	assert.ok(f.sessions.get(f.id)?.archivedAt);
});

for (const change of ["restore", "leave", "coordinator", "work"] as const) {
	test(`queued coordinator archival rechecks ${change} after mission durability`, async (t) => {
		const f = await coordinatorFixture(t);
		const gate = deferred();
		const entered = deferred();
		f.sessions["missions"]!.whenDurable = () => {
			entered.resolve();
			return gate.promise;
		};
		try {
			f.store.update(f.mission.id, { status: "archived" });
			const pending = f.sessions["archiveTransitions"].get(f.id)!.promise;
			await entered.promise;
			assert.equal(f.meta.archivedAt, undefined, "mission commit must be durable first");
			if (change === "restore") f.store.update(f.mission.id, { status: "active" });
			else if (change === "leave") f.store.leave(f.id);
			else if (change === "coordinator") f.store.update(f.mission.id, { coordinatorSessionId: null });
			else f.meta.working = true;
			gate.resolve();
			await pending;
			assert.equal(f.sessions.get(f.id)?.archivedAt, undefined);
		} finally {
			gate.resolve();
		}
	});
}

test("explicit coordinator restore wins until its mission is archived again", async (t) => {
	const f = await coordinatorFixture(t);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	f.store.update(f.mission.id, { status: "archived" });
	await f.sessions["archiveTransitions"].get(f.id)?.promise;
	assert.ok(f.meta.archivedAt);
	now += 1;
	await f.sessions.restore(f.id);
	await f.sessions["archiveMissionCoordinator"](f.meta);
	assert.equal(f.meta.archivedAt, undefined);
	await f.sessions.shutdown();
	const reopened = await f.manager(f.sessions["missions"]!, (sessions) => {
		t.mock.method(
			sessions as unknown as { prepareCoordinatorRole(id: string): Promise<void> },
			"prepareCoordinatorRole",
			async () => {},
		);
	});
	await reopened["archiveMissionCoordinator"](reopened["metas"].get(f.id)!);
	assert.equal(reopened.get(f.id)?.archivedAt, undefined, "manual restoration survives restart");
	// The original bridge still routes updates to the first manager; test the next archive there.
	now += 1;
	f.store.update(f.mission.id, { status: "active" });
	now += 1;
	f.store.update(f.mission.id, { status: "archived" });
	await reopened.shutdown();
	const again = await f.manager(f.sessions["missions"]!, (sessions) => {
		t.mock.method(
			sessions as unknown as { prepareCoordinatorRole(id: string): Promise<void> },
			"prepareCoordinatorRole",
			async () => {},
		);
	});
	await again["archiveTransitions"].get(f.id)?.promise;
	assert.ok(again.get(f.id)?.archivedAt, "a new mission archive supersedes the earlier chat restore");
});

test("pending coordinator archival recovers on restart without launching a kernel", async (t) => {
	const f = await coordinatorFixture(t);
	f.meta.working = true;
	f.store.update(f.mission.id, { status: "archived" });
	f.meta.working = false;
	await f.sessions["save"](f.meta);
	await f.sessions.shutdown();
	const reopened = await f.manager(f.sessions["missions"]!, (sessions) => {
		t.mock.method(
			sessions as unknown as { prepareCoordinatorRole(id: string): Promise<void> },
			"prepareCoordinatorRole",
			async () => {},
		);
	});
	await reopened["coordinatorUnbindings"].get(f.id);
	await reopened["roleTransitions"].get(f.id);
	await reopened["archiveTransitions"].get(f.id)?.promise;
	assert.ok(reopened.get(f.id)?.archivedAt);
	assert.equal(reopened["workers"].size, 0);
});

test("archives and restores durably, retaining history, workspace and project association", async () => {
	const { home, first, sessions, ids, manager, cleanup } = await fixture();
	const id = ids[0]!;
	try {
		const original = sessions.get(id)!;
		const changes: SessionSummary[] = [];
		sessions.onChange((session) => changes.push(session));
		const archived = await sessions.archive(id);
		assert.ok(archived.archivedAt);
		assert.deepEqual(archived, { ...original, archivedAt: archived.archivedAt });
		assert.deepEqual(await sessions.archive(id), archived);
		assert.equal(changes.length, 1);
		assert.equal(sessions.list().length, 2);
		assert.deepEqual(sessions.list({ archived: "true", projectId: first.id }), [archived]);
		assert.deepEqual(sessions.list({ archived: "true", projectId: "another-project" }), []);
		assert.equal(sessions.list({ archived: "all" }).length, 3);
		await assert.rejects(sessions.send(id, "Continue"), Conflict);
		assert.equal(await readFile(join(home, "sessions", id, "durable", "history"), "utf8"), "retained transcript");
		assert.equal(await readFile(join(original.cwd, "work.txt"), "utf8"), "retained changes");

		const reopened = await manager();
		assert.deepEqual(reopened.get(id), archived);
		assert.deepEqual(reopened.list({ archived: "true" }), [archived]);
		assert.deepEqual(await reopened.restore(id), original);
		assert.deepEqual(await reopened.restore(id), original);
		assert.equal(reopened.list().length, 3);
		assert.deepEqual(reopened.list({ archived: "true" }), []);
		const again = await manager();
		assert.deepEqual(again.get(id), original);
		await assert.rejects(sessions.archive(randomUUID()), NotFound);
		await assert.rejects(sessions.restore(randomUUID()), NotFound);
	} finally {
		await cleanup();
	}
});

test("pins persist, sort first, broadcast once and survive manual archive and restore", async () => {
	const { sessions, ids, first, manager, cleanup } = await fixture();
	const id = ids[0]!;
	try {
		const original = sessions.get(id)!;
		const changes: SessionSummary[] = [];
		sessions.onChange((summary) => changes.push(summary));
		assert.equal(original.pinned, undefined, "legacy metadata is unpinned");
		const pinned = await sessions.setPinned(id, true);
		assert.deepEqual(pinned, { ...original, pinned: true });
		assert.deepEqual(await sessions.setPinned(id, true), pinned);
		assert.equal(changes.length, 1);
		assert.equal(sessions.list()[0]?.id, id);
		assert.deepEqual(sessions.list({ projectId: first.id }), [pinned]);
		assert.deepEqual((await manager()).get(id), pinned);
		assert.equal((await sessions.archive(id)).pinned, true, "manual archive remains available");
		assert.deepEqual(await sessions.restore(id), pinned);
		assert.deepEqual(await sessions.setPinned(id, false), original, "pinning never changes activity");
		assert.deepEqual((await manager()).get(id), original);
		assert.equal(sessions.list()[0]?.id, ids[2]);
		await assert.rejects(sessions.setPinned(randomUUID(), true), NotFound);
	} finally {
		await cleanup();
	}
});

test("pins prevent inactivity and merged PR automatic archival across restarts until unpinned", async (t) => {
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	const { sessions, ids, manager, cleanup } = await fixture();
	try {
		for (const id of ids.slice(0, 2)) {
			const meta = sessions["metas"].get(id)!;
			meta.updatedAt = now - 8 * 86_400_000;
			if (id === ids[1]) {
				meta.updatedAt = now;
				meta.pullRequest!.state = "merged";
				meta.pullRequest!.mergedAt = now - 2 * 86_400_000;
				meta.pullRequestMergedAt = meta.pullRequest!.mergedAt;
				delete meta.pullRequestError;
			}
			await sessions.setPinned(id, true);
		}
		const reopened = await manager();
		await reopened["archiveInactiveSessions"]();
		for (const id of ids.slice(0, 2)) assert.equal(reopened.get(id)?.archivedAt, undefined);
		for (const id of ids.slice(0, 2)) await reopened.setPinned(id, false);
		await reopened["archiveInactiveSessions"]();
		for (const id of ids.slice(0, 2)) assert.equal(reopened.get(id)?.archivedAt, now);
		assert.equal(
			reopened["metas"].get(ids[1]!)!.autoArchivedPullRequest,
			reopened.get(ids[1]!)!.pullRequest!.url,
			"merge-based archiving resumes too",
		);
	} finally {
		await cleanup();
	}
});

for (const release of ["done", "archived", "role", "leave"] as const) {
	test(`promotion removes old merge ownership across ${release}`, async () => {
		const { sessions, projects, first, ids, cleanup } = await fixture();
		const store = new MissionStore(":memory:");
		new MissionService(store, sessions, projects);
		try {
			const id = ids[0]!;
			const mission = store.create({ projectId: first.id, title: "Shared work" });
			store.join(id, mission.id);
			store.update(mission.id, { coordinatorSessionId: id });
			const meta = sessions["metas"].get(id)!;
			meta.updatedAt = Date.now() - 8 * 86_400_000;
			meta.pullRequest!.state = "merged";
			meta.pullRequest!.mergedAt = Date.now() - 2 * 86_400_000;
			meta.pullRequestMergedAt = meta.pullRequest!.mergedAt;
			delete meta.pullRequestError;
			await sessions["save"](meta);
			await sessions["coordinatorUnbindings"].get(id);
			await sessions["archiveInactiveSessions"]();
			assert.equal(sessions.get(id)?.activeMissionCoordinator, true);
			assert.equal(sessions.get(id)?.archivedAt, undefined);
			assert.equal(meta.pullRequest, undefined, "promotion removes the old owner association");
			assert.equal(meta.autoArchivedPullRequest, undefined);

			if (release === "role") {
				const next = ids[2]!;
				sessions["metas"].get(next)!.projectId = first.id;
				store.join(next, mission.id);
				store.update(mission.id, { coordinatorSessionId: next });
				assert.equal(sessions.get(next)?.activeMissionCoordinator, true);
			} else if (release === "leave") store.leave(id);
			else store.update(mission.id, { status: release });
			await sessions["roleTransitions"].get(id)?.catch(() => undefined);
			await sessions["archiveTransitions"].get(id)?.promise;
			assert.equal(sessions.get(id)?.activeMissionCoordinator, undefined);
			if (release === "archived")
				assert.ok(sessions.get(id)?.archivedAt, "mission archival archives its coordinator");
			else assert.equal(sessions.get(id)?.archivedAt, undefined, "the unbound PR cannot archive its former owner");
			assert.equal(meta.autoArchivedPullRequest, undefined);
		} finally {
			await cleanup();
			store.close();
		}
	});
}

test("active coordinator exemption survives restart while ordinary mission members still merge-archive", async () => {
	const { sessions, projects, first, ids, manager, cleanup } = await fixture();
	const store = new MissionStore(":memory:");
	new MissionService(store, sessions, projects);
	try {
		const mission = store.create({ projectId: first.id, title: "Shared work" });
		for (const id of ids.slice(0, 2)) {
			const meta = sessions["metas"].get(id)!;
			meta.projectId = first.id;
			store.join(id, mission.id);
			meta.pullRequest!.state = "merged";
			meta.pullRequest!.mergedAt = Date.now() - 2 * 86_400_000;
			delete meta.pullRequestError;
			await sessions["save"](meta);
		}
		store.update(mission.id, { coordinatorSessionId: ids[0]! });
		await sessions.shutdown();
		const reopened = await manager(sessions["missions"]!);
		await reopened["archiveInactiveSessions"]();
		assert.equal(reopened.get(ids[0]!)?.activeMissionCoordinator, true);
		assert.equal(reopened.get(ids[0]!)?.archivedAt, undefined);
		assert.equal(reopened.get(ids[1]!)?.activeMissionCoordinator, undefined);
		assert.ok(reopened.get(ids[1]!)?.archivedAt);
	} finally {
		await cleanup();
		store.close();
	}
});

test("queued merge archives recheck a promotion to active coordinator", async () => {
	const { sessions, projects, first, ids, cleanup } = await fixture();
	const store = new MissionStore(":memory:");
	new MissionService(store, sessions, projects);
	try {
		const id = ids[0]!;
		const mission = store.create({ projectId: first.id, title: "Shared work" });
		store.join(id, mission.id);
		const meta = sessions["metas"].get(id)!;
		meta.pullRequest!.state = "merged";
		meta.pullRequest!.mergedAt = Date.now() - 2 * 86_400_000;
		delete meta.pullRequestError;
		const pending = sessions["archiveMergedPullRequest"](meta);
		store.update(mission.id, { coordinatorSessionId: id });
		await pending;
		assert.equal(sessions.get(id)?.archivedAt, undefined);
		assert.equal(sessions.get(id)?.activeMissionCoordinator, true);
		assert.equal(meta.autoArchivedPullRequest, undefined);
		assert.ok((await sessions.archive(id)).archivedAt, "manual archive remains available");
	} finally {
		await cleanup();
		store.close();
	}
});

test("queued automatic archives recheck pins and interleaved lifecycle snapshots preserve committed pins", async () => {
	const { home, sessions, ids, cleanup } = await fixture();
	const id = ids[0]!;
	const meta = sessions["metas"].get(id)!;
	const save = sessions["save"].bind(sessions);
	const gate = deferred();
	const entered = deferred();
	const changes: SessionSummary[] = [];
	sessions.onChange((summary) => changes.push(summary));
	try {
		sessions["save"] = async (current, archive, pin) => {
			if (pin) {
				entered.resolve();
				await gate.promise;
			}
			await save(current, archive, pin);
		};
		const pin = sessions.setPinned(id, true);
		await entered.promise;
		assert.equal(sessions.get(id)?.pinned, undefined, "uncommitted pin is not published");
		const archive = sessions["setArchived"](id, true, undefined, Date.now());
		gate.resolve();
		await pin;
		await archive;
		assert.equal(sessions.get(id)?.archivedAt, undefined);
		assert.equal(changes.length, 1);
		// Queue a lifecycle snapshot behind an unpin; it captures the old pin but must persist the new one.
		const writeGate = deferred();
		const writing = deferred();
		sessions["saving"].set(id, writeGate.promise);
		sessions["save"] = (current, archive, pin) => {
			const result = save(current, archive, pin);
			if (pin) writing.resolve();
			return result;
		};
		const unpin = sessions.setPinned(id, false);
		await writing.promise;
		const lifecycle = save(meta);
		writeGate.resolve();
		await Promise.all([unpin, lifecycle]);
		const persisted = JSON.parse(await readFile(join(home, "sessions", id, "meta.json"), "utf8"));
		assert.equal(persisted.pinned, undefined);
		assert.equal(sessions.get(id)?.pinned, undefined);
	} finally {
		gate.resolve();
		await cleanup();
	}
});

test("manual archive does not share an automatic archive skipped by a queued pin", async () => {
	const { sessions, ids, cleanup } = await fixture();
	const id = ids[0]!;
	const gate = deferred();
	const entered = deferred();
	const save = sessions["save"].bind(sessions);
	try {
		sessions["save"] = async (meta, archive, pin) => {
			if (pin) {
				entered.resolve();
				await gate.promise;
			}
			await save(meta, archive, pin);
		};
		const pin = sessions.setPinned(id, true);
		await entered.promise;
		const automatic = sessions["setArchived"](id, true, undefined, Date.now());
		const manual = sessions.archive(id);
		gate.resolve();
		await pin;
		assert.equal((await automatic).archivedAt, undefined);
		assert.ok((await manual).archivedAt);
		assert.equal(sessions.get(id)?.pinned, true);
	} finally {
		gate.resolve();
		await cleanup();
	}
});

test("failed pin writes publish nothing, retries persist and opposite pin requests execute in order", async () => {
	const { sessions, ids, manager, cleanup } = await fixture();
	const id = ids[0]!;
	const save = sessions["save"].bind(sessions);
	const changes: SessionSummary[] = [];
	sessions.onChange((summary) => changes.push(summary));
	try {
		sessions["save"] = async (meta, archive, pin) => {
			if (pin) throw new Error("disk full");
			await save(meta, archive, pin);
		};
		await assert.rejects(sessions.setPinned(id, true), /disk full/);
		assert.equal(sessions.get(id)?.pinned, undefined);
		assert.equal(changes.length, 0);
		sessions["save"] = save;
		const pin = sessions.setPinned(id, true);
		const unpin = sessions.setPinned(id, false);
		const repin = sessions.setPinned(id, true);
		assert.equal((await pin).pinned, true);
		assert.equal((await unpin).pinned, undefined);
		assert.equal((await repin).pinned, true);
		assert.equal((await manager()).get(id)?.pinned, true);
	} finally {
		await cleanup();
	}
});

test("age sweep archives at one week since activity, retains files and grants a durable week on restore", async (t) => {
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	const { home, sessions, ids, manager, cleanup } = await fixture();
	const week = 7 * 86_400_000;
	const [old, recent, direct] = ids as [string, string, string];
	const metas = sessions["metas"];
	metas.get(old)!.updatedAt = now - week;
	metas.get(recent)!.updatedAt = now - week + 1;
	metas.get(direct)!.updatedAt = now - week - 1;
	delete metas.get(direct)!.workspace;
	const before = sessions.get(old)!;
	try {
		await sessions["archiveInactiveSessions"]();
		assert.equal(sessions.get(old)?.archivedAt, now, "exact one-week boundary is eligible");
		assert.equal(sessions.get(recent)?.archivedAt, undefined);
		assert.equal(sessions.get(direct)?.archivedAt, now, "direct chats do not require GitHub");
		assert.deepEqual(sessions.get(old), { ...before, archivedAt: now });
		assert.equal(await readFile(join(home, "sessions", old, "durable", "history"), "utf8"), "retained transcript");
		assert.equal(await readFile(join(before.cwd, "work.txt"), "utf8"), "retained changes");
		await sessions.restore(old);
		await sessions["archiveInactiveSessions"]();
		assert.deepEqual(sessions.get(old), before);
		const reopened = await manager();
		await reopened["archiveInactiveSessions"]();
		assert.equal(reopened.get(old)?.archivedAt, undefined, "restoration grace survives restarts");
		t.mock.method(Date, "now", () => now + week);
		await reopened["archiveInactiveSessions"]();
		assert.equal(reopened.get(old)?.archivedAt, now + week);
	} finally {
		await cleanup();
	}
});

test("age sweep skips busy chats, retries settled chats and rechecks new activity before archiving", async (t) => {
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	const { sessions, ids, cleanup } = await fixture();
	const id = ids[0]!;
	const meta = sessions["metas"].get(id)!;
	const worker = new FakeWorker();
	sessions["workers"].set(id, worker);
	const busyStates: [() => void, () => void][] = [
		[() => (meta.working = true), () => (meta.working = false)],
		[() => (meta.initializing = true), () => delete meta.initializing],
		[() => (meta.preparing = { source: meta.cwd }), () => delete meta.preparing],
		[
			() => (meta.pending = [{ type: "input", requestId: "queued", content: "Hi", mode: "followUp" }]),
			() => delete meta.pending,
		],
		[() => (worker.state = "starting"), () => (worker.state = "idle")],
		[() => (worker.state = "working"), () => (worker.state = "idle")],
		[() => (worker.busy = true), () => (worker.busy = false)],
		[() => sessions["sending"].set(id, 1), () => sessions["sending"].delete(id)],
		[() => sessions["changingModels"].set(id, Promise.resolve()), () => sessions["changingModels"].delete(id)],
	];
	try {
		for (const [start, stop] of busyStates) {
			start();
			await sessions["archiveInactiveSessions"]();
			assert.equal(meta.archivedAt, undefined);
			stop();
		}
		const sweep = sessions["archiveInactiveSessions"]();
		meta.updatedAt = now;
		await sweep;
		assert.equal(meta.archivedAt, undefined, "activity arriving after selection cancels automatic archiving");
		meta.updatedAt = now - 7 * 86_400_000;
		await sessions["archiveInactiveSessions"]();
		assert.equal(meta.archivedAt, now);
	} finally {
		await cleanup();
	}
});

test("daemon sweeps every minute without clients, retries failed writes and stops on shutdown", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { sessions, ids, cleanup } = await fixture();
	const id = ids[0]!;
	const save = sessions["save"].bind(sessions);
	let fail = true;
	sessions["save"] = async (meta, archive) => {
		if (archive && fail) throw new Error("disk full");
		await save(meta, archive);
	};
	try {
		assert.equal(sessions.get(id)?.archivedAt, undefined);
		t.mock.timers.tick(60_000);
		await sessions["archiveSweep"];
		assert.equal(sessions.get(id)?.archivedAt, undefined);
		fail = false;
		t.mock.timers.tick(60_000);
		await sessions["archiveSweep"];
		assert.ok(sessions.get(id)?.archivedAt);
		assert.equal(sessions["workers"].size, 0);
		await sessions.restore(id);
		await sessions.shutdown();
		const sweep = t.mock.method(
			sessions as unknown as { archiveInactiveSessions(): Promise<void> },
			"archiveInactiveSessions",
		);
		t.mock.timers.tick(60_000);
		assert.equal(sweep.mock.calls.length, 0);
	} finally {
		sessions["save"] = save;
		await cleanup();
	}
});

test("running, starting and in-flight input sessions cannot be archived", async () => {
	const { sessions, ids, cleanup } = await fixture();
	const id = ids[0]!;
	// Fake supervision state avoids launching an actual agent or making model calls.
	const internals = sessions as unknown as {
		workers: Map<string, SessionWorker>;
		metas: Map<string, Meta>;
		sending: Map<string, number>;
	};
	const worker = new FakeWorker();
	try {
		for (const state of ["starting", "working"] as const) {
			worker.state = state;
			internals.workers.set(id, worker);
			await assert.rejects(sessions.archive(id), Conflict);
			assert.equal(sessions.get(id)?.archivedAt, undefined);
		}
		internals.workers.delete(id);
		internals.metas.get(id)!.working = true;
		await assert.rejects(sessions.archive(id), Conflict);
		internals.metas.get(id)!.working = false;
		const meta = internals.metas.get(id)!;
		meta.initializing = true;
		await assert.rejects(sessions.archive(id), Conflict);
		delete meta.initializing;
		meta.preparing = { source: meta.cwd };
		await assert.rejects(sessions.archive(id), Conflict);
		delete meta.preparing;
		meta.pending = [{ type: "input", requestId: "queued", content: "Queued", mode: "followUp" }];
		await assert.rejects(sessions.archive(id), Conflict);
		meta.pending = [];
		worker.state = "idle";
		worker.busy = true;
		internals.workers.set(id, worker);
		await assert.rejects(sessions.archive(id), Conflict);
		worker.busy = false;
		internals.sending.set(id, 1);
		await assert.rejects(sessions.archive(id), Conflict);
		internals.sending.delete(id);
		assert.ok((await sessions.archive(id)).archivedAt);
	} finally {
		await cleanup();
	}
});

for (const preparing of [false, true]) {
	test(`terminal ${preparing ? "preparation" : "worker startup"} failure can archive with its outbox intact across restart`, async () => {
		const { home, sessions, ids, manager, cleanup } = await fixture();
		const id = ids[0]!;
		try {
			const meta = sessions["metas"].get(id)!;
			meta.failure = "Session startup: extension dependency missing";
			meta.initializing = true;
			meta.pending = [{ type: "input", requestId: "original-request", content: "Original input", mode: "followUp" }];
			meta.outcome = "failed";
			meta.outcomeReason = meta.failure;
			if (preparing) meta.preparing = { source: home };
			await sessions["save"](meta);
			await sessions.shutdown();
			const failed = await manager();
			const before = failed.get(id)!;
			const path = join(home, "sessions", id, "meta.json");
			const stored = JSON.parse(await readFile(path, "utf8"));
			const archived = await failed.archive(id);
			assert.ok(archived.archivedAt);
			assert.equal(archived.error, before.error);
			assert.equal(archived.canRetryStartup, undefined);
			assert.equal(failed["workers"].size, 0);
			assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...stored, archivedAt: archived.archivedAt });
			await assert.rejects(failed.retryStartup(id), /Restore the archived/);
			const reopened = await manager();
			assert.deepEqual(reopened.get(id), archived);
			assert.deepEqual(await reopened.restore(id), before);
			assert.equal(reopened["workers"].size, 0);
			const restored = JSON.parse(await readFile(path, "utf8"));
			assert.deepEqual(restored.pending, stored.pending);
			assert.equal(restored.failure, stored.failure);
			assert.equal(restored.initializing, true);
			assert.deepEqual(restored.preparing, stored.preparing);
			assert.equal(await readFile(join(home, "sessions", id, "durable", "history"), "utf8"), "retained transcript");
			assert.equal(await readFile(join(meta.cwd, "work.txt"), "utf8"), "retained changes");
		} finally {
			await cleanup();
		}
	});
}

test("terminal failure does not bypass live activity or startup/recovery transitions when archiving", async () => {
	const { sessions, ids, cleanup } = await fixture();
	const id = ids[0]!;
	try {
		const meta = sessions["metas"].get(id)!;
		meta.failure = "Session startup: extension dependency missing";
		meta.initializing = true;
		meta.pending = [{ type: "input", requestId: "original-request", content: "Original input", mode: "followUp" }];
		const worker = new FakeWorker();
		sessions["workers"].set(id, worker);
		for (const state of ["starting", "working"] as const) {
			worker.state = state;
			await assert.rejects(sessions.archive(id), Conflict);
		}
		worker.state = "failed";
		worker.busy = true;
		await assert.rejects(sessions.archive(id), Conflict);
		worker.busy = false;
		meta.working = true;
		await assert.rejects(sessions.archive(id), Conflict);
		meta.working = false;
		sessions["starting"].set(id, Promise.resolve(new Map()));
		await assert.rejects(sessions.archive(id), Conflict);
		sessions["starting"].delete(id);
		sessions["changingModels"].set(id, Promise.resolve());
		await assert.rejects(sessions.archive(id), Conflict);
		sessions["changingModels"].delete(id);
		sessions["sending"].set(id, 1);
		await assert.rejects(sessions.archive(id), Conflict);
		sessions["sending"].delete(id);
		assert.equal(sessions.get(id)?.archivedAt, undefined);
		assert.ok((await sessions.archive(id)).archivedAt);
		assert.deepEqual(
			meta.pending.map((command) => command.requestId),
			["original-request"],
		);
	} finally {
		await cleanup();
	}
});

test("restore does not start an agent, and permits the next input admission", async () => {
	const { sessions, ids, cleanup } = await fixture();
	const id = ids[0]!;
	const worker = new FakeWorker();
	try {
		await sessions.archive(id);
		await sessions.restore(id);
		assert.equal(sessions["workers"].size, 0);
		sessions["workers"].set(id, worker);
		const admission = sessions.send(id, "Continue", "followUp", "input-id");
		await assert.rejects(sessions.archive(id), Conflict);
		worker.gate.resolve();
		await admission;
		assert.deepEqual(worker.commands, [
			{ type: "input", requestId: "input-id", content: "Continue", mode: "followUp" },
		]);
		assert.deepEqual(sessions["metas"].get(id)!.pending, []);
		assert.ok(sessions.get(id)!.updatedAt > 200);
	} finally {
		worker.gate.resolve();
		await cleanup();
	}
});

test("guarded queued edit forwards its capture and reserves admission through ACK", async (t) => {
	const { sessions, ids, cleanup } = await fixture();
	const id = ids[0]!;
	const worker = new FakeWorker();
	const ack = deferred();
	const requested = deferred();
	t.mock.method(worker, "request", async (command: Command) => {
		worker.commands.push(command);
		requested.resolve();
		await ack.promise;
	});
	try {
		sessions["workers"].set(id, worker);
		const edit = sessions.editQueuedMessage(id, 42, "Literal captured text", undefined, "a".repeat(64));
		worker.gate.resolve();
		await requested.promise;
		assert.equal(sessions["sending"].get(id), 1);
		await assert.rejects(sessions.archive(id), Conflict);
		assert.deepEqual(
			worker.commands.map(({ requestId: _, ...command }) => command),
			[
				{
					type: "editQueuedMessage",
					submissionId: 42,
					content: "Literal captured text",
					guardToken: "a".repeat(64),
				},
			],
		);
		ack.resolve();
		await edit;
		assert.equal(sessions["sending"].has(id), false);
		await sessions.removeQueuedMessage(id, 42, "b".repeat(64));
		const removal = worker.commands[1]!;
		assert.equal(removal.type, "removeQueuedMessage");
		if (removal.type === "removeQueuedMessage") assert.equal(removal.guardToken, "b".repeat(64));
	} finally {
		ack.resolve();
		worker.gate.resolve();
		await cleanup();
	}
});

test("queued removal respects archive transitions and holds archive/admission until acknowledged", async (t) => {
	const { sessions, ids, cleanup } = await fixture();
	const id = ids[0]!;
	const worker = new FakeWorker();
	const ack = deferred();
	const requested = deferred();
	t.mock.method(worker, "request", async (command: Command) => {
		worker.commands.push(command);
		requested.resolve();
		await ack.promise;
	});
	try {
		const before = sessions.get(id)!;
		for (const invalid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
			await assert.rejects(sessions.removeQueuedMessage(id, invalid), /Invalid queued message ID/);
		assert.deepEqual(sessions.get(id), before);
		assert.equal(sessions["workers"].size, 0);
		const archive = sessions.archive(id);
		const rejected = sessions.removeQueuedMessage(id, 42);
		await archive;
		await assert.rejects(rejected, Conflict);
		assert.equal(sessions["workers"].size, 0);
		const restoring = sessions.restore(id);
		sessions["workers"].set(id, worker);
		const removal = sessions.removeQueuedMessage(id, 42);
		await restoring;
		assert.deepEqual(sessions.prepareUpdate(), { ready: false });
		await assert.rejects(sessions.archive(id), Conflict);
		worker.gate.resolve();
		await requested.promise;
		assert.equal(worker.commands.length, 1);
		assert.equal(worker.commands[0]?.type, "removeQueuedMessage");
		assert.equal(worker.commands[0]?.submissionId, 42);
		assert.equal(sessions.get(id)?.updatedAt, before.updatedAt, "metadata waits for the durable acknowledgement");
		await assert.rejects(sessions.archive(id), Conflict);
		ack.resolve();
		await removal;
		assert.ok(sessions.get(id)!.updatedAt > before.updatedAt);
		assert.equal(sessions.get(id)?.outcome, before.outcome);
		assert.equal(sessions.get(id)?.outcomeAt, before.outcomeAt);
		const unchanged = sessions.get(id);
		t.mock.method(worker, "request", async () => {
			throw new Error("Message is no longer queued");
		});
		await assert.rejects(sessions.removeQueuedMessage(id, 42), /no longer queued/);
		assert.deepEqual(sessions.get(id), unchanged);
		assert.ok((await sessions.archive(id)).archivedAt, "failed removals release the archive guard");
	} finally {
		ack.resolve();
		worker.gate.resolve();
		await cleanup();
	}
});

test("failed archive transitions roll back and concurrent retries wait for persistence", async () => {
	const { sessions, ids, manager, cleanup } = await fixture();
	const id = ids[0]!;
	const internals = sessions as unknown as { save(meta: unknown): Promise<void> };
	const save = internals.save;
	const changes: SessionSummary[] = [];
	const unwatch = sessions.onChange((session) => changes.push(session));
	try {
		for (const archived of [true, false]) {
			const before = sessions.get(id)!;
			let started!: () => void;
			const saving = new Promise<void>((resolve) => {
				started = resolve;
			});
			let fail!: (error: Error) => void;
			const deferred = new Promise<void>((_resolve, reject) => {
				fail = reject;
			});
			internals.save = async () => {
				started();
				await deferred;
			};
			const transition = () => (archived ? sessions.archive(id) : sessions.restore(id));
			const first = transition();
			const duplicate = transition();
			let finished = false;
			void duplicate.then(
				() => {
					finished = true;
				},
				() => {
					finished = true;
				},
			);
			const failures = Promise.all([assert.rejects(first, /Disk full/), assert.rejects(duplicate, /Disk full/)]);
			await saving;
			assert.equal(finished, false, "duplicate requests cannot succeed before saving finishes");
			fail(new Error("Disk full"));
			await failures;
			assert.deepEqual(sessions.get(id), before);
			assert.equal(changes.length, archived ? 0 : 1, "failed transitions never broadcast success");
			const reloaded = await manager();
			assert.deepEqual(reloaded.get(id), before);
			internals.save = save;
			const retried = await transition();
			assert.equal(retried.archivedAt !== undefined, archived);
		}
	} finally {
		internals.save = save;
		unwatch();
		await cleanup();
	}
});

test("concurrent archive and restore transitions persist in request order", async () => {
	const { sessions, ids, manager, cleanup } = await fixture();
	const id = ids[0]!;
	try {
		const archive = sessions.archive(id);
		const restore = sessions.restore(id);
		assert.ok((await archive).archivedAt !== undefined);
		assert.equal((await restore).archivedAt, undefined);
		const reopened = await manager();
		assert.equal(reopened.get(id)?.archivedAt, undefined);
	} finally {
		await cleanup();
	}
});

test("interleaved lifecycle saves and notifications keep the committed archive state", async () => {
	const { sessions, ids, manager, cleanup } = await fixture();
	const id = ids[0]!;
	const internals = sessions as unknown as {
		metas: Map<string, Meta>;
		save(meta: Meta, archive?: { timestamp?: number }): Promise<void>;
		emit(meta: Meta): void;
	};
	const save = internals.save;
	const changes: SessionSummary[] = [];
	sessions.onChange((session) => changes.push(session));
	try {
		for (const archived of [true, false]) {
			const oldTimestamp = sessions.get(id)!.archivedAt;
			internals.save = async (meta, archive) => {
				assert.ok(archive, "the archive timestamp is staged separately from lifecycle metadata");
				assert.equal(meta.archivedAt, oldTimestamp);
				// A lifecycle write queued before the archive write commits fresh activity, not the proposed timestamp.
				meta.updatedAt += 1;
				await save.call(sessions, meta);
				internals.emit(meta);
				throw new Error("Disk full");
			};
			await assert.rejects(archived ? sessions.archive(id) : sessions.restore(id), /Disk full/);
			assert.equal(sessions.get(id)!.archivedAt, oldTimestamp);
			assert.equal(changes.at(-1)!.archivedAt, oldTimestamp);
			const reopened = await manager();
			assert.deepEqual(reopened.get(id), sessions.get(id));
			internals.save = save;
			await (archived ? sessions.archive(id) : sessions.restore(id));
		}
	} finally {
		internals.save = save;
		await cleanup();
	}
});

for (const archived of [true, false]) {
	test(`queued lifecycle snapshots stay immutable across ${archived ? "archive" : "restore"} persistence`, async () => {
		const { home, sessions, ids, manager, cleanup } = await fixture();
		const id = ids[0]!;
		const meta = sessions["metas"].get(id)!;
		const save = sessions["save"];
		const beforeGate = deferred();
		const archiveGate = deferred();
		const afterGate = deferred();
		const staged = deferred();
		const stored = async (): Promise<Meta> =>
			JSON.parse(await readFile(join(home, "sessions", id, "meta.json"), "utf8"));
		const withArchive = (snapshot: Meta, timestamp: number | undefined): Meta => {
			const result = structuredClone(snapshot);
			if (timestamp === undefined) delete result.archivedAt;
			else result.archivedAt = timestamp;
			if (meta.restoredAt !== undefined) result.restoredAt = meta.restoredAt;
			return result;
		};
		try {
			if (!archived) await sessions.archive(id);
			const oldTimestamp = meta.archivedAt;
			// Hold three writes independently so each persisted snapshot can be inspected.
			sessions["saving"].set(id, beforeGate.promise);
			const beforeSnapshot = structuredClone(meta);
			const beforeWrite = save.call(sessions, meta);
			sessions["saving"].set(
				id,
				beforeWrite.then(() => archiveGate.promise),
			);
			applyActivity(meta, false, { outcome: "done", outcomeAt: 400 });
			meta.updatedAt = 400;
			const archiveSnapshot = structuredClone(meta);
			sessions["save"] = (current, archive) => {
				assert.ok(archive, "the transition stages only its archive timestamp");
				const writing = save.call(sessions, current, archive);
				sessions["saving"].set(
					id,
					writing.then(() => afterGate.promise),
				);
				staged.resolve();
				return writing;
			};
			const transition = archived ? sessions.archive(id) : sessions.restore(id);
			await staged.promise;
			sessions["save"] = save;
			assert.equal(meta.archivedAt, oldTimestamp, "staging does not publish an uncommitted archive timestamp");
			applyActivity(meta, true);
			meta.updatedAt = 500;
			meta.pullRequest!.title = "Activity snapshot PR";
			const afterSnapshot = structuredClone(meta);
			const afterWrite = save.call(sessions, meta);
			// Mutate completion and nested PR data again before any queued write executes.
			applyActivity(meta, false, { outcome: "done", outcomeAt: 600, outcomeReason: "New question" });
			meta.updatedAt = 600;
			meta.pullRequest!.title = "Later PR metadata";

			beforeGate.resolve();
			await beforeWrite;
			assert.deepEqual(await stored(), beforeSnapshot, "an earlier lifecycle save retains its completion version");
			archiveGate.resolve();
			const committed = await transition;
			assert.equal(committed.archivedAt !== undefined, archived);
			assert.deepEqual(
				await stored(),
				withArchive(archiveSnapshot, committed.archivedAt),
				"archive persistence uses the captured lifecycle, not later live completion fields",
			);
			afterGate.resolve();
			await afterWrite;
			assert.deepEqual(
				await stored(),
				withArchive(afterSnapshot, committed.archivedAt),
				"a queued activity snapshot uses the committed archive state, never its stale archivedAt",
			);
			assert.equal((await stored()).outcome, undefined, "working snapshots cannot resurrect a completion");
			await save.call(sessions, meta);
			const reopened = await manager();
			assert.deepEqual(reopened.get(id), sessions.get(id));
			assert.equal(reopened.get(id)!.outcomeAt, 600);
			assert.equal(reopened.get(id)!.archivedAt, committed.archivedAt);
		} finally {
			sessions["save"] = save;
			beforeGate.resolve();
			archiveGate.resolve();
			afterGate.resolve();
			await cleanup();
		}
	});
}

test("HTTP archive browsing narrows by mission and project, including inactive missions", async () => {
	const { home, projects, first, second, sessions, ids, cleanup } = await fixture();
	const store = new MissionStore(":memory:");
	const missions = new MissionService(store, sessions, projects);
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(join(home, "agent")),
		terminals,
		{ service: missions, store },
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const archived = async (missionId: string, projectId?: string) => {
		const query = new URLSearchParams({ archived: "true", missionId });
		if (projectId) query.set("projectId", projectId);
		const response = await fetch(`${base}/api/sessions?${query}`);
		assert.equal(response.status, 200);
		return ((await response.json()) as SessionSummary[]).map((session) => session.id).sort();
	};
	try {
		const target = store.create({ projectId: first.id, title: "Target" });
		const unrelated = store.create({ projectId: second.id, title: "Unrelated" });
		const [active, other, member] = ids as [string, string, string];
		sessions["metas"].get(member)!.projectId = first.id;
		await sessions["save"](sessions["metas"].get(member)!);
		store.join(active, target.id);
		store.join(member, target.id);
		store.join(other, unrelated.id);
		await sessions.archive(member);
		await sessions.archive(other);
		assert.deepEqual(await archived(target.id), [member]);
		assert.deepEqual(await archived(target.id, first.id), [member]);
		assert.deepEqual(await archived(target.id, second.id), []);
		assert.deepEqual(await archived(unrelated.id), [other]);
		assert.deepEqual(await archived(randomUUID()), []);
		await sessions.archive(active);
		for (const status of ["active", "done", "archived"] as const) {
			store.update(target.id, { status });
			assert.deepEqual(await archived(target.id), [active, member].sort());
		}
		await sessions.restore(member);
		assert.deepEqual(await archived(target.id), [active]);
		store.leave(active);
		assert.deepEqual(await archived(target.id), []);
		assert.equal(sessions.list({ archived: "true" }).length, 2, "detached chats stay in the global archive");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		terminals.shutdown();
		await cleanup();
		store.close();
	}
});

test("HTTP archive browsing works globally and per project; WebSocket sync includes archives", async () => {
	const { home, projects, first, second, sessions, ids, cleanup } = await fixture();
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(join(home, "agent")),
		terminals,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const request = (path: string, method = "GET") => fetch(`${base}/api/sessions${path}`, { method });
	let ws: WebSocket | undefined;
	try {
		const id = ids[0]!;
		const pinResponse = await request(`/${id}/pin`, "POST");
		assert.equal(pinResponse.status, 200);
		assert.equal(((await pinResponse.json()) as SessionSummary).pinned, true);
		assert.equal((await request(`/${randomUUID()}/pin`, "POST")).status, 404);
		assert.equal((await request(`/${id}/archive`, "POST")).status, 200);
		await sessions.archive(ids[1]!);
		await sessions.archive(ids[2]!);
		assert.deepEqual(await (await request("")).json(), []);
		const global = (await (await request("?archived=true")).json()) as SessionSummary[];
		assert.equal(global.length, 3);
		const perProject = (await (await request(`?archived=true&projectId=${first.id}`)).json()) as SessionSummary[];
		assert.deepEqual(
			perProject.map((session) => session.id),
			[id],
		);
		assert.equal(((await (await request(`?archived=all&projectId=${second.id}`)).json()) as unknown[]).length, 1);
		assert.equal((await request("?archived=invalid")).status, 400);
		assert.equal((await request(`/${randomUUID()}/archive`, "POST")).status, 404);
		assert.equal((await request(`/${id}`)).status, 200);
		const blockedInput = await fetch(`${base}/api/sessions/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "Continue" }),
		});
		assert.equal(blockedInput.status, 409);

		ws = new WebSocket(`${base.replace("http:", "ws:")}/api/ws`);
		const initial = await new Promise<Extract<ServerMessage, { type: "sessions" }>>((resolve, reject) => {
			ws!.on("error", reject);
			ws!.on("message", (raw) => {
				const message = JSON.parse(String(raw)) as ServerMessage;
				if (message.type === "sessions") resolve(message);
			});
		});
		assert.equal(initial.sessions.length, 3);
		assert.ok(initial.sessions.every((session) => session.archivedAt !== undefined));
		assert.equal(initial.sessions.find((session) => session.id === id)?.pinned, true);
		const nextSessionUpdate = (matches: (session: SessionSummary) => boolean) =>
			new Promise<Extract<ServerMessage, { type: "session" }>>((resolve) => {
				const onMessage = (raw: unknown) => {
					const message = JSON.parse(String(raw)) as ServerMessage;
					if (message.type !== "session" || !matches(message.session)) return;
					ws!.off("message", onMessage);
					resolve(message);
				};
				ws!.on("message", onMessage);
			});
		const unpinUpdate = nextSessionUpdate((session) => session.id === id && session.pinned === undefined);
		const unpinned = await request(`/${id}/unpin`, "POST");
		assert.equal(unpinned.status, 200);
		assert.equal(((await unpinned.json()) as SessionSummary).pinned, undefined);
		const pinMessage = await unpinUpdate;
		assert.equal(pinMessage.session.id, id);
		assert.equal(pinMessage.session.pinned, undefined);
		const update = nextSessionUpdate((session) => session.id === id && session.archivedAt === undefined);
		const restored = await request(`/${id}/restore`, "POST");
		assert.equal(restored.status, 200);
		const message = await update;
		assert.equal(message.type, "session");
		assert.equal(message.session.id, id);
		assert.equal(message.session.archivedAt, undefined);
		assert.equal(((await (await request("")).json()) as unknown[]).length, 1);
	} finally {
		if (ws) {
			const closed = once(ws, "close");
			ws.close();
			await closed;
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
		terminals.shutdown();
		await cleanup();
	}
});

test("unpublished work keeps merged and inactive chats active until it is published", async (t) => {
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	let dirty = true;
	let checks = 0;
	const { sessions, ids, cleanup } = await fixture((args) => {
		if (args[0] === "rev-parse") return "true";
		if (args[0] === "status") {
			checks++;
			return dirty ? "?? scratch.txt\0" : "";
		}
		if (args[0] === "for-each-ref" || args[0] === "rev-list") return "";
		return undefined;
	});
	try {
		const [merged, inactive] = ids as [string, string];
		const mergedMeta = sessions["metas"].get(merged)!;
		mergedMeta.pullRequest!.state = "merged";
		mergedMeta.pullRequest!.mergedAt = now - 2 * 86_400_000;
		mergedMeta.pullRequestMergedAt = mergedMeta.pullRequest!.mergedAt;
		delete mergedMeta.pullRequestError;
		sessions["metas"].get(inactive)!.updatedAt = now - 8 * 86_400_000;

		await sessions["archiveInactiveSessions"]();
		for (const id of [merged, inactive]) {
			assert.equal(sessions.get(id)?.archivedAt, undefined);
			assert.equal(sessions.get(id)?.unpublishedWork, true);
		}
		const counted = checks;
		await sessions["archiveInactiveSessions"]();
		assert.equal(checks, counted, "blocked chats are not rechecked every sweep");

		dirty = false;
		t.mock.method(Date, "now", () => now + 31 * 60_000);
		await sessions["archiveInactiveSessions"]();
		for (const id of [merged, inactive]) {
			assert.ok(sessions.get(id)?.archivedAt, "published work archives normally");
			assert.equal(sessions.get(id)?.unpublishedWork, undefined);
		}
	} finally {
		await cleanup();
	}
});

test("a finished turn without a PR refreshes and broadcasts cached code changes", async () => {
	let dirty = true;
	const { sessions, ids, cleanup } = await fixture((args) => {
		if (args[0] === "rev-parse") return "true";
		if (args[0] === "status") return dirty ? " M work.txt\0" : "";
		if (args[0] === "for-each-ref" || args[0] === "rev-list") return "";
		return undefined;
	});
	try {
		const id = ids[0]!;
		const meta = sessions["metas"].get(id)!;
		delete meta.pullRequest;
		delete meta.previousPullRequests;
		const worker = new FakeWorker();
		sessions["workers"].set(id, worker);
		const updates: SessionSummary[] = [];
		sessions.onChange((session) => updates.push(session));
		for (const expected of [true, undefined]) {
			meta.working = true;
			sessions["onPacket"](meta, worker, { type: "working", working: false });
			await sessions["unpublishedChecks"].get(id)?.promise;
			assert.equal(sessions.get(id)?.unpublishedWork, expected);
			assert.equal(updates.at(-1)?.unpublishedWork, expected);
			const persisted = JSON.parse(await readFile(join(sessions["dir"](id), "meta.json"), "utf8")) as Meta;
			assert.equal(persisted.unpublishedWork, expected);
			dirty = false;
		}
	} finally {
		await cleanup();
	}
});

test("settled PRs check unpublished work after a finished turn and keep the last result while working", async () => {
	let dirty = false;
	const { sessions, ids, cleanup } = await fixture((args) => {
		if (args[0] === "rev-parse") return "true";
		if (args[0] === "status") return dirty ? " M work.txt\0" : "";
		if (args[0] === "for-each-ref" || args[0] === "rev-list") return "";
		return undefined;
	});
	try {
		const meta = sessions["metas"].get(ids[0]!)!;
		meta.pullRequest!.state = "merged";
		dirty = true;
		meta.working = true;
		assert.equal(await sessions["unpublishedWork"](meta, 0), false, "working sessions are not snapshotted");
		meta.working = false;
		assert.equal(await sessions["unpublishedWork"](meta, 0), true);
		assert.equal(sessions.get(ids[0]!)?.unpublishedWork, true);
		dirty = false;
		assert.equal(await sessions["unpublishedWork"](meta), true, "fresh results are reused");
		assert.equal(await sessions["unpublishedWork"](meta, 0), false);
		assert.equal(sessions.get(ids[0]!)?.unpublishedWork, undefined);
	} finally {
		await cleanup();
	}
});
test("renames persist, broadcast, keep activity and win over a pending generated title", async () => {
	const { sessions, ids, manager, cleanup } = await fixture();
	const id = ids[0]!;
	try {
		const original = sessions.get(id)!;
		const changes: SessionSummary[] = [];
		sessions.onChange((summary) => changes.push(summary));
		const renamed = await sessions.rename(id, "  Fix\n the   sidebar  ");
		assert.deepEqual(renamed, { ...original, title: "Fix the sidebar" }, "renaming never changes activity");
		assert.equal(changes.length, 1);
		assert.deepEqual(await sessions.rename(id, "Fix the sidebar"), renamed);
		assert.equal(changes.length, 1, "an unchanged title does not broadcast");
		assert.equal((await manager()).get(id)?.title, "Fix the sidebar");
		assert.equal((await sessions.rename(id, "x".repeat(500))).title.length, 200);
		await assert.rejects(sessions.rename(id, "   "), /title is required/);
		await assert.rejects(sessions.rename(randomUUID(), "Other"), NotFound);

		let release!: (title: string) => void;
		const started = deferred();
		sessions["factories"].title = () =>
			new Promise<string>((resolve) => {
				release = resolve;
				started.resolve();
			});
		const meta = sessions["metas"].get(ids[1]!)!;
		meta.titlePending = { cwd: meta.cwd, message: "task" };
		sessions["generateTitle"](meta);
		await started.promise;
		await sessions.rename(ids[1]!, "Chosen");
		release("Generated");
		await Promise.allSettled([...sessions["titleTasks"]]);
		assert.equal(sessions.get(ids[1]!)?.title, "Chosen");
		assert.equal((await manager()).get(ids[1]!)?.title, "Chosen");
	} finally {
		await cleanup();
	}
});

test("passive lifecycle preserves coordinator, members, scratch and mounted work through restart", async (t) => {
	const f = await coordinatorFixture(t);
	const member = f.ids[1]!;
	f.store.join(member, f.mission.id);
	const scratch = join(f.home, "sessions", f.id, "scratch", "keep.txt");
	await mkdir(join(scratch, ".."), { recursive: true });
	await writeFile(scratch, "retained");
	const worker = new FakeWorker();
	f.sessions["workers"].set(f.id, worker);
	f.meta.working = true;
	worker.state = "working";
	f.store.lifecycle(f.mission.id, f.first.id, "active", "archive");
	assert.equal(f.sessions.get(f.id)?.archivedAt, undefined);
	assert.deepEqual(worker.commands, []);
	f.meta.working = false;
	worker.state = "idle";
	f.sessions["emit"](f.meta);
	await f.sessions["archiveInactiveSessions"]();
	assert.equal(f.sessions.get(f.id)?.archivedAt, undefined);
	assert.equal(f.sessions.get(member)?.archivedAt, undefined);
	assert.equal(await readFile(scratch, "utf8"), "retained");
	f.store.lifecycle(f.mission.id, f.first.id, "archived", "reopen");
	assert.equal(f.store.require(f.mission.id).status, "active");
	assert.equal(f.sessions["starting"].size, 0);
	assert.deepEqual(worker.commands, []);
	f.meta.pending = [
		{ type: "input", requestId: "mission-notice:held", content: "held", mode: "followUp", onlyIfIdle: true },
	];
	await f.sessions["save"](f.meta);
	await f.sessions.shutdown();
	const reopened = await f.manager(f.sessions["missions"]!);
	await reopened["archiveInactiveSessions"]();
	assert.equal(reopened["metas"].get(f.id)?.pending?.[0]?.requestId, "mission-notice:held");
	assert.equal(reopened.get(f.id)?.archivedAt, undefined);
	assert.equal(reopened["workers"].size, 0);
	assert.equal(await readFile(scratch, "utf8"), "retained");
});

test("passive lifecycle rejects an already-admitted archive before changing the mission", async (t) => {
	const f = await coordinatorFixture(t);
	const entered = deferred();
	const gate = deferred();
	const save = f.sessions["save"].bind(f.sessions);
	f.sessions["save"] = async (meta, archive, pin) => {
		if (archive) {
			entered.resolve();
			await gate.promise;
		}
		return save(meta, archive, pin);
	};
	const archive = f.sessions.archive(f.id);
	try {
		await entered.promise;
		assert.throws(
			() =>
				f.service.lifecycle(f.mission.id, {
					operationId: randomUUID(),
					home: { daemonId: "daemon", lineageId: "lineage" },
					projectId: f.first.id,
					expectedStatus: "active",
					action: "archive",
				}),
			/already in progress/,
		);
		assert.equal(f.store.require(f.mission.id).status, "active");
		assert.equal(f.store.passiveLifecycle(f.mission.id), false);
	} finally {
		gate.resolve();
		await archive;
		f.sessions["save"] = save;
	}
});

test("passive lifecycle HTTP pins home, holds ACK for durability and exposes post-commit errors", async (t) => {
	const f = await coordinatorFixture(t);
	const hello = {
		daemonId: "daemon",
		lineageId: "lineage",
		daemonVersion: "1.0.0",
		protocolVersion: 1,
		minimumClientProtocolVersion: 1,
		platform: "darwin" as const,
		arch: "arm64" as const,
		capabilities: {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: false,
			coordinatorIsolation: false,
			independentExecution: true,
		},
	};
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		new ModelCatalog(join(f.home, "agent")),
		terminals,
		{ service: f.service, store: f.store },
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		hello,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const value = {
		operationId: randomUUID(),
		home: { daemonId: "daemon", lineageId: "lineage" },
		projectId: f.first.id,
		expectedStatus: "active",
		action: "archive",
	};
	const post = (v: unknown) =>
		fetch(`${base}/api/missions/${f.mission.id}/lifecycle`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(v),
		});
	const gate = deferred();
	const entered = deferred();
	const durable = f.store.durable.bind(f.store);
	try {
		const wrong = await post({ ...value, home: { daemonId: "other", lineageId: "lineage" } });
		assert.equal(wrong.status, 409);
		await wrong.arrayBuffer();
		assert.equal(f.store.require(f.mission.id).status, "active");
		const original = t.mock.method(f.store, "durable", async () => {
			entered.resolve();
			await gate.promise;
			await durable();
		});
		let answered = false;
		const pending = post(value).then((r) => {
			answered = true;
			return r;
		});
		await entered.promise;
		assert.equal(answered, false);
		assert.equal(f.store.require(f.mission.id).status, "archived");
		gate.resolve();
		const response = await pending;
		assert.equal(response.status, 200);
		const ack = (await response.json()) as { operationId: string; mission: { passiveLifecycle?: boolean } };
		assert.equal(ack.operationId, value.operationId);
		assert.equal(ack.mission.passiveLifecycle, true);
		original.mock.restore();
		const unsubscribe = f.store.onChange(() => {
			throw new Error("after commit");
		});
		const failed = await post({ ...value, operationId: randomUUID(), expectedStatus: "archived", action: "reopen" });
		assert.equal(failed.status, 400);
		await failed.arrayBuffer();
		unsubscribe();
		assert.equal(f.store.require(f.mission.id).status, "active");
		assert.equal(f.sessions.get(f.id)?.archivedAt, undefined);
		assert.equal(f.sessions["workers"].size, 0);
	} finally {
		gate.resolve();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
	}
});
