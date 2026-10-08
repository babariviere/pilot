// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private lifecycle, persistence and store seams.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { ArtifactStore } from "@pilot/artifacts";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { AgentEvent, SessionState, SessionSummary } from "@pilot/protocol";
import { openSessionStorage } from "../../kernel/src/storage.ts";
import { Conflict } from "./errors.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { type SessionFactories, SessionManager, type SessionManagerOptions, type SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

const DAY = 86_400_000;
const command = (cwd: string, file: string, args: string[]) =>
	execFileSync(file, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Workspace test",
			GIT_AUTHOR_EMAIL: "workspace@example.test",
			GIT_COMMITTER_NAME: "Workspace test",
			GIT_COMMITTER_EMAIL: "workspace@example.test",
		},
	}).trim();
const git = (cwd: string, ...args: string[]) => command(cwd, "git", args);
const jj = (cwd: string, ...args: string[]) =>
	command(cwd, "jj", [
		"--config",
		'user.name="Workspace test"',
		"--config",
		'user.email="workspace@example.test"',
		...args,
	]);

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function until(check: () => boolean) {
	// Bounded attempts also work when a sweep test freezes Date.now().
	for (let attempt = 0; attempt < 2_000; attempt++) {
		if (check()) return;
		await delay(5);
	}
	assert.fail("workspace lifecycle did not settle");
}

class FakeWorker implements SessionWorker {
	readonly ready = Promise.resolve();
	state: SessionState = "idle";
	busy = false;
	children = false;
	closed = false;
	readonly requests: KernelCommand[] = [];
	private readonly onPacket: (packet: KernelPacket) => void;
	private readonly onExit: (worker: SessionWorker, code: number | null) => void;

	constructor(onPacket: (packet: KernelPacket) => void, onExit: (worker: SessionWorker, code: number | null) => void) {
		this.onPacket = onPacket;
		this.onExit = onExit;
	}

	send(_command: KernelCommand): void {}
	async request(command: Extract<KernelCommand, { requestId: string }>): Promise<void> {
		this.requests.push(command);
		this.state = command.type === "input" ? "working" : "idle";
		this.onPacket({ type: "working", working: this.state === "working" });
	}
	async hasChildren(): Promise<boolean> {
		return this.children;
	}
	async close(): Promise<void> {
		this.closed = true;
		this.onExit(this, 0);
	}
}

async function fixture(t: TestContext, options: SessionManagerOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), "pilot-session-workspaces-"));
	const home = join(root, "home");
	const source = join(root, "source");
	const managers: SessionManager[] = [];
	t.after(async () => {
		try {
			for (const manager of managers) {
				await manager.shutdown();
				await Promise.allSettled([...manager["starting"].values(), ...manager["saving"].values()]);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	// Git establishes the fixture before it becomes a jj repository. All later mutations use jj.
	git(root, "init", "--quiet", "--bare", "-b", "main", join(root, "remote.git"));
	git(root, "clone", "--quiet", join(root, "remote.git"), source);
	await writeFile(join(source, "tracked.txt"), "base\n");
	await writeFile(join(source, ".gitignore"), "ignored-secret\n");
	git(source, "add", ".");
	git(source, "commit", "--quiet", "-m", "base");
	git(source, "push", "--quiet", "origin", "HEAD:main");
	jj(source, "git", "init", "--colocate");
	await writeFile(join(source, "tracked.txt"), "source dirty, never touch\n");
	jj(source, "status");
	const sourceState = () => ({
		operation: jj(source, "--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id"),
		change: jj(source, "--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "change_id ++ commit_id"),
		refs: git(source, "show-ref"),
		status: git(source, "status", "--porcelain"),
	});
	const originalSource = sourceState();
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: source });
	const workers: FakeWorker[] = [];
	const worker: SessionFactories["worker"] = (_spec, onPacket, onExit) => {
		const value = new FakeWorker(onPacket, onExit);
		workers.push(value);
		return value;
	};
	const manager = async (overrides: SessionManagerOptions = {}) => {
		const value = new SessionManager(
			home,
			projects,
			undefined,
			{ worker, title: async () => undefined }, // Deliberately DO NOT inject workspace: exercise default shared creation.
			{ runner: async (file, args) => (file === "git" && args[0] === "branch" ? "" : "[]") },
			{ idleParkMs: Number.POSITIVE_INFINITY, ...options, ...overrides },
		);
		managers.push(value);
		await value.load();
		await value["pullRequests"].stop();
		return value;
	};
	const sessions = await manager();
	const spawn = async (workspace?: "clone" | "direct") => {
		const created = await sessions.spawn({ projectId: project.id, workspace, message: "workspace lifecycle" });
		await until(() => !sessions["starting"].has(created.id));
		assert.equal(sessions.get(created.id)?.state, "working", sessions["metas"].get(created.id)?.failure);
		await sessions.stop(created.id);
		await Promise.all([...sessions["titleTasks"], ...sessions["saving"].values()]);
		return sessions.get(created.id)!;
	};
	const stored = async (id: string) =>
		JSON.parse(await readFile(join(home, "sessions", id, "meta.json"), "utf8")) as NonNullable<
			ReturnType<(typeof sessions)["metas"]["get"]>
		>;
	const assertSourceUnchanged = async () => {
		assert.deepEqual(sourceState(), originalSource);
		assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "source dirty, never touch\n");
	};
	return { root, home, source, projects, project, sessions, workers, manager, spawn, stored, assertSourceUnchanged };
}

async function seedHistory(directory: string) {
	const owned = await openSessionStorage(join(directory, "durable"));
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "test.persisted", data: { text: "retained conversation" } });
		}, context);
	} finally {
		await harness.close(context);
		owned.release();
	}
}

async function assertHistory(sessions: SessionManager, id: string) {
	const batches: AgentEvent[][] = [];
	const off = sessions.subscribe(id, (events) => batches.push(events));
	try {
		await until(() => batches.length > 0);
		const snapshot = batches[0]![0]!;
		assert.equal(snapshot.type, "snapshot");
		if (snapshot.type === "snapshot") assert.deepEqual(snapshot.entries[0]?.data, { text: "retained conversation" });
	} finally {
		off();
	}
}

test("default creation shares a daemon-owned jj repository between sessions without touching the source", async (t) => {
	const f = await fixture(t);
	const first = await f.spawn();
	const second = await f.spawn();
	const repo = async (cwd: string) => resolve(cwd, ".jj", (await readFile(join(cwd, ".jj", "repo"), "utf8")).trim());
	assert.equal((await f.stored(first.id)).workspace?.jj, true);
	assert.ok((await f.stored(first.id)).workspace?.shared);
	assert.ok((await f.stored(second.id)).workspace?.shared);
	assert.equal(await repo(first.cwd), await repo(second.cwd));
	assert.notEqual(await repo(first.cwd), join(f.source, ".jj", "repo"));
	assert.notEqual(first.cwd, second.cwd);
	await writeFile(join(first.cwd, "tracked.txt"), "first private change\n");
	jj(first.cwd, "status");
	assert.equal(await readFile(join(second.cwd, "tracked.txt"), "utf8"), "base\n");
	await f.assertSourceUnchanged();
});

test("manual reclaim is immediate, retains history/artifacts, and restart restore preserves exact dirty jj state", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await assert.rejects(f.sessions.reclaimWorkspace(created.id), /Archive/);
	await writeFile(join(created.cwd, "tracked.txt"), "unpushed commit\n");
	jj(created.cwd, "commit", "-m", "local unpushed work");
	jj(created.cwd, "bookmark", "create", "agent-unpushed", "-r", "@-");
	await writeFile(join(created.cwd, "tracked.txt"), "dirty after commit\n");
	await writeFile(join(created.cwd, "new.txt"), "new dirty file\n");
	const dirty = jj(created.cwd, "log", "--no-graph", "-r", "@", "-T", "change_id ++ commit_id");
	const commit = jj(created.cwd, "log", "--no-graph", "-r", "agent-unpushed", "-T", "commit_id");
	const base = f.sessions.changeBase(created.id).base;
	const workspaceMeta = structuredClone((await f.stored(created.id)).workspace);
	const directory = join(f.home, "sessions", created.id);
	await seedHistory(directory);
	const store = new ArtifactStore(directory, { sessionId: created.id, projectId: f.project.id });
	const artifact = await store.create({ title: "Retained", kind: "html", source: "<p>revision one</p>" });
	await store.update(artifact.id, { title: "Retained", kind: "html", source: "<p>revision two</p>" }, 1);
	const archived = await f.sessions.archive(created.id);
	const before = f.workers.length;
	await f.sessions.reclaimWorkspace(created.id);
	assert.equal(existsSync(created.cwd), false);
	assert.equal(f.sessions.get(created.id)?.archivedAt, archived.archivedAt);
	assert.equal(f.sessions["workers"].has(created.id), false);
	assert.equal(f.workers[0]?.closed, true);
	const reclaimed = await f.stored(created.id);
	assert.equal(reclaimed.workspaceRecovery?.phase, "reclaimed");
	assert.ok(reclaimed.workspaceReclaimedAt);
	assert.deepEqual(reclaimed.workspace, workspaceMeta);
	await assertHistory(f.sessions, created.id);
	assert.equal((await f.sessions.artifact(created.id, artifact.id, 1)).source, "<p>revision one</p>");
	assert.equal((await f.sessions.artifacts(created.id))[0]?.revision, 2);
	assert.equal(f.workers.length, before, "cold reads must not reopen a worker");
	await f.sessions.shutdown();
	const restarted = await f.manager();
	await assertHistory(restarted, created.id);
	assert.throws(() => restarted.assertWritable(created.id), Conflict);
	assert.throws(() => restarted.changeBase(created.id), Conflict);
	await assert.rejects(restarted.send(created.id, "cannot resume reclaimed work"), Conflict);
	await restarted.restore(created.id);
	assert.equal(restarted.get(created.id)?.archivedAt, undefined);
	assert.equal(await readFile(join(created.cwd, "tracked.txt"), "utf8"), "dirty after commit\n");
	assert.equal(await readFile(join(created.cwd, "new.txt"), "utf8"), "new dirty file\n");
	assert.equal(jj(created.cwd, "log", "--no-graph", "-r", "@", "-T", "change_id ++ commit_id"), dirty);
	assert.equal(jj(created.cwd, "log", "--no-graph", "-r", "agent-unpushed", "-T", "commit_id"), commit);
	assert.equal(restarted.changeBase(created.id).base, base);
	const restored = await f.stored(created.id);
	assert.equal(restored.workspaceRecovery, undefined);
	assert.equal(restored.workspaceReclaimedAt, undefined);
	assert.equal(restored.workspaceCleanupError, undefined);
	assert.equal(f.workers.length, before, "restoration never starts a worker");
	await f.assertSourceUnchanged();
});

test("an ignored file blocks reclamation, records the error and preserves every file", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await writeFile(join(created.cwd, "tracked.txt"), "dirty and valuable\n");
	await writeFile(join(created.cwd, "ignored-secret"), "irreplaceable ignored credentials\n");
	await f.sessions.archive(created.id);
	await assert.rejects(f.sessions.reclaimWorkspace(created.id), /ignored|unsafe|untracked|preserv/i);
	assert.equal(await readFile(join(created.cwd, "ignored-secret"), "utf8"), "irreplaceable ignored credentials\n");
	assert.equal(await readFile(join(created.cwd, "tracked.txt"), "utf8"), "dirty and valuable\n");
	assert.ok(existsSync(join(created.cwd, ".jj")));
	const stored = await f.stored(created.id);
	assert.ok(stored.archivedAt);
	assert.ok(stored.workspaceCleanupError);
	assert.equal(stored.workspaceReclaimedAt, undefined);
	assert.notEqual(stored.workspaceRecovery?.phase, "reclaimed");
	await f.assertSourceUnchanged();
});

test("private retention sweep includes exactly 30 days, skips recent, active, legacy and direct workspaces", async (t) => {
	const f = await fixture(t);
	const boundary = await f.spawn();
	const recent = await f.spawn();
	const active = await f.spawn();
	const legacy = await f.spawn();
	const direct = await f.spawn("direct");
	for (const created of [boundary, recent, legacy, direct]) await f.sessions.archive(created.id);
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	const metas = f.sessions["metas"];
	metas.get(boundary.id)!.archivedAt = now - 30 * DAY;
	metas.get(recent.id)!.archivedAt = now - 30 * DAY + 1;
	metas.get(legacy.id)!.archivedAt = now - 31 * DAY;
	delete metas.get(legacy.id)!.workspace!.shared;
	metas.get(direct.id)!.archivedAt = now - 31 * DAY;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(existsSync(boundary.cwd), false, "exact retention boundary is eligible");
	for (const created of [recent, active, legacy, direct]) assert.ok(existsSync(created.cwd), created.id);
	assert.equal((await f.stored(boundary.id)).workspaceRecovery?.phase, "reclaimed");
	await assert.rejects(f.sessions.reclaimWorkspace(legacy.id), /shared/);
	await assert.rejects(f.sessions.reclaimWorkspace(direct.id), /shared/);
});

test("Infinity disables the private retention sweep but not explicit immediate reclaim", async (t) => {
	const f = await fixture(t, { workspaceRetentionMs: Number.POSITIVE_INFINITY });
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	f.sessions["metas"].get(created.id)!.archivedAt = 1;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.ok(existsSync(created.cwd));
	await f.sessions.reclaimWorkspace(created.id);
	assert.equal(existsSync(created.cwd), false);
});

test("configured retention and a restored-at-selection session are rechecked by the private sweep", async (t) => {
	const f = await fixture(t, { workspaceRetentionMs: DAY });
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	const meta = f.sessions["metas"].get(created.id)!;
	meta.archivedAt = now - DAY + 1;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.ok(existsSync(created.cwd));
	meta.archivedAt = now - DAY;
	const restoring = f.sessions.restore(created.id);
	const sweep = f.sessions["reclaimArchivedWorkspaces"]();
	await Promise.all([restoring, sweep]);
	assert.equal(meta.archivedAt, undefined);
	assert.ok(existsSync(created.cwd), "queued automatic reclaim must recheck archival after restore");
	await f.sessions.archive(created.id);
	meta.archivedAt = now - DAY;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(existsSync(created.cwd), false);
});

test("live PTYs, busy workers and worker subprocesses block manual reclaim and are skipped by maintenance", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	const meta = f.sessions["metas"].get(created.id)!;
	meta.archivedAt = Date.now() - 31 * DAY;
	const worker = f.workers[0]!;
	let pty = true;
	f.sessions.setWorkspaceProcessGuard((id) => id === created.id && pty);
	for (const guard of ["pty", "busy", "children"] as const) {
		pty = guard === "pty";
		worker.busy = guard === "busy";
		worker.children = guard === "children";
		await assert.rejects(f.sessions.reclaimWorkspace(created.id), Conflict);
		await f.sessions["reclaimArchivedWorkspaces"]();
		assert.ok(existsSync(created.cwd), guard);
		assert.equal(worker.closed, false, guard);
		assert.equal(meta.workspaceRecovery, undefined, guard);
	}
	pty = false;
	worker.busy = false;
	worker.children = false;
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(existsSync(created.cwd), false);
});

test("cached open and draft PRs block manual and automatic reclaim, while merged and closed PRs are eligible", async (t) => {
	const f = await fixture(t);
	const first = await f.spawn();
	const second = await f.spawn();
	for (const created of [first, second]) await f.sessions.archive(created.id);
	const firstMeta = f.sessions["metas"].get(first.id)!;
	const secondMeta = f.sessions["metas"].get(second.id)!;
	for (const [meta, state] of [
		[firstMeta, "open"],
		[secondMeta, "draft"],
	] as const) {
		meta.archivedAt = Date.now() - 31 * DAY;
		meta.pullRequest = {
			number: 10,
			url: "https://github.com/example/repository/pull/10",
			title: "Still in review",
			state,
			checkedAt: Date.now() - DAY,
		};
		await f.sessions["save"](meta);
		await assert.rejects(f.sessions.reclaimWorkspace(meta.id), Conflict);
	}
	const snapshot = t.mock.method(f.sessions["sharedWorkspaces"], "snapshot");
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(snapshot.mock.callCount(), 0, "cached live PRs must be skipped before snapshotting");
	for (const created of [first, second]) {
		assert.equal(await readFile(join(created.cwd, "tracked.txt"), "utf8"), "base\n");
		assert.ok(existsSync(join(created.cwd, ".jj")));
		assert.equal((await f.stored(created.id)).workspaceRecovery, undefined);
		assert.equal(f.sessions["workers"].has(created.id), true);
	}
	firstMeta.pullRequest!.state = "merged";
	secondMeta.pullRequest!.state = "closed";
	await f.sessions.reclaimWorkspace(first.id);
	assert.equal(existsSync(first.cwd), false, "merged PR is eligible for manual reclaim");
	await f.sessions["reclaimArchivedWorkspaces"]();
	assert.equal(existsSync(second.cwd), false, "closed PR is eligible for automatic reclaim");
	assert.equal((await f.stored(first.id)).workspaceRecovery?.phase, "reclaimed");
	assert.equal((await f.stored(second.id)).workspaceRecovery?.phase, "reclaimed");
	assert.equal(snapshot.mock.callCount(), 2);
	await f.assertSourceUnchanged();
});

test("reclaim serializes with restore and denies workspace access while store removal is in flight", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	const gate = deferred();
	const entered = deferred();
	t.after(() => gate.resolve());
	const store = f.sessions["sharedWorkspaces"];
	const remove = store.remove.bind(store);
	const removal = t.mock.method(store, "remove", async (...args: Parameters<typeof remove>) => {
		entered.resolve();
		await gate.promise;
		return remove(...args);
	});
	const reclaim = f.sessions.reclaimWorkspace(created.id);
	// The synchronous transition must protect capabilities even before snapshot metadata exists.
	assert.throws(() => f.sessions.assertWritable(created.id), Conflict);
	assert.throws(() => f.sessions.changeBase(created.id), Conflict);
	await entered.promise;
	assert.equal((await f.stored(created.id)).workspaceRecovery?.phase, "removing");
	const duplicate = f.sessions.reclaimWorkspace(created.id);
	const restoring = f.sessions.restore(created.id);
	assert.ok(f.sessions.get(created.id)?.archivedAt);
	assert.equal(removal.mock.callCount(), 1);
	gate.resolve();
	await Promise.all([reclaim, duplicate, restoring]);
	assert.equal(removal.mock.callCount(), 1, "same-target retries share one removal");
	assert.equal(f.sessions.get(created.id)?.archivedAt, undefined);
	assert.ok(existsSync(created.cwd));
	assert.equal((await f.stored(created.id)).workspaceRecovery, undefined);
});

test("queued restore cannot unlock a gated reclaim snapshot and live processes prevent both operations from removing files", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await writeFile(join(created.cwd, "tracked.txt"), "keep while a live process uses the workspace\n");
	await f.sessions.archive(created.id);
	const gate = deferred();
	const entered = deferred();
	t.after(() => gate.resolve());
	const store = f.sessions["sharedWorkspaces"];
	const snapshot = store.snapshot.bind(store);
	t.mock.method(store, "snapshot", async (...args: Parameters<typeof snapshot>) => {
		entered.resolve();
		await gate.promise;
		return snapshot(...args);
	});
	const removal = t.mock.method(store, "remove");
	const restoration = t.mock.method(store, "restore");
	let liveProcess = false;
	f.sessions.setWorkspaceProcessGuard((id) => id === created.id && liveProcess);
	const reclaim = f.sessions.reclaimWorkspace(created.id);
	const reclaimRejected = assert.rejects(reclaim, Conflict);
	await entered.promise;
	assert.equal((await f.stored(created.id)).workspaceRecovery, undefined);
	const restore = f.sessions.restore(created.id);
	const restoreRejected = assert.rejects(restore, Conflict);
	assert.equal(f.sessions["archiveTransitions"].get(created.id)?.archived, false, "restore is now the latest target");
	assert.equal(
		f.sessions["workspaceMaintenance"].get(created.id),
		1,
		"reclaim retains its independent capability hold",
	);
	assert.equal(
		f.sessions["metas"].get(created.id)?.workspaceRecovery,
		undefined,
		"snapshot has not produced a recipe",
	);
	assert.throws(() => f.sessions.assertWritable(created.id), Conflict, "queued restore cannot release reclaim's hold");
	assert.throws(() => f.sessions.changeBase(created.id), Conflict);
	// Model a shell that became live after the initial reclaim quiescence check.
	liveProcess = true;
	gate.resolve();
	await Promise.all([reclaimRejected, restoreRejected]);
	assert.equal(
		f.sessions["workspaceMaintenance"].has(created.id),
		false,
		"failed operations release every maintenance hold",
	);
	assert.equal(removal.mock.callCount(), 0, "neither reclaim nor queued restore may remove a live workspace");
	assert.equal(restoration.mock.callCount(), 0);
	assert.equal(
		await readFile(join(created.cwd, "tracked.txt"), "utf8"),
		"keep while a live process uses the workspace\n",
	);
	assert.ok(existsSync(join(created.cwd, ".jj")));
	const failed = await f.stored(created.id);
	assert.ok(failed.archivedAt);
	assert.equal(failed.workspaceRecovery?.phase, "removing");
	assert.equal(failed.workspaceReclaimedAt, undefined);
	assert.ok(failed.workspaceCleanupError);
	assert.throws(() => f.sessions.assertWritable(created.id), Conflict);
	assert.equal(f.sessions["workers"].has(created.id), false);
	liveProcess = false;
	await f.sessions.restore(created.id);
	f.sessions.assertWritable(created.id);
	assert.equal(f.sessions.get(created.id)?.archivedAt, undefined);
	assert.equal((await f.stored(created.id)).workspaceRecovery, undefined);
	assert.equal(
		await readFile(join(created.cwd, "tracked.txt"), "utf8"),
		"keep while a live process uses the workspace\n",
	);
	await f.assertSourceUnchanged();
});

test("send racing reclamation cannot start a worker or touch the reclaimed workspace", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	const gate = deferred();
	const entered = deferred();
	t.after(() => gate.resolve());
	const store = f.sessions["sharedWorkspaces"];
	const snapshot = store.snapshot.bind(store);
	t.mock.method(store, "snapshot", async (...args: Parameters<typeof snapshot>) => {
		entered.resolve();
		await gate.promise;
		return snapshot(...args);
	});
	const before = f.workers.length;
	const reclaim = f.sessions.reclaimWorkspace(created.id);
	await entered.promise;
	const send = assert.rejects(f.sessions.send(created.id, "racing message"), Conflict);
	gate.resolve();
	await Promise.all([reclaim, send]);
	assert.equal(f.workers.length, before);
	assert.equal(existsSync(created.cwd), false);
	assert.deepEqual((await f.stored(created.id)).pending, []);
});

test("send waits for gated restoration to recreate the workspace and unarchive before admission", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await f.sessions.archive(created.id);
	await f.sessions.reclaimWorkspace(created.id);
	const gate = deferred();
	const entered = deferred();
	t.after(() => gate.resolve());
	const store = f.sessions["sharedWorkspaces"];
	const restore = store.restore.bind(store);
	t.mock.method(store, "restore", async (...args: Parameters<typeof restore>) => {
		entered.resolve();
		await gate.promise;
		return restore(...args);
	});
	const restoring = f.sessions.restore(created.id);
	await entered.promise;
	assert.equal((await f.stored(created.id)).workspaceRecovery?.phase, "restoring");
	assert.ok(f.sessions.get(created.id)?.archivedAt);
	assert.throws(() => f.sessions.assertWritable(created.id), Conflict);
	assert.throws(() => f.sessions.changeBase(created.id), Conflict);
	const before = f.workers.length;
	const sending = f.sessions.send(created.id, "resume after restore");
	await delay(10);
	assert.equal(f.workers.length, before);
	gate.resolve();
	await Promise.all([restoring, sending]);
	assert.ok(existsSync(created.cwd));
	assert.equal(f.sessions.get(created.id)?.archivedAt, undefined);
	assert.equal(f.workers.length, before + 1);
	assert.equal(f.workers.at(-1)?.requests[0]?.type, "input");
	await f.sessions.stop(created.id);
});

test("failure to persist the pre-removal recovery recipe leaves files intact and never calls remove", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await writeFile(join(created.cwd, "tracked.txt"), "keep on disk failure\n");
	await f.sessions.archive(created.id);
	const save = f.sessions["save"].bind(f.sessions);
	let failed = false;
	const persistence = f.sessions as unknown as { save: typeof save };
	t.mock.method(persistence, "save", async (...args: Parameters<typeof save>) => {
		if (!failed && args[0].workspaceRecovery?.phase === "removing") {
			failed = true;
			throw new Error("recovery metadata disk full");
		}
		return save(...args);
	});
	const remove = t.mock.method(f.sessions["sharedWorkspaces"], "remove");
	await assert.rejects(f.sessions.reclaimWorkspace(created.id), /disk full/);
	assert.equal(remove.mock.callCount(), 0);
	assert.equal(await readFile(join(created.cwd, "tracked.txt"), "utf8"), "keep on disk failure\n");
	assert.ok(existsSync(join(created.cwd, ".jj")));
	assert.ok(f.sessions.get(created.id)?.archivedAt);
	assert.match((await f.stored(created.id)).workspaceCleanupError!, /disk full/);
	assert.equal((await f.stored(created.id)).workspaceReclaimedAt, undefined);
});

test("missing shared repository makes restore fail safely, retaining archival and recovery across restart", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	const repo = resolve(created.cwd, ".jj", (await readFile(join(created.cwd, ".jj", "repo"), "utf8")).trim());
	await f.sessions.archive(created.id);
	await f.sessions.reclaimWorkspace(created.id);
	const recovery = structuredClone((await f.stored(created.id)).workspaceRecovery);
	await f.sessions.shutdown();
	await rename(repo, `${repo}.unavailable`);
	const restarted = await f.manager();
	const before = f.workers.length;
	await assert.rejects(restarted.restore(created.id));
	const failed = await f.stored(created.id);
	assert.ok(failed.archivedAt);
	assert.ok(failed.workspaceRecovery);
	assert.deepEqual({ ...failed.workspaceRecovery, phase: "reclaimed" }, recovery);
	assert.ok(failed.workspaceCleanupError);
	assert.ok(failed.workspaceReclaimedAt);
	assert.equal(f.workers.length, before);
	assert.throws(() => restarted.assertWritable(created.id), Conflict);
	await assert.rejects(restarted.send(created.id, "do not resume"), Conflict);
	await rename(`${repo}.unavailable`, repo);
	await restarted.restore(created.id);
	assert.ok(existsSync(created.cwd));
	assert.equal(restarted.get(created.id)?.archivedAt, undefined);
});

test("restart restores idempotently when removal completed but durable metadata still says removing", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	await writeFile(join(created.cwd, "tracked.txt"), "dirty state before simulated crash\n");
	const dirty = jj(created.cwd, "log", "--no-graph", "-r", "@", "-T", "change_id ++ commit_id");
	await f.sessions.archive(created.id);
	const save = f.sessions["save"].bind(f.sessions);
	const persistence = f.sessions as unknown as { save: typeof save };
	t.mock.method(persistence, "save", async (...args: Parameters<typeof save>) => {
		if (args[0].workspaceRecovery?.phase === "reclaimed") throw new Error("crash before final reclamation write");
		return save(...args);
	});
	await assert.rejects(f.sessions.reclaimWorkspace(created.id), /crash before final reclamation write/);
	assert.equal(existsSync(created.cwd), false, "real store removal completed before the failed save");
	const interrupted = await f.stored(created.id);
	assert.equal(interrupted.workspaceRecovery?.phase, "removing");
	assert.equal(interrupted.workspaceReclaimedAt, undefined);
	assert.ok(interrupted.archivedAt);
	await f.sessions.shutdown();
	const restarted = await f.manager();
	const before = f.workers.length;
	await restarted.restore(created.id);
	assert.equal(await readFile(join(created.cwd, "tracked.txt"), "utf8"), "dirty state before simulated crash\n");
	assert.equal(jj(created.cwd, "log", "--no-graph", "-r", "@", "-T", "change_id ++ commit_id"), dirty);
	assert.equal(restarted.get(created.id)?.archivedAt, undefined);
	assert.equal((await f.stored(created.id)).workspaceRecovery, undefined);
	assert.equal(f.workers.length, before);
	await restarted.restore(created.id);
	assert.equal(f.workers.length, before, "repeated restore remains a worker-free no-op");
	await f.assertSourceUnchanged();
});

test("HTTP reclaim-workspace enforces method, origin and active-session guards, then reclaims an archived session", async (t) => {
	const f = await fixture(t);
	const created = await f.spawn();
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		new ModelCatalog(join(f.home, "agent")),
		terminals,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${created.id}/reclaim-workspace`;
	try {
		for (const [options, status] of [
			[{ method: "GET" }, 404],
			[{ method: "DELETE" }, 404],
			[{ method: "POST", headers: { origin: "https://example.com" } }, 403],
			[{ method: "POST" }, 409],
		] as const) {
			const response = await fetch(url, options);
			assert.equal(response.status, status);
			await response.arrayBuffer();
			assert.ok(existsSync(created.cwd));
		}
		await f.sessions.archive(created.id);
		const running = t.mock.method(terminals, "isRunning", () => true);
		const terminalBlocked = await fetch(url, { method: "POST" });
		assert.equal(terminalBlocked.status, 409, "server-installed process guard blocks a live PTY");
		await terminalBlocked.arrayBuffer();
		assert.ok(existsSync(created.cwd));
		running.mock.restore();
		const before = f.workers.length;
		const success = await fetch(url, { method: "POST" });
		assert.equal(success.status, 200);
		const summary = (await success.json()) as SessionSummary;
		assert.equal(summary.id, created.id);
		assert.ok(summary.archivedAt);
		assert.ok(summary.workspaceReclaimedAt);
		assert.deepEqual(summary, f.sessions.get(created.id));
		assert.equal(existsSync(created.cwd), false);
		assert.equal(f.workers.length, before);
	} finally {
		terminals.shutdown();
		await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
	}
});
