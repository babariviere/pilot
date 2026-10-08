import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AskContext, KernelCommand } from "@pilot/kernel";
import type { AgentEvent, SpawnRequest } from "@pilot/protocol";
import { WebSocket } from "ws";
import { prepareAskSnapshot } from "./ask-snapshots.ts";
import type { DaemonConfig } from "./config.ts";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { type SessionFactories, SessionManager, type SessionWorker } from "./sessions.ts";
import type { TerminalManager } from "./terminals.ts";
import { run } from "./workspaces.ts";

type Spec = Extract<KernelCommand, { type: "start" }>["spec"];

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	// Git preparation and cold-reader thread startup compete with the full suite's browser/native tests.
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await delay(10);
	}
	assert.fail("condition did not settle");
}

async function fileHashes(path: string): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (const entry of (await readdir(path, { recursive: true })).sort()) {
		const file = join(path, entry);
		if ((await stat(file)).isFile())
			hashes[entry] = createHash("sha256")
				.update(await readFile(file))
				.digest("hex");
	}
	return hashes;
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-ask-"));
	const home = join(root, "home");
	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	const source = join(root, "source");
	const git = (cwd: string, args: string[]) => run("git", args, cwd);
	await git(root, ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
	await git(root, ["clone", "--quiet", remote, seed]);
	const commit = async (content: string) => {
		await writeFile(join(seed, "file.txt"), content);
		await git(seed, ["add", "file.txt"]);
		await git(seed, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"--quiet",
			"-m",
			content,
		]);
		return git(seed, ["rev-parse", "HEAD"]);
	};
	await commit("main content");
	await git(seed, ["push", "--quiet", "origin", "main"]);
	await git(root, ["clone", "--quiet", remote, source]);
	// This remote branch is deliberately absent from the source's refs and objects.
	await git(seed, ["switch", "--quiet", "-c", "topic/remote-only"]);
	const selected = await commit("selected content");
	await git(seed, ["push", "--quiet", "origin", "topic/remote-only"]);
	await writeFile(join(source, "file.txt"), "dirty local content");
	await writeFile(join(source, "untracked.txt"), "local only");
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: source, workspace: "direct" });
	const specs: Spec[] = [];
	const managers: SessionManager[] = [];
	let clones = 0;
	const manager = async (factories: SessionFactories = {}) => {
		const sessions = new SessionManager(home, projects, undefined, {
			title: async () => undefined,
			workspace: async (_source, path) => {
				clones++;
				await mkdir(path, { recursive: true });
				return { path, base: "HEAD", jj: false };
			},
			worker: (spec) => {
				specs.push(spec);
				const worker: SessionWorker = {
					state: "idle",
					busy: false,
					ready: Promise.resolve(),
					send: () => {},
					request: async () => {},
					close: async () => {},
				};
				return worker;
			},
			...factories,
		});
		managers.push(sessions);
		await sessions.load();
		return sessions;
	};
	const stored = async (id: string) => JSON.parse(await readFile(join(home, "sessions", id, "meta.json"), "utf8"));
	t.after(async () => {
		await Promise.all(managers.map((sessions) => sessions.shutdown()));
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		home,
		source,
		seed,
		remote,
		git,
		commit,
		selected,
		projects,
		project,
		specs,
		manager,
		stored,
		clones: () => clones,
	};
}

test("Ask checkout never clones, while omitted mode remains Build and per-chat overrides do not alter the project", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const ask = await sessions.spawn({ projectId: f.project.id, mode: "ask", message: "explain", title: "Ask" });
	assert.equal(ask.mode, "ask");
	assert.equal(ask.cwd, f.source);
	assert.equal(ask.state, "starting");
	await waitFor(() => sessions.get(ask.id)?.state === "idle");
	assert.deepEqual(f.specs[0]?.pilot?.ask, { source: f.source });
	assert.equal(f.specs[0]?.pilot?.workspace, undefined);
	assert.equal(f.clones(), 0);
	const build = await sessions.spawn({ projectId: f.project.id, message: "build", title: "Build" });
	assert.equal(build.mode, "build");
	assert.equal(build.workspace, "direct");
	await waitFor(() => sessions.get(build.id)?.state === "idle");
	assert.equal(f.clones(), 0);
	const override = await sessions.spawn({
		projectId: f.project.id,
		workspace: "clone",
		message: "build",
		title: "Clone",
	});
	await waitFor(() => sessions.get(override.id)?.state === "idle");
	assert.equal(override.workspace, "clone");
	assert.equal(sessions.get(override.id)?.workspace, "clone");
	assert.equal(f.clones(), 1);
	assert.equal(f.projects.require(f.project.id).workspace, "direct");
	await f.projects.update(f.project.id, { workspace: "clone" });
	const direct = await sessions.spawn({
		projectId: f.project.id,
		workspace: "direct",
		message: "build",
		title: "Direct",
	});
	await waitFor(() => sessions.get(direct.id)?.state === "idle");
	assert.equal(direct.cwd, f.source);
	assert.equal(direct.workspace, "direct");
	assert.equal(f.clones(), 1);
});

test("Ask exact remote branch uses a durable isolated bare snapshot, immutable across reopen and restore", async (t) => {
	const f = await fixture(t);
	const before = await fileHashes(f.source);
	await assert.rejects(f.git(f.source, ["rev-parse", "--verify", "refs/remotes/origin/topic/remote-only"]));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const sessions = await f.manager({
		askSnapshot: async (...args) => {
			await gate;
			return prepareAskSnapshot(...args);
		},
	});
	const created = await sessions.spawn({
		projectId: f.project.id,
		mode: "ask",
		baseBranch: "topic/remote-only",
		message: "explain",
		title: "Ask",
	});
	assert.equal(created.state, "starting");
	assert.equal(created.sourceBranch, "topic/remote-only");
	const pending = await f.stored(created.id);
	assert.equal(pending.mode, "ask");
	assert.deepEqual(pending.preparing, { source: f.source, baseBranch: "topic/remote-only" });
	assert.equal(pending.ask.commit, undefined);
	assert.equal(f.specs.length, 0);
	release();
	await waitFor(() => sessions.get(created.id)?.state === "idle");
	const meta = await f.stored(created.id);
	assert.equal(meta.ask.commit, f.selected);
	assert.equal(meta.preparing, undefined);
	assert.equal(meta.workspace, undefined);
	assert.equal(f.clones(), 0);
	assert.equal(await f.git(f.root, ["--git-dir", meta.ask.gitDir, "rev-parse", "--is-bare-repository"]), "true");
	assert.equal(await f.git(f.root, ["--git-dir", meta.ask.gitDir, "rev-list", "--count", f.selected]), "1");
	assert.equal(
		await f.git(f.root, ["--git-dir", meta.ask.gitDir, "show", `${f.selected}:file.txt`]),
		"selected content",
	);
	await assert.rejects(stat(join(meta.ask.gitDir, "objects", "info", "alternates")));
	await assert.rejects(stat(join(created.sessionPath!, "workspace")));
	assert.deepEqual(await fileHashes(f.source), before);
	assert.deepEqual(f.specs[0]?.pilot?.ask, meta.ask);
	await sessions.archive(created.id);
	await sessions.shutdown();
	await f.commit("changed remote content");
	await f.git(f.seed, ["push", "--quiet", "origin", "topic/remote-only"]);
	const reopened = await f.manager({
		askSnapshot: async () => {
			assert.fail("must retain pinned snapshot");
		},
	});
	const restored = await reopened.restore(created.id);
	assert.equal(restored.mode, "ask");
	assert.equal(restored.sourceBranch, "topic/remote-only");
	assert.equal(restored.sourceCommit, f.selected);
	await reopened.send(created.id, "more");
	assert.equal(f.specs.at(-1)?.pilot?.ask?.commit, f.selected);
	assert.equal(
		await f.git(f.root, ["--git-dir", meta.ask.gitDir, "show", `${f.selected}:file.txt`]),
		"selected content",
	);
	assert.deepEqual(await fileHashes(f.source), before);
});

test("Ask recovers the fetched private ref when interrupted before commit metadata, without resolving a moved origin head", async (t) => {
	const f = await fixture(t);
	let fetched = false;
	const sessions = await f.manager({
		askSnapshot: async (ask, runner, signal) => {
			await prepareAskSnapshot(ask, runner, signal);
			fetched = true;
			await new Promise<void>((_resolve, reject) => {
				signal!.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
			});
			assert.fail("interrupted preparation must not start worker");
		},
	});
	const created = await sessions.spawn({
		projectId: f.project.id,
		mode: "ask",
		baseBranch: "topic/remote-only",
		message: "explain",
		title: "Ask",
	});
	await waitFor(() => fetched);
	const before = await f.stored(created.id);
	assert.equal(before.ask.commit, undefined);
	assert.equal(f.specs.length, 0);
	await sessions.shutdown();
	await f.commit("moved after crash");
	await f.git(f.seed, ["push", "--quiet", "origin", "topic/remote-only"]);
	const reopened = await f.manager();
	await waitFor(() => reopened.get(created.id)?.state === "idle");
	assert.equal(reopened.get(created.id)?.sourceCommit, f.selected);
	assert.equal(f.specs[0]?.pilot?.ask?.commit, f.selected);
	assert.equal((await f.stored(created.id)).pending.length, 0);
	assert.equal(f.clones(), 0);
});

test("Ask snapshot disables global/template hooks and inherited Git repository/config redirects", async (t) => {
	const f = await fixture(t);
	const before = await fileHashes(f.source);
	const globalHome = join(f.root, "global-home");
	const hooks = join(globalHome, "hooks");
	const template = join(globalHome, "template");
	const marker = join(f.root, "hook-ran");
	await mkdir(hooks, { recursive: true });
	await mkdir(join(template, "hooks"), { recursive: true });
	const hook = `#!/bin/sh\nprintf ran > '${marker}'\nprintf mutated > '${join(f.source, "file.txt")}'\n`;
	for (const dir of [hooks, join(template, "hooks")]) {
		await writeFile(join(dir, "reference-transaction"), hook);
		await chmod(join(dir, "reference-transaction"), 0o755);
	}
	await writeFile(
		join(globalHome, ".gitconfig"),
		`[core]\n\thooksPath = ${hooks}\n[init]\n\ttemplateDir = ${template}\n`,
	);
	const overrides: Record<string, string> = {
		HOME: globalHome,
		GIT_DIR: join(f.source, ".git"),
		GIT_COMMON_DIR: join(f.source, ".git"),
		GIT_OBJECT_DIRECTORY: join(f.source, ".git", "objects"),
		GIT_WORK_TREE: f.source,
		GIT_INDEX_FILE: join(f.source, ".git", "index"),
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.bare",
		GIT_CONFIG_VALUE_0: "false",
	};
	const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
	const gitDir = join(f.home, "private.git");
	let result: AskContext;
	try {
		Object.assign(process.env, overrides);
		result = await prepareAskSnapshot({ source: f.source, branch: "topic/remote-only", gitDir });
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	assert.equal(result.commit, f.selected);
	assert.equal(await f.git(f.root, ["--git-dir", gitDir, "rev-parse", "--is-bare-repository"]), "true");
	await assert.rejects(stat(marker));
	await assert.rejects(stat(join(gitDir, "hooks")));
	assert.deepEqual(await fileHashes(f.source), before);
});

test("malformed modes and workspace combinations reject before durable session admission", async (t) => {
	const f = await fixture(t);
	const sessions = await f.manager();
	const invalid: object[] = [
		{ mode: null },
		{ mode: "invalid" },
		{ mode: 123 },
		{ workspace: null },
		{ workspace: "invalid" },
		{ mode: "ask", workspace: "clone" },
		{ mode: "ask", workspace: "direct" },
		{ workspace: "clone", cwd: f.source },
		{ baseBranch: "topic/remote-only" },
		{ mode: "ask", baseBranch: "main~1" },
		{ mode: "ask", cwd: f.source, baseBranch: "main" },
	];
	for (const overrides of invalid) {
		await assert.rejects(
			sessions.spawn({ projectId: f.project.id, message: "invalid", ...overrides } as SpawnRequest),
		);
		assert.equal(sessions.list().length, 0);
	}
	await assert.rejects(sessions.spawn({ cwd: f.source, mode: "ask", baseBranch: "main", message: "invalid" }));
	assert.equal((await readdir(join(f.home, "sessions"))).length, 0);
	assert.equal(f.specs.length, 0);
});

test("cold parked and archived Ask subscriptions suppress live checkout TODOs without waking a worker", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.source, ".pi", "todos"), { recursive: true });
	await writeFile(
		join(f.source, ".pi", "todos", "aabbccdd.md"),
		'---\n{"id":"TODO-aabbccdd","title":"Live checkout only","status":"open","tags":[]}\n---\nprivate checkout content',
	);
	const before = await fileHashes(f.source);
	const original = await f.manager();
	const created = [];
	for (const baseBranch of [undefined, "topic/remote-only"]) {
		for (const archived of [false, true]) {
			const ask = await original.spawn({
				projectId: f.project.id,
				mode: "ask",
				baseBranch,
				message: "explain",
				title: "Ask",
			});
			await waitFor(() => original.get(ask.id)?.state === "idle");
			if (archived) await original.archive(ask.id);
			created.push({ ask, baseBranch, archived });
		}
	}
	await original.shutdown();
	const reopened = await f.manager();
	for (const { ask, baseBranch, archived } of created) {
		const batches: AgentEvent[][] = [];
		const off = reopened.subscribe(ask.id, (events) => batches.push(events));
		await waitFor(() => batches.length > 0);
		assert.deepEqual(
			batches.flat().filter((event) => event.type === "todos_update"),
			[{ type: "todos_update", items: [] }],
		);
		assert.ok(batches.flat().some((event) => event.type === "snapshot"));
		assert.equal(reopened.get(ask.id)?.mode, "ask");
		assert.equal(reopened.get(ask.id)?.sourceBranch, baseBranch);
		assert.equal(reopened.get(ask.id)?.sourceCommit, baseBranch ? f.selected : undefined);
		assert.equal(reopened.get(ask.id)?.state, "parked");
		assert.equal(reopened.get(ask.id)?.error, undefined);
		assert.equal(reopened.get(ask.id)?.archivedAt !== undefined, archived);
		off();
	}
	assert.equal(f.specs.length, 4);
	assert.deepEqual(await fileHashes(f.source), before);
});

test("corrupt reopened Ask metadata fails closed rather than starting a Build worker or cold reader", async (t) => {
	const f = await fixture(t);
	const before = await fileHashes(f.source);
	const original = await f.manager();
	const created = await original.spawn({ projectId: f.project.id, mode: "ask", message: "explain", title: "Ask" });
	await waitFor(() => original.get(created.id)?.state === "idle");
	await original.shutdown();
	const valid = await f.stored(created.id);
	const snapshot = {
		source: f.source,
		branch: "main",
		gitDir: join(created.sessionPath!, "ask.git"),
		commit: f.selected,
	};
	const corruptions = [
		{ ask: undefined },
		{ ask: { source: f.seed } },
		{ ask: { source: f.source, gitDir: snapshot.gitDir } },
		{ ask: { ...snapshot, gitDir: f.source } },
		{ ask: { ...snapshot, commit: undefined } },
		{ ask: { ...snapshot, commit: "HEAD" } },
		{ ask: { ...snapshot, branch: "main~1" } },
		{ mode: "build", ask: valid.ask },
		{ mode: undefined, ask: valid.ask },
		{ mode: "invalid", ask: undefined },
		{ ask: valid.ask, preparing: { source: f.source, baseBranch: "main" } },
	];
	for (const corrupt of corruptions) {
		await writeFile(join(created.sessionPath!, "meta.json"), JSON.stringify({ ...valid, ...corrupt }));
		const reopened = await f.manager({
			snapshot: async () => {
				assert.fail("invalid context must not enter cold reader");
			},
		});
		const unsubscribe = reopened.subscribe(created.id, () => {});
		await waitFor(() => reopened.get(created.id)?.state === "failed");
		assert.ok(["ask", "build"].includes(JSON.parse(JSON.stringify(reopened.get(created.id))).mode));
		assert.throws(() => reopened.assertWritable(created.id));
		assert.match(reopened.get(created.id)?.error ?? "", /Ask|mode/);
		assert.equal(f.specs.length, 1);
		unsubscribe();
		await reopened.shutdown();
	}
	assert.deepEqual(await fileHashes(f.source), before);
	assert.equal(f.clones(), 0);
	// A genuinely legacy Build has no mode or Ask context and still reopens normally.
	await writeFile(
		join(created.sessionPath!, "meta.json"),
		JSON.stringify({ ...valid, mode: undefined, ask: undefined }),
	);
	const legacy = await f.manager();
	await legacy.send(created.id, "legacy build");
	assert.equal(legacy.get(created.id)?.mode, "build");
	assert.equal(f.specs.length, 2);
});

test("direct project origin heads are available only with Ask branches mode, and server blocks Ask write capabilities", async (t) => {
	const f = await fixture(t);
	const before = await fileHashes(f.source);
	const sessions = await f.manager();
	const ask = await sessions.spawn({ projectId: f.project.id, mode: "ask", message: "explain", title: "Ask" });
	let terminalCalls = 0;
	const terminals = {
		attach: () => {
			terminalCalls++;
			return () => {};
		},
		write: () => {
			terminalCalls++;
		},
	} as unknown as TerminalManager;
	const server = createDaemonServer({} as DaemonConfig, sessions, f.projects, {} as ModelCatalog, terminals);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const ws = new WebSocket(`${base.replace("http:", "ws:")}/api/ws`);
	t.after(async () => {
		ws.terminate();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	await once(ws, "open");
	assert.deepEqual(await (await fetch(`${base}/api/projects/${f.project.id}/branches`)).json(), { branches: [] });
	assert.deepEqual(await (await fetch(`${base}/api/projects/${f.project.id}/branches?mode=ask`)).json(), {
		branches: ["main", "topic/remote-only"],
		defaultBranch: "main",
	});
	assert.deepEqual(
		await (await fetch(`${base}/api/projects/${f.project.id}/branches?mode=build&workspace=clone`)).json(),
		{
			branches: ["main", "topic/remote-only"],
			defaultBranch: "main",
		},
	);
	for (const route of ["changes", "changes/summary"]) {
		const response = await fetch(`${base}/api/sessions/${ask.id}/${route}`, {
			method: route.startsWith("changes") ? "GET" : "POST",
		});
		assert.equal(response.status, 409);
		assert.match((await response.json()).error, /read-only/);
	}
	for (const route of ["publish", "pull-request", "pull-requests", "pr"]) {
		assert.equal((await fetch(`${base}/api/sessions/${ask.id}/${route}`, { method: "POST" })).status, 404);
	}
	for (const message of [
		{ type: "terminal.attach", sessionId: ask.id, cols: 80, rows: 24 },
		{ type: "terminal.input", sessionId: ask.id, data: "touch forbidden\n" },
	]) {
		const result = once(ws, "message");
		ws.send(JSON.stringify(message));
		const [raw] = await result;
		assert.match(JSON.parse(String(raw)).message, /read-only/);
	}
	assert.equal(terminalCalls, 0);
	assert.deepEqual(await fileHashes(f.source), before);
});
