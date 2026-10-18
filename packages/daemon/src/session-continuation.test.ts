// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without real workers/providers.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { AgentEvent, SessionJob, SessionState, SessionSummary } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { continuationHandoff, continuationQueuedInputs } from "./session-continuation.ts";
import { SessionManager, type SessionMissionBridge, type SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

type Spec = Extract<KernelCommand, { type: "start" }>["spec"];
type Command = Extract<KernelCommand, { requestId: string }>;
const original = "first/one",
	same = "first/two",
	other = "second/one";
const pr = "https://github.com/octo/repo/pull/1";
const gate = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
};

class FakeWorker implements SessionWorker {
	readonly ready = Promise.resolve();
	state: SessionState = "idle";
	busy = false;
	closed = false;
	drain?: Promise<void>;
	onDrain?: () => void;
	runningJobs?: SessionJob[];
	readonly commands: Command[] = [];
	readonly usage;
	readonly spec: Spec;
	constructor(spec: Spec, packet: (packet: KernelPacket) => void) {
		this.spec = spec;
		this.usage = { provider: spec.model!.split("/")[0]! };
		queueMicrotask(() =>
			packet({ type: "ready", model: spec.model!, thinking: spec.thinking, working: false, usage: this.usage }),
		);
	}
	send(): void {}
	async request(command: Command): Promise<void> {
		this.commands.push(command);
		if (command.type === "continuation.pause") {
			await this.drain;
			this.onDrain?.();
		}
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

const events = [
	{
		type: "snapshot",
		entries: [
			{ kind: "pi.compaction", model: [{ role: "user", content: "PROVIDER COMPACTION SECRET" }] },
			{ kind: "pi.user", model: [{ role: "user", content: "Fix the tests" }] },
			{
				kind: "pi.message",
				model: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Implemented parser, tests remain" },
							{ type: "thinking", thinking: "PRIVATE THOUGHT", signature: "SIGNATURE" },
							{ type: "toolCall", name: "bash", id: "PROVIDER TOOL ID", arguments: {} },
						],
					},
				],
			},
		],
	},
	{ type: "queue_update", items: [{ id: 1, mode: "followUp", content: "Then update docs" }] },
] as unknown as AgentEvent[];

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-continuation-"));
	const id = randomUUID(),
		dir = join(home, "sessions", id);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "meta.json"),
		JSON.stringify({ id, title: "Work", cwd: home, model: original, createdAt: Date.now(), updatedAt: Date.now() }),
	);
	const projects = new ProjectStore(home);
	const models = new ModelCatalog("/unused");
	t.mock.method(models, "list", async () => ({
		models: [
			{ id: same, name: "Same", provider: "first", thinkingLevels: ["low", "high"] },
			{ id: other, name: "Other", provider: "second", thinkingLevels: ["low", "high"] },
		],
	}));
	const workers: FakeWorker[] = [];
	const managers: SessionManager[] = [];
	const stores: MissionStore[] = [];
	const manager = async (bridge?: SessionMissionBridge) => {
		const sessions = new SessionManager(
			home,
			projects,
			undefined,
			{
				snapshot: async () => ({ events }),
				subagentRead: async () => ({
					full: true,
					events: [
						{
							type: "snapshot",
							entries: [
								{
									kind: "pi.message",
									model: [
										{
											role: "assistant",
											content: [
												{ type: "text", text: "Child parser complete, integration tests unfinished" },
												{ type: "thinking", thinking: "CHILD PRIVATE" },
											],
										},
									],
								},
							],
						},
					] as unknown as AgentEvent[],
				}),
				worker: (spec, packet) => {
					const worker = new FakeWorker(spec, packet);
					workers.push(worker);
					return worker;
				},
			},
			{ runner: async () => "" },
			{ models, idleParkMs: Infinity, workspaceRetentionMs: Infinity },
		);
		if (bridge) sessions.setMissionBridge(bridge);
		t.mock.method(sessions, "subscriptionPaused", () => true);
		managers.push(sessions);
		await sessions.load();
		return sessions;
	};
	const sessions = await manager();
	t.after(async () => {
		for (const entry of managers) await entry.shutdown();
		// Close disk owners before deleting their home, not in a later t.after hook.
		for (const store of stores) {
			try {
				await store.durable();
			} finally {
				store.close();
			}
		}
		await rm(home, { recursive: true, force: true });
	});
	return { home, id, dir, sessions, workers, projects, models, manager, stores };
}

test("handoff is bounded plain visible text, excludes compacted context, thinking and tool metadata", () => {
	const handoff = continuationHandoff(
		{ id: "old", title: "Work", cwd: "/work", branch: "task", pullRequests: [pr], pending: ["Latest request"] },
		events,
	);
	for (const text of ["Fix the tests", "Implemented parser", "Then update docs", "Latest request", pr])
		assert.ok(handoff.includes(text));
	for (const secret of ["PROVIDER COMPACTION", "PRIVATE THOUGHT", "SIGNATURE", "PROVIDER TOOL ID"])
		assert.ok(!handoff.includes(secret));
	assert.ok(
		continuationHandoff(
			{ id: "old", title: "X".repeat(100_000), cwd: "/work", pullRequests: [], pending: ["x".repeat(100_000)] },
			events,
		).length <= 32_000,
	);
});

test("queued user text is transferred losslessly, not truncated into the handoff", () => {
	const content = "user requirement ".repeat(2_000);
	assert.deepEqual(
		continuationQueuedInputs([{ type: "queue_update", items: [{ id: 5, mode: "followUp", content }] }]),
		[{ id: 5, mode: "followUp", content }],
	);
	assert.throws(
		() =>
			continuationQueuedInputs([
				{
					type: "queue_update",
					items: [{ id: 6, mode: "followUp", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }],
				},
			]),
		/queued images/,
	);
});

test("same-provider continuation drains before close, reopens in place with an explicit pinned-model override", async (t) => {
	const f = await fixture(t);
	const worker = (await f.sessions["ensureWorker"](f.id)) as FakeWorker;
	await worker.ready;
	const meta = f.sessions["metas"].get(f.id)!;
	meta.working = true;
	worker.state = "working";
	const drain = gate();
	worker.drain = drain.promise;
	t.after(() => drain.resolve());
	const changing = f.sessions.continueModel(f.id, same, f.models, "high");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(worker.closed, false);
	await assert.rejects(f.sessions.send(f.id, "racing writer"), Conflict);
	await assert.rejects(f.sessions.continueModel(f.id, other, f.models), Conflict);
	assert.throws(() => f.sessions.assertWritable(f.id), Conflict);
	drain.resolve();
	const changed = await changing;
	assert.equal(changed.id, f.id);
	assert.equal(changed.continuationOf, undefined);
	assert.equal(changed.model, same);
	assert.equal(worker.closed, true);
	assert.equal(worker.commands[0]?.type, "continuation.pause");
	assert.equal(f.workers.at(-1)!.spec.continuationModel?.model, same);
	assert.equal(f.workers.at(-1)!.spec.continuationModel?.thinking, "high");
	assert.equal(f.workers.at(-1)!.spec.storageDir, join(f.dir, "durable"));
});

test("cross-provider continuation creates only a fresh handoff and fences all old writers across restart", async (t) => {
	const f = await fixture(t);
	const meta = f.sessions["metas"].get(f.id)!;
	const cwd = join(f.dir, "workspace");
	await mkdir(cwd);
	meta.cwd = cwd;
	meta.workspace = {
		source: f.home,
		jj: false,
		base: "origin/main",
		branch: "task",
		upstream: "https://github.com/octo/repo.git",
	};
	meta.agentPullRequests = [pr];
	meta.boundPullRequests = [pr];
	meta.unboundPullRequests = ["https://github.com/octo/repo/pull/2"];
	meta.subscriptionPolicy = { version: 1, windows: [], forced: ["OLD FORCE"] };
	meta.controlPermission = { authorizationId: "grant", level: "implement" };
	await f.sessions["save"](meta);
	const source = (await f.sessions["ensureWorker"](f.id)) as FakeWorker;
	meta.subagents = [
		{
			name: "parser",
			task: "Finish the parser integration",
			state: "working",
			createdAt: 1,
			cwd,
			storage: join(f.dir, "durable", "subagent-runs", "parser"),
			conversationId: "child",
		},
	];
	const changed = await f.sessions.continueModel(f.id, other, f.models);
	await f.sessions["starting"].get(changed.id);
	assert.notEqual(changed.id, f.id);
	assert.equal(changed.continuationOf, f.id);
	assert.equal(changed.cwd, cwd, "never relocate a jj/Git workspace");
	assert.equal(f.sessions.get(f.id)?.continuedTo, changed.id);
	assert.equal(source.closed, true);
	assert.equal(f.sessions.pullRequestOwner(pr), changed.id);
	const target = f.workers.at(-1)!;
	assert.deepEqual(target.spec.pilot?.controlPermission, meta.controlPermission);
	assert.deepEqual(f.sessions["metas"].get(changed.id)?.controlPermission, meta.controlPermission);
	assert.notEqual(target.spec.storageDir, source.spec.storageDir);
	assert.equal(target.spec.continuationModel, undefined);
	const input = target.commands.find((command) => command.type === "input");
	assert.ok(input?.type === "input" && input.content.includes("Fix the tests"));
	assert.ok(input?.type === "input" && !input.content.includes("COMPACTION SECRET"));
	assert.ok(
		target.commands.some((command) => command.type === "input" && command.content === "Then update docs"),
		"queued input is a separate complete user message",
	);
	assert.ok(input?.type === "input" && input.content.includes("Finish the parser integration"));
	assert.ok(input?.type === "input" && input.content.includes("Child parser complete, integration tests unfinished"));
	assert.ok(input?.type === "input" && !input.content.includes("CHILD PRIVATE"));
	assert.equal(f.sessions.get(f.id)?.subagents?.[0]?.retired, true);
	assert.equal(f.sessions.get(f.id)?.subagents?.[0]?.state, "idle");
	assert.equal(f.sessions.get(changed.id)?.subagents, undefined);
	assert.deepEqual(f.sessions["metas"].get(changed.id)?.subscriptionPolicy?.forced, []);
	assert.doesNotThrow(() => f.sessions["assertOwnedWorkspace"](f.sessions["metas"].get(changed.id)!));
	assert.throws(() => f.sessions.assertWritable(f.id), Conflict);
	await assert.rejects(f.sessions.send(f.id, "no"), Conflict);
	await assert.rejects(f.sessions.changeModel(f.id, same, f.models), Conflict);
	await assert.rejects(f.sessions.compact(f.id), Conflict);
	await assert.rejects(f.sessions.reclaimWorkspace(f.id), Conflict);
	assert.equal(f.sessions.canSendNotice(f.id), false);
	assert.equal(
		(await f.sessions.continueModel(f.id, other, f.models)).id,
		changed.id,
		"HTTP retry returns the same chat",
	);
	await f.sessions.archive(f.id);
	await f.sessions.restore(f.id);
	assert.equal(f.sessions.get(f.id)?.continuedTo, changed.id);
	await f.sessions.shutdown();
	const before = f.workers.length;
	const reopened = await f.manager();
	assert.equal(reopened.get(f.id)?.continuedTo, changed.id);
	assert.equal(reopened.pullRequestOwner(pr), changed.id);
	assert.ok(f.workers.slice(before).every((worker) => worker.spec.sessionId !== f.id));
	await assert.rejects(reopened.send(f.id, "still no"), Conflict);
});

test("a virtual configured provider cannot reuse history just because its latest physical provider matches", async (t) => {
	const f = await fixture(t);
	const worker = await f.sessions["ensureWorker"](f.id);
	await worker.ready;
	f.sessions["metas"].get(f.id)!.model = "router/virtual";
	const changed = await f.sessions.continueModel(f.id, same, f.models);
	assert.notEqual(changed.id, f.id);
	assert.equal(changed.continuationOf, f.id);
	assert.equal(f.sessions["metas"].get(changed.id)?.continuationModel, undefined);
});

for (const timing of ["before", "during-drain"] as const) {
	test(`continuation refuses to terminate live background jobs ${timing}`, async (t) => {
		const f = await fixture(t);
		const worker = (await f.sessions["ensureWorker"](f.id)) as FakeWorker;
		const job = {
			id: "tests",
			name: "Tests",
			state: "running" as const,
			startedAt: 1,
			outputPath: "/tmp/offline-tests",
		};
		if (timing === "before") worker.runningJobs = [job];
		else {
			worker.onDrain = () => {
				worker.runningJobs = [job];
			};
		}
		await assert.rejects(f.sessions.continueModel(f.id, other, f.models), /Finish or stop background jobs/);
		assert.equal(worker.closed, false);
		assert.equal(f.sessions.get(f.id)?.continuedTo, undefined);
		assert.equal(f.sessions.list().length, 1);
	});
}

for (const phase of ["target-metadata", "mission-transaction", "after-mission-transaction"] as const) {
	test(`journal rolls forward after ${phase} crash before either worker may reopen`, async (t) => {
		const f = await fixture(t);
		const store = new MissionStore(join(f.home, "missions.sqlite"));
		f.stores.push(store);
		const mission = store.create({ projectId: "p", title: "Work", tasks: [{ title: "One" }, { title: "Two" }] });
		store.join(f.id, mission.id);
		store.claimStartTasks(mission.id, ["1", "2"], f.id);
		const bridge: SessionMissionBridge = {
			spawnProject: () => "p",
			joinSpawn() {},
			membership: (id) => store.membership(id),
			context: () => undefined,
			call: async () => undefined,
			continueSession: (from, to) => {
				if (phase === "after-mission-transaction") store.continueSession(from, to);
				throw new Error("crash during ownership transaction");
			},
		};
		f.sessions.setMissionBridge(bridge);
		if (phase === "target-metadata") {
			const save = f.sessions["save"].bind(f.sessions);
			f.sessions["save"] = async (meta, ...args) => {
				if (meta.continuationOf) throw new Error("crash before target metadata");
				return save(meta, ...args);
			};
		}
		await assert.rejects(f.sessions.continueModel(f.id, other, f.models), /crash/);
		const targetId = f.sessions.get(f.id)!.continuedTo!;
		assert.ok(targetId);
		assert.equal(f.sessions["metas"].get(targetId)?.continuationPending, true);
		await assert.rejects(f.sessions.send(targetId, "not yet"), Conflict);
		assert.equal(f.workers.length, 0);
		await f.sessions.shutdown();
		const reopened = await f.manager({ ...bridge, continueSession: (from, to) => store.continueSession(from, to) });
		await reopened["starting"].get(targetId);
		assert.equal(store.missionOf(f.id), undefined);
		assert.equal(store.missionOf(targetId), mission.id);
		assert.ok(
			store.detail(mission.id).tasks.every((task) => task.sessionId === targetId && task.status === "in_progress"),
		);
		assert.equal(reopened.get(targetId)?.continuationOf, f.id);
		assert.equal(f.workers.filter((worker) => worker.spec.sessionId === f.id).length, 0);
		await assert.rejects(readFile(join(f.dir, "continuation.json")), { code: "ENOENT" });
	});
}

test("continuation HTTP route validates input and only admits quota-paused chats", async (t) => {
	const f = await fixture(t);
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		f.models,
		new TerminalManager(),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${f.id}/continue-model`;
	const post = (body: unknown) =>
		fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	for (const body of [
		null,
		{},
		[],
		{ model: 1 },
		{ model: " " },
		{ model: other, thinking: null },
		{ model: "missing/model" },
		{ model: other, thinking: "impossible" },
	]) {
		const response = await post(body);
		assert.equal(response.status, 400);
		await response.arrayBuffer();
	}
	t.mock.method(f.sessions, "subscriptionPaused", () => false);
	const denied = await post({ model: other });
	assert.equal(denied.status, 409);
	await denied.arrayBuffer();
	t.mock.method(f.sessions, "subscriptionPaused", () => true);
	const response = await post({ model: other, thinking: "high" });
	assert.equal(response.status, 200);
	const changed = (await response.json()) as SessionSummary;
	assert.equal(changed.continuationOf, f.id);
	assert.equal(changed.model, other);
});
