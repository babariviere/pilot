// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private lifecycle, persistence and store seams.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { AgentEvent, SessionState } from "@pilot/protocol";
import { openSessionStorage } from "../../../kernel/src/storage.ts";
import { ProjectStore } from "../projects.ts";
import { type SessionFactories, SessionManager, type SessionManagerOptions, type SessionWorker } from "../sessions.ts";
import { copyGitSeed } from "./git-seed.ts";

export const DAY = 86_400_000;
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
export const git = (cwd: string, ...args: string[]) => command(cwd, "git", args);
export const jj = (cwd: string, ...args: string[]) =>
	command(cwd, "jj", [
		"--config",
		'user.name="Workspace test"',
		"--config",
		'user.email="workspace@example.test"',
		...args,
	]);

export function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export async function until(check: () => boolean) {
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

export async function fixture(t: TestContext, options: SessionManagerOptions = {}) {
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
	copyGitSeed(source, { "tracked.txt": "base\n", ".gitignore": "ignored-secret\n" });
	git(root, "init", "--quiet", "--bare", "-b", "main", join(root, "remote.git"));
	git(source, "remote", "add", "origin", join(root, "remote.git"));
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
	const specs: Parameters<SessionFactories["worker"] & {}>[0][] = [];
	const worker: SessionFactories["worker"] = (spec, onPacket, onExit) => {
		specs.push(spec);
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
		// spawn() starts this initializer asynchronously. Await its own completion rather than polling with
		// a 10-second wall-clock budget: jj workspace creation is subprocess-heavy and can exceed that
		// budget when the rest of the local suite is contending for resources.
		const startup = sessions["starting"].get(created.id);
		assert.ok(startup, "spawn should publish its startup task before returning");
		await startup;
		assert.equal(sessions["starting"].has(created.id), false, "startup task should be removed when settled");
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
	return {
		root,
		home,
		source,
		projects,
		project,
		sessions,
		workers,
		specs,
		manager,
		spawn,
		stored,
		assertSourceUnchanged,
	};
}

export async function seedHistory(directory: string) {
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

export async function assertHistory(sessions: SessionManager, id: string) {
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
