// biome-ignore-all lint/complexity/useLiteralKeys: Exercise durable role transitions without a provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KernelSpec } from "@pilot/kernel";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionMissionBridge } from "./sessions.ts";
import { copyGitSeed } from "./testing/git-seed.ts";
import { run } from "./workspaces.ts";

test("promotion unbinds PRs, shares main, retains scratch, and demotion restores a normal workspace", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pilot-coordinator-")));
	const upstream = join(home, "upstream");
	copyGitSeed(upstream, { "file.txt": "base\n" });
	const source = join(home, "source");
	await run("git", ["clone", upstream, source], home);
	await run("jj", ["git", "init", "--colocate"], source);
	const projects = new ProjectStore(home);
	const project = await projects.create({ path: source });
	let specs: KernelSpec[] = [];
	let busy = false;
	const activities: string[] = [];
	const manager = new SessionManager(
		home,
		projects,
		undefined,
		{
			worker: (spec, onPacket) => {
				specs.push(spec);
				return {
					ready: Promise.resolve(),
					state: "idle",
					get busy() {
						return busy;
					},
					send() {},
					hasChildren: async () => false,
					close: async () => {},
					request: async (command) => {
						if (command.type === "activity") activities.push(command.text);
						if (command.type === "input") onPacket({ type: "accepted", requestId: command.requestId });
					},
				};
			},
			title: async () => undefined,
		},
		{
			runner: async () => {
				throw new Error("No GitHub calls allowed for coordinators");
			},
		},
	);
	let coordinator = true;
	const bridge: SessionMissionBridge = {
		membership: () => ({ missionId: "group", active: true, coordinator }),
		context: () => ({
			id: "group",
			title: "Example",
			goal: "",
			status: "active",
			coordinator: coordinator ? "self" : "other",
			tasks: [],
			decisions: [],
		}),
		spawnProject: () => project.id,
		joinSpawn() {},
		call: async () => ({}),
	};
	manager.setMissionBridge(bridge);
	await manager.load();
	t.after(async () => {
		await manager.shutdown();
		await run("chmod", ["-R", "u+w", home], home);
		await rm(home, { recursive: true, force: true });
	});
	const id = randomUUID();
	const workspace = await manager["sharedWorkspaces"].create(source, join(home, "sessions", id, "workspace"));
	const url = "https://github.com/octo/repo/pull/42";
	await mkdir(join(home, "sessions", id), { recursive: true });
	const meta: Parameters<SessionManager["save"]>[0] = {
		id,
		projectId: project.id,
		cwd: workspace.path,
		title: "Chat",
		createdAt: 1,
		updatedAt: 1,
		workspace: { ...workspace, source, upstream: "https://github.com/octo/repo.git", branch: "fix/old" },
		boundPullRequests: [url],
		pullRequest: { number: 42, url, title: "Old", state: "open", checkedAt: 1 },
	};
	await manager["save"](meta);
	await assert.rejects(manager["openWorker"](id), /workspace role is still changing/);
	manager.missionChanged(id);
	await manager.commands(id);
	await manager.refreshCoordinatorWorkspace(id);
	const sibling = randomUUID();
	const siblingWorkspace = await manager["sharedWorkspaces"].create(
		source,
		join(home, "sessions", sibling, "workspace"),
	);
	await manager["save"]({
		id: sibling,
		projectId: project.id,
		cwd: siblingWorkspace.path,
		title: "Second plan",
		createdAt: 1,
		updatedAt: 1,
		workspace: { ...siblingWorkspace, source, upstream: "https://github.com/octo/repo.git" },
	});
	manager.missionChanged(sibling);
	await manager.refreshCoordinatorWorkspace(sibling);
	assert.equal(manager.get(sibling)!.cwd, meta.cwd, "all source readers of the project share one view");
	assert.notEqual(manager["require"](sibling).coordinatorView!.scratch, meta.coordinatorView!.scratch);
	assert.equal(manager["mainProjects"]().length, 1);
	assert.equal(manager.get(id)!.branch, undefined);
	assert.equal(manager.get(id)!.pullRequests, undefined);
	assert.deepEqual(manager.ownedPullRequests(id), []);
	assert.equal(manager.pullRequestOwner(url), undefined);
	assert.ok(meta.unboundPullRequests?.includes(url));
	await manager["starting"].get(id);
	assert.ok(activities.some((text) => /Unbound 1 pull request/.test(text)));
	assert.throws(() => manager.changeBase(id), /read-only/);
	await assert.rejects(manager.bindPullRequest(id, url), /coordinator cannot own/);
	await manager["applyPullRequest"](meta, {
		branch: "fix/discovered",
		pullRequest: { number: 42, url, title: "Late lookup", state: "merged", checkedAt: 2 },
	});
	assert.equal(meta.pullRequest, undefined);
	assert.equal(meta.workspace!.branch, "fix/old", "the preserved isolated workspace is not rewritten");
	const scratch = meta.coordinatorView!.scratch;
	const path = meta.cwd;
	await writeFile(join(scratch, "notes.txt"), "keep across turns");
	await manager.send(id, "read source");
	await manager.send(id, "read again");
	assert.equal(specs.length, 1);
	assert.equal(specs[0]!.cwd, scratch);
	assert.equal(specs[0]!.pilot?.coordinatorView?.scratch, scratch);
	assert.equal(await readFile(join(scratch, "notes.txt"), "utf8"), "keep across turns");
	await assert.rejects(writeFile(join(path, "file.txt"), "forbidden"), /EACCES|EPERM/);
	const events: string[] = [];
	manager.onMainMoved((event) => {
		events.push(event.head);
	});
	await writeFile(join(upstream, "file.txt"), "new main\n");
	await run("git", ["add", "."], upstream);
	await run(
		"git",
		["-c", "commit.gpgSign=false", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "next"],
		upstream,
	);
	await Promise.all([manager.refreshProjectMain(project.id), manager.refreshProjectMain(project.id)]);
	assert.equal(events.length, 1);
	assert.equal(meta.cwd, path, "live kernels keep a stable source directory");
	assert.equal(await readFile(join(path, "file.txt"), "utf8"), "new main\n");
	await manager.archive(id);
	assert.equal(existsSync(scratch), false);
	await manager.restore(id);
	await manager.refreshCoordinatorWorkspace(id);
	assert.ok(existsSync(scratch));
	specs = [];
	busy = true;
	coordinator = false;
	manager.missionChanged(id);
	await manager.refreshCoordinatorWorkspace(id);
	assert.equal(meta.cwd, path, "demotion waits for an admitted turn or job");
	await manager.send(id, "continue after demotion");
	assert.equal(specs.length, 0, "new input cannot start a worker in the wrong role");
	assert.equal(meta.workspace!.branch, "fix/old", "waiting for demotion does not move the isolated workspace");
	busy = false;
	manager.missionChanged(id);
	await manager.refreshCoordinatorWorkspace(id);
	await manager["starting"].get(id);
	assert.equal(meta.cwd, workspace.path);
	assert.equal(meta.coordinatorView, undefined);
	assert.equal(manager.get(id)!.branch, undefined, "the resumed input refreshes the empty workspace to current main");
	assert.equal(await readFile(join(meta.cwd, "file.txt"), "utf8"), "new main\n");
	assert.doesNotThrow(() => manager.changeBase(id));
	await writeFile(join(meta.cwd, "new.txt"), "normal writes return");
	await manager.send(id, "continue coding");
	assert.equal(specs[0]!.pilot?.coordinatorView, undefined);
	assert.ok(
		manager["canClaimPullRequest"](meta, {
			number: 43,
			url: "https://github.com/octo/repo/pull/43",
			title: "New work",
			state: "open",
			checkedAt: 3,
		}),
	);
	busy = true;
	coordinator = true;
	manager.missionChanged(id);
	await manager.refreshCoordinatorWorkspace(id);
	assert.equal(meta.coordinatorView, undefined, "promotion also waits for a safe boundary");
	await manager.send(id, "read after promotion");
	assert.equal(specs.length, 1);
	busy = false;
	manager.missionChanged(id);
	await manager.refreshCoordinatorWorkspace(id);
	await manager["starting"].get(id);
	assert.equal(meta.cwd, path);
	assert.equal(specs.length, 2);
	assert.equal(specs[1]!.cwd, scratch);
	await manager.refreshCoordinatorWorkspace(sibling);
	await manager.archive(id);
	await manager.archive(sibling);
	assert.deepEqual(manager["mainProjects"](), [], "no active chats means no project watcher entry");
});

test("Git-only direct chats gain a read-only source view and an isolated workspace on demotion", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pilot-direct-coordinator-")));
	const upstream = join(home, "upstream");
	copyGitSeed(upstream, { "file.txt": "base\n" });
	const source = join(home, "source");
	await run("git", ["clone", upstream, source], home);
	const projects = new ProjectStore(home);
	const project = await projects.create({ path: source, workspace: "direct" });
	const manager = new SessionManager(
		home,
		projects,
		undefined,
		{
			title: async () => undefined,
			worker: () => {
				throw new Error("No worker needed");
			},
		},
		{
			runner: async () => {
				throw new Error("No GitHub calls");
			},
		},
	);
	await manager.load();
	let coordinator = true;
	manager.setMissionBridge({
		membership: () => ({ missionId: "g", active: true, coordinator }),
		context: () => ({
			id: "g",
			title: "Plan",
			goal: "",
			status: "active",
			coordinator: coordinator ? "self" : "other",
			tasks: [],
			decisions: [],
		}),
		spawnProject: () => project.id,
		joinSpawn() {},
		call: async () => ({}),
	});
	t.after(async () => {
		await manager.shutdown();
		await run("chmod", ["-R", "u+w", home], home);
		await rm(home, { recursive: true, force: true });
	});
	const id = randomUUID();
	await mkdir(join(home, "sessions", id), { recursive: true });
	const meta = { id, projectId: project.id, cwd: source, title: "Chat", createdAt: 1, updatedAt: 1 };
	await manager["save"](meta);
	manager.missionChanged(id);
	await manager.refreshCoordinatorWorkspace(id);
	assert.notEqual(meta.cwd, source);
	assert.equal(await readFile(join(meta.cwd, "file.txt"), "utf8"), "base\n");
	const scratch = manager["require"](id).coordinatorView!.scratch;
	await writeFile(join(scratch, "note"), "keep until archive, even after demotion");
	coordinator = false;
	manager.missionChanged(id);
	await manager.refreshCoordinatorWorkspace(id);
	assert.equal(meta.cwd, join(home, "sessions", id, "workspace"));
	assert.notEqual(meta.cwd, source);
	await writeFile(join(meta.cwd, "new.txt"), "isolated");
	assert.equal(existsSync(join(source, "new.txt")), false);
	assert.ok(existsSync(scratch));
	await manager.archive(id);
	assert.equal(existsSync(scratch), false);
});

test("every cold worker-open entry point preserves the coordinator source role and private cwd", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pilot-coordinator-entrypoints-")));
	t.after(() => rm(home, { recursive: true, force: true }));
	const source = join(home, "source");
	copyGitSeed(source, { "file.txt": "base\n" });
	const projects = new ProjectStore(home);
	const project = await projects.create({ path: source, workspace: "direct" });
	const actions: Array<[string, (manager: SessionManager, id: string) => Promise<unknown>]> = [
		["commands", (manager, id) => manager.commands(id)],
		["compact", (manager, id) => manager.compact(id)],
		[
			"changeModel",
			(manager, id) =>
				manager.changeModel(id, "fixture/model", {
					list: async () => ({ models: [{ id: "fixture/model", provider: "fixture", name: "Fixture" }] }),
				}),
		],
		["editQueuedMessage", (manager, id) => manager.editQueuedMessage(id, 1, "edit")],
		["removeQueuedMessage", (manager, id) => manager.removeQueuedMessage(id, 1)],
		["heldMessages", (manager, id) => manager.heldMessages(id, "discard")],
		["rewind", (manager, id) => manager.rewind(id, "restore", 1)],
		["activateAttempt", (manager, id) => manager.activateAttempt(id, "1")],
		["subagentCommand", (manager, id) => manager.subagentCommand(id, "child", { action: "stop" })],
		["send", (manager, id) => manager.send(id, "read source")],
		[
			"startup/recovery",
			async (manager, id) => {
				const meta = manager["require"](id);
				meta.working = true;
				await manager["save"](meta);
				await manager.load();
				await manager["starting"].get(id);
			},
		],
	];
	for (const [name, action] of actions)
		await t.test(name, async () => {
			const local = join(home, name.replaceAll("/", "-"));
			const specs: KernelSpec[] = [];
			const manager = new SessionManager(
				local,
				projects,
				undefined,
				{
					worker: (spec) => {
						specs.push(spec);
						throw new Error("isolation entrypoint gate");
					},
					title: async () => undefined,
				},
				{
					runner: async () => {
						throw new Error("No GitHub calls");
					},
				},
			);
			manager.setMissionBridge({
				membership: () => ({ missionId: "g", active: true, coordinator: true }),
				context: () => ({
					id: "g",
					title: "Read",
					goal: "",
					status: "active",
					coordinator: "self",
					tasks: [],
					decisions: [],
				}),
				spawnProject: () => project.id,
				joinSpawn() {},
				call: async () => ({}),
			});
			try {
				const id = randomUUID();
				const scratch = join(local, "sessions", id, "scratch");
				await mkdir(scratch, { recursive: true, mode: 0o700 });
				await manager["save"]({
					id,
					projectId: project.id,
					cwd: source,
					title: "Read",
					createdAt: 1,
					updatedAt: 1,
					coordinatorView: {
						originalCwd: source,
						path: source,
						scratch,
						head: "a".repeat(40),
						repository: source,
					},
					subagents: [
						{
							name: "child",
							state: "idle",
							task: "read",
							cwd: scratch,
							createdAt: 1,
							storage: "private",
							conversationId: "1",
						},
					],
				});
				await action(manager, id).catch((error: Error) =>
					assert.match(error.message, /isolation entrypoint gate|Retry startup before starting its worker/),
				);
				assert.equal(specs.length, 1, `${name} must reach exactly one central worker-open gate`);
				assert.equal(specs[0]!.cwd, scratch);
				assert.equal(specs[0]!.pilot?.coordinatorView?.path, source);
				assert.ok(specs[0]!.pilot?.coordinatorView?.protectedPaths.includes(source));
			} finally {
				await manager.shutdown();
			}
		});
});
