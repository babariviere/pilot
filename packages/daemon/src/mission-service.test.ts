import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelCommand, KernelPacket, KernelSpec } from "@pilot/kernel";
import type { MissionDetail, ServerMessage, SessionState, SessionSummary } from "@pilot/protocol";
import { WebSocket } from "ws";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import type { PullRequestOptions } from "./pull-requests.ts";
import { createDaemonServer } from "./server.ts";
import { type SessionWorker, SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { legacyGitHub } from "./testing/legacy-github.ts";

class FakeWorker implements SessionWorker {
	ready = Promise.resolve();
	state: SessionState = "idle";
	error?: string;
	busy = false;
	readonly sent: KernelCommand[] = [];
	readonly requests: KernelCommand[] = [];
	readonly spec: KernelSpec;
	readonly onPacket: (packet: KernelPacket) => void;
	constructor(spec: KernelSpec, onPacket: (packet: KernelPacket) => void) {
		this.spec = spec;
		this.onPacket = onPacket;
	}
	send(command: KernelCommand): void {
		this.sent.push(command);
	}
	async request(command: KernelCommand): Promise<void> {
		this.requests.push(command);
	}
	async close(): Promise<void> {}
}

async function until<T>(check: () => T | undefined | false): Promise<T> {
	const deadline = Date.now() + 3_000;
	for (;;) {
		const value = check();
		if (value) return value;
		assert.ok(Date.now() < deadline, "condition did not settle");
		await delay(2);
	}
}

async function fixture(
	t: TestContext,
	pullRequests: PullRequestOptions = {
		runner: async () => {
			throw new Error("GitHub unavailable in fixture");
		},
	},
) {
	const home = await mkdtemp(join(tmpdir(), "pilot-missions-"));
	const projectDir = join(home, "project");
	const otherDir = join(home, "other");
	await mkdir(projectDir);
	await mkdir(otherDir);
	const projects = new ProjectStore(join(home, "data"));
	await projects.load();
	const project = await projects.create({ path: projectDir, workspace: "direct" });
	const other = await projects.create({ path: otherDir, workspace: "direct" });
	const workers = new Map<string, FakeWorker>();
	const sessions = new SessionManager(
		join(home, "data"),
		projects,
		undefined,
		{
			title: async () => undefined,
			worker: (spec, onPacket) => {
				const worker = new FakeWorker(spec, onPacket);
				workers.set(spec.sessionId, worker);
				queueMicrotask(() => onPacket({ type: "ready", model: "test/model", working: false, usage: {} }));
				return worker;
			},
		},
		{ ...pullRequests, ...(pullRequests.runner ? { runner: legacyGitHub(pullRequests.runner) } : {}) },
	);
	const store = new MissionStore(":memory:");
	const service = new MissionService(store, sessions, projects);
	await sessions.load();
	t.after(async () => {
		await sessions.shutdown();
		await Promise.allSettled(sessions["saving"].values());
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	const spawn = async (projectId = project.id) => {
		const session = await sessions.spawn({ projectId, message: "hello", title: "Chat" });
		await until(() => workers.get(session.id));
		await until(() => !sessions["starting"].has(session.id));
		return session;
	};
	return { home, projects, project, other, sessions, store, service, workers, spawn };
}

test("hand-linked PRs poll without a worker, finish after all settle, and respect a racing manual reset", async (t) => {
	const states = new Map([
		[1, "OPEN"],
		[2, "OPEN"],
		[3, "OPEN"],
	]);
	const f = await fixture(t, {
		runner: async (_file, args) => {
			const number = Number(args[2]);
			return JSON.stringify({
				number,
				url: `https://github.com/octo/repo/pull/${number}`,
				title: "PR",
				state: states.get(number),
				isDraft: false,
				headRefName: "external",
				isCrossRepository: true,
				createdAt: "2026-01-01T00:00:00Z",
				mergedAt: states.get(number) === "MERGED" ? "2026-01-02T00:00:00Z" : null,
			});
		},
	});
	const { id } = f.store.create({ projectId: f.project.id, title: "M", tasks: [{ title: "A" }, { title: "B" }] });
	for (const number of [1, 2])
		f.store.addResource(id, { taskId: "1", url: `https://github.com/octo/repo/pull/${number}` });
	f.store.addResource(id, { taskId: "2", url: "https://github.com/octo/repo/pull/3" });
	await until(
		() => f.store.resolveTask(id, "1").status === "in_review" && f.store.resolveTask(id, "2").status === "in_review",
	);
	assert.equal(f.workers.size, 0, "tracking never starts a worker");
	states.set(1, "MERGED");
	const refresh = async () => {
		for (const target of f.sessions["missions"]!.linkedPullRequests!())
			await f.sessions["pullRequests"].refreshLinked(target);
	};
	await refresh();
	assert.equal(f.store.resolveTask(id, "1").status, "in_review");
	f.store.updateTask(id, f.store.resolveTask(id, "2").id, { status: "in_progress" });
	states.set(2, "CLOSED");
	states.set(3, "MERGED");
	await refresh();
	assert.equal(f.store.resolveTask(id, "1").status, "done");
	assert.equal(f.store.resolveTask(id, "2").status, "in_progress");
	assert.equal(
		f.store.detail(id).resources.find((resource) => resource.url.endsWith("/3"))?.pullRequest?.state,
		"merged",
	);
});

test("a user reset during an in-flight linked PR lookup wins over its merge result", async (t) => {
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started = false;
	const f = await fixture(t, {
		runner: async () => {
			started = true;
			await waiting;
			return JSON.stringify({
				number: 1,
				url: "https://github.com/octo/repo/pull/1",
				title: "PR",
				state: "MERGED",
				isDraft: false,
				headRefName: "external",
				isCrossRepository: false,
				createdAt: "2026-01-01T00:00:00Z",
				mergedAt: "2026-01-02T00:00:00Z",
			});
		},
	});
	const { id } = f.store.create({ projectId: f.project.id, title: "M", tasks: [{ title: "A" }] });
	f.store.addResource(id, { taskId: "1", url: "https://github.com/octo/repo/pull/1" });
	f.store.updatePullRequest({
		number: 1,
		url: "https://github.com/octo/repo/pull/1",
		title: "PR",
		state: "open",
		checkedAt: 1,
	});
	await until(() => started);
	f.store.updateTask(id, f.store.resolveTask(id, "1").id, { status: "todo" });
	release();
	await until(() => f.store.detail(id).resources[0]?.pullRequest?.state === "merged");
	assert.equal(f.store.resolveTask(id, "1").status, "todo");
});

test("fresh owning-chat discovery links and reconciles PR state through sessions", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const { id } = f.store.create({ projectId: f.project.id, title: "M", tasks: [{ title: "A" }] });
	f.service.join(chat.id, { missionId: id, taskId: "1" });
	const meta = f.sessions["require"](chat.id);
	const pullRequest = {
		number: 42,
		url: "https://github.com/octo/repo/pull/42",
		title: "PR",
		state: "open" as const,
		checkedAt: 1,
	};
	await f.sessions["applyPullRequest"](meta, { pullRequest });
	assert.equal(f.store.resolveTask(id, "1").status, "in_review");
	assert.equal(f.store.detail(id).resources[0]?.pullRequest?.state, "open");
	await f.sessions["applyPullRequest"](meta, {
		pullRequest: { ...pullRequest, state: "merged", mergedAt: Date.now() },
		mergedAt: Date.now(),
	});
	assert.equal(f.store.resolveTask(id, "1").status, "done");
});

test("discovery of several heads links every PR before completing a task", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const { id } = f.store.create({ projectId: f.project.id, title: "M", tasks: [{ title: "A" }] });
	f.service.join(chat.id, { missionId: id, taskId: "1" });
	const pullRequest = {
		number: 42,
		url: "https://github.com/octo/repo/pull/42",
		title: "PR",
		state: "merged" as const,
		checkedAt: 1,
		mergedAt: Date.now(),
	};
	const other = { ...pullRequest, number: 43, url: "https://github.com/octo/repo/pull/43", state: "open" as const };
	// Even a terminal cache copied from a mission-level resource cannot hide the other open head.
	f.store.addResource(id, { url: pullRequest.url });
	f.store.updatePullRequest(pullRequest);
	await f.sessions["applyPullRequest"](f.sessions["require"](chat.id), {
		pullRequest,
		mergedAt: pullRequest.mergedAt,
		others: [other],
	});
	assert.equal(f.store.resolveTask(id, "1").status, "in_review");
	assert.equal(f.store.detail(id).resources.filter((resource) => resource.taskId).length, 2);
});

test("tool task links resolve numbers, appear with tasks, and auto-link each owning task", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const { id } = f.store.create({ projectId: f.project.id, title: "M", tasks: [{ title: "A" }, { title: "B" }] });
	f.service.join(chat.id, { missionId: id, taskId: "1" });
	f.store.claimTask(id, "2", chat.id);
	const url = "https://github.com/octo/repo/pull/42";
	const linked = (await f.service.call(chat.id, "link", { url, taskId: "#1" })) as { taskId: string };
	assert.equal(linked.taskId, f.store.resolveTask(id, "1").id);
	const view = (await f.service.call(chat.id, "tasks", {})) as { tasks: { resources: unknown[] }[] };
	assert.equal(view.tasks[0]!.resources.length, 1);
	const get = (await f.service.call(chat.id, "get", {})) as { tasks: { resources: unknown[] }[] };
	assert.equal(get.tasks[0]!.resources.length, 1);
	f.sessions["missions"]?.pullRequestCreated?.(chat.id, url);
	assert.equal(f.store.detail(id).resources.length, 2);
	assert.ok(f.store.detail(id).resources.every((resource) => resource.taskId));
	await assert.rejects(f.service.call(chat.id, "link", { url, taskId: "missing" }), /Unknown task/);
});

test("Make a mission joins the chat as coordinator and asks it to draft", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const detail = await f.service.create({
		projectId: f.project.id,
		title: "API v2",
		goal: "",
		fromSessionId: chat.id,
	});
	assert.equal(detail.mission.coordinatorSessionId, chat.id);
	assert.equal(f.sessions.get(chat.id)?.missionId, detail.mission.id);
	const worker = f.workers.get(chat.id)!;
	const draft = await until(() =>
		worker.requests.find(
			(command) => command.type === "input" && command.content.includes("draft the shared mission"),
		),
	);
	assert.ok(draft);
	const context = await until(() =>
		worker.sent.findLast((command) => command.type === "mission.context" && command.context?.coordinator === "self"),
	);
	assert.equal(context.type === "mission.context" && context.context?.title, "API v2");
	assert.deepEqual(
		f.sessions.list({ missionId: detail.mission.id }).map((session) => session.id),
		[chat.id],
	);
	const other = await f.spawn(f.other.id);
	await assert.rejects(
		f.service.create({ projectId: f.project.id, title: "X", fromSessionId: other.id }),
		/another project/,
	);
	assert.throws(() => f.service.join(other.id, { missionId: detail.mission.id }), /its own project/);
});

test("agent calls run against the chat's mission and update its context", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const outsider = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "API v2",
		goal: "Redesign",
		fromSessionId: chat.id,
		draft: false,
	});
	const worker = f.workers.get(chat.id)!;
	const call = async (action: string, args: Record<string, unknown>, target = worker) => {
		const callId = `call-${Math.random()}`;
		target.onPacket({ type: "mission.call", callId, action: action as never, args: args as never });
		const reply = await until(() =>
			target.sent.find((command) => command.type === "mission.result" && command.callId === callId),
		);
		return reply as Extract<KernelCommand, { type: "mission.result" }>;
	};
	const created = await call("task", { title: "Auth endpoints" });
	assert.equal((created.result as { number: number }).number, 1);
	const claimed = await call("claim", { id: "1" });
	assert.equal((claimed.result as { status: string }).status, "in_progress");
	const context = await until(() =>
		worker.sent.findLast(
			(command) => command.type === "mission.context" && command.context?.tasks.some((task) => task.number === 1),
		),
	);
	assert.ok(context);
	const brief = await call("brief", { markdown: "# Spec", expectedRevision: 0 });
	assert.deepEqual(brief.result, { revision: 1 });
	const stale = await call("brief", { markdown: "# Other", expectedRevision: 0 });
	assert.match(stale.error ?? "", /revision conflict/);
	const decision = await call("decide", { text: "IDs are opaque" });
	assert.equal((decision.result as { authorSessionId: string }).authorSessionId, chat.id);
	const got = (await call("get", {})).result as {
		mission: { coordinator: string };
		tasks: Array<{ owner: string }>;
		brief: { outline: string[] };
		decisions: string[];
	};
	assert.equal(got.mission.coordinator, "you");
	assert.equal(got.tasks[0]!.owner, "you");
	assert.deepEqual(got.brief.outline, ["# Spec"]);
	assert.deepEqual(got.decisions, ["IDs are opaque"]);
	const denied = await call("get", {}, f.workers.get(outsider.id)!);
	assert.match(denied.error ?? "", /not part of a mission/);
	await call("task", { title: "Docs" });
	const started = (await call("start", { id: "2" })).result as unknown as SessionSummary;
	assert.equal(started.missionId, mission.id);
	const memberWorker = await until(() => f.workers.get(started.id));
	const sent = await call("send", { targetSessionId: started.id, message: "Cover error cases" });
	assert.deepEqual(sent.result, { sessionId: started.id, sent: true });
	await until(() =>
		memberWorker.requests.find((command) => command.type === "input" && command.content === "Cover error cases"),
	);
	const status = await call("status", {});
	assert.ok((status.result as { members: Array<{ id: string }> }).members.some((member) => member.id === started.id));
	const refused = await call("status", {}, memberWorker);
	assert.match(refused.error ?? "", /Only the mission coordinator/);
	assert.equal(
		f.store.detail(mission.id).events.some((event) => event.sessionId === chat.id),
		true,
	);
});

test("spawn joins a mission before the first input, uses its project and leaves tasks unclaimed", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "API v2",
		goal: "Redesign",
		tasks: [{ title: "Auth" }],
	});
	f.store.addDecision(mission.id, "IDs are opaque");
	for (const mode of ["build", "ask"] as const) {
		const session = await f.sessions.spawn({ missionId: mission.id, message: "Tackle tasks 1 to 5", mode });
		assert.equal(session.projectId, f.project.id);
		assert.equal(session.missionId, mission.id);
		assert.equal(session.cwd, f.project.path);
		const worker = await until(() => f.workers.get(session.id));
		await until(() => worker.requests.find((command) => command.type === "input"));
		assert.equal(worker.spec.mission?.id, mission.id);
		assert.equal(worker.spec.mission?.goal, "Redesign");
		assert.deepEqual(worker.spec.mission?.decisions, ["IDs are opaque"]);
		assert.deepEqual(worker.spec.mission?.tasks, []);
		assert.equal(f.store.tasks(mission.id)[0]?.sessionId, undefined);
	}
});

test("spawn rejects unknown, inactive and incompatible missions without creating a chat", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({ projectId: f.project.id, title: "M" });
	await assert.rejects(f.sessions.spawn({ missionId: "unknown", message: "hello" }), /Unknown mission/);
	await assert.rejects(f.sessions.spawn({ missionId: "", message: "hello" }), /non-empty string/);
	await assert.rejects(
		f.sessions.spawn({ missionId: mission.id, projectId: f.other.id, message: "hello" }),
		/own project/,
	);
	await assert.rejects(
		f.sessions.spawn({ missionId: mission.id, cwd: f.project.path, message: "hello" }),
		/cwd override/,
	);
	for (const status of ["archived", "done"] as const) {
		f.store.update(mission.id, { status });
		await assert.rejects(f.sessions.spawn({ missionId: mission.id, message: "hello" }), /Reopen the mission/);
	}
	assert.equal(f.sessions.list().length, 0);
	assert.equal(f.workers.size, 0);
	assert.deepEqual(f.store.members(mission.id), []);
});

test("spawn rechecks mission admission after async preparation and never starts a rejected chat", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({ projectId: f.project.id, title: "M" });
	const spawn = f.sessions.spawn({ missionId: mission.id, message: "hello" });
	f.store.update(mission.id, { status: "done" });
	await assert.rejects(spawn, /Reopen the mission/);
	assert.equal(f.sessions.list().length, 0);
	assert.equal(f.workers.size, 0);
	assert.deepEqual(f.store.members(mission.id), []);
});

test("Start chat spawns a member chat that owns the task; leaving releases it", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({ projectId: f.project.id, title: "M", tasks: [{ title: "Auth" }] });
	const task = f.store.tasks(mission.id)[0]!;
	const session = await f.service.startTask(mission.id, task.id, { message: "Focus on login" });
	assert.equal(session.missionId, mission.id);
	assert.equal(session.title, "Auth");
	assert.equal(f.store.task(mission.id, task.id).sessionId, session.id);
	await assert.rejects(f.service.startTask(mission.id, task.id), /already claimed/);
	const worker = await until(() => f.workers.get(session.id));
	const input = await until(() => worker.requests.find((command) => command.type === "input"));
	assert.match(input.type === "input" ? input.content : "", /task #1: Auth[\s\S]*Focus on login/);
	const left = f.service.leave(session.id);
	assert.equal(left.missionId, undefined);
	assert.equal(f.store.task(mission.id, task.id).sessionId, undefined);
});

test("coordinator actions check the current role on every call before causing side effects", async (t) => {
	const f = await fixture(t);
	const coordinator = await f.spawn();
	const member = await f.spawn();
	const outsider = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: coordinator.id,
		draft: false,
		tasks: [{ title: "Auth" }],
	});
	f.service.join(member.id, { missionId: mission.id });
	const actions = [
		["start", { id: "1" }],
		["send", { targetSessionId: coordinator.id, message: "Continue" }],
		["status", {}],
	] as const;
	const before = f.workers.get(coordinator.id)!.requests.length;
	for (const [action, args] of actions) {
		await assert.rejects(f.service.call(member.id, action, args), /Only the mission coordinator/);
		await assert.rejects(f.service.call(outsider.id, action, args), /not part of a mission/);
	}
	assert.equal(f.sessions.list().length, 3);
	assert.equal(f.store.resolveTask(mission.id, "1").sessionId, undefined);
	assert.equal(f.workers.get(coordinator.id)!.requests.length, before);
	f.store.update(mission.id, { coordinatorSessionId: member.id });
	for (const [action, args] of actions)
		await assert.rejects(f.service.call(coordinator.id, action, args), /Only the mission coordinator/);
	await f.service.call(member.id, "status", {});
	f.store.update(mission.id, { coordinatorSessionId: null });
	for (const [action, args] of actions)
		await assert.rejects(f.service.call(member.id, action, args), /Only the mission coordinator/);
});

test("coordinator start reuses Start chat with task IDs or numbers and validates admission", async (t) => {
	const f = await fixture(t);
	const coordinator = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: coordinator.id,
		draft: false,
		tasks: [{ title: "Auth", body: "Add login" }, { title: "Docs" }],
	});
	const startTask = t.mock.method(f.service, "startTask");
	for (const args of [{}, { id: 1 }, { id: " " }])
		await assert.rejects(f.service.call(coordinator.id, "start", args), /requires the task id or number/);
	await assert.rejects(f.service.call(coordinator.id, "start", { id: "unknown" }), /Unknown task/);
	await assert.rejects(f.service.call(coordinator.id, "start", { id: "1", message: 42 }), /message must be a string/);
	const first = (await f.service.call(coordinator.id, "start", {
		id: "#1",
		message: "Focus on login",
	})) as SessionSummary;
	assert.deepEqual(startTask.mock.calls.at(-1)?.arguments, [mission.id, "#1", { message: "Focus on login" }]);
	assert.equal(first.missionId, mission.id);
	assert.equal(first.projectId, f.project.id);
	assert.equal(first.title, "Auth");
	assert.equal(f.store.resolveTask(mission.id, "1").sessionId, first.id);
	assert.equal(f.store.resolveTask(mission.id, "1").status, "in_progress");
	const worker = await until(() => f.workers.get(first.id));
	const input = await until(() => worker.requests.find((command) => command.type === "input"));
	assert.match(input.type === "input" ? input.content : "", /task #1: Auth[\s\S]*Add login[\s\S]*Focus on login/);
	assert.equal(f.service.context(first.id)?.tasks[0]?.number, 1);
	await assert.rejects(f.service.call(coordinator.id, "start", { id: "1" }), /already claimed/);
	const taskId = f.store.resolveTask(mission.id, "2").id;
	for (const status of ["done", "archived"] as const) {
		f.store.update(mission.id, { status });
		await assert.rejects(f.service.call(coordinator.id, "start", { id: taskId }), /Reopen the mission/);
	}
	assert.equal(f.sessions.list().length, 2);
	f.store.update(mission.id, { status: "active" });
	const second = (await f.service.call(coordinator.id, "start", { id: taskId })) as SessionSummary;
	assert.equal(f.store.resolveTask(mission.id, "2").sessionId, second.id);
});

test("coordinator send admits follow-ups only to member chats and propagates delivery errors", async (t) => {
	const f = await fixture(t);
	const coordinator = await f.spawn();
	const member = await f.spawn();
	const outsider = await f.spawn();
	const foreign = await f.spawn(f.other.id);
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: coordinator.id,
		draft: false,
	});
	f.service.join(member.id, { missionId: mission.id });
	for (const targetSessionId of [outsider.id, foreign.id, "unknown"])
		await assert.rejects(
			f.service.call(coordinator.id, "send", { targetSessionId, message: "Continue" }),
			/not in this mission/,
		);
	for (const targetSessionId of [undefined, 1, " "])
		await assert.rejects(
			f.service.call(coordinator.id, "send", { targetSessionId, message: "Continue" }),
			/requires targetSessionId/,
		);
	for (const message of [undefined, 1, " "])
		await assert.rejects(
			f.service.call(coordinator.id, "send", { targetSessionId: member.id, message }),
			/requires message/,
		);
	const worker = f.workers.get(member.id)!;
	await until(() => worker.requests.find((command) => command.type === "input"));
	for (const state of ["idle", "working"] as const) {
		worker.state = state;
		worker.onPacket({ type: "working", working: state === "working" });
		const message = `Continue while ${state}`;
		const result = await f.service.call(coordinator.id, "send", { targetSessionId: member.id, message });
		assert.deepEqual(result, { sessionId: member.id, sent: true });
		const input = await until(() =>
			worker.requests.find((command) => command.type === "input" && command.content === message),
		);
		assert.ok(input?.type === "input");
		assert.equal(input.content, message);
		assert.equal(input.mode, "followUp");
	}
	worker.state = "idle";
	worker.onPacket({ type: "working", working: false });
	await until(() => !f.sessions["starting"].has(member.id));
	await f.sessions.archive(member.id);
	await assert.rejects(
		f.service.call(coordinator.id, "send", { targetSessionId: member.id, message: "Continue" }),
		/Restore the archived session/,
	);
	f.service.leave(member.id);
	await assert.rejects(
		f.service.call(coordinator.id, "send", { targetSessionId: member.id, message: "Continue" }),
		/not in this mission/,
	);
	t.mock.method(f.sessions, "send", async () => {
		throw new Error("Delivery failed");
	});
	await assert.rejects(
		f.service.call(coordinator.id, "send", { targetSessionId: coordinator.id, message: "Continue" }),
		/Delivery failed/,
	);
});

test("coordinator status includes archived and parked members, outcomes and tasks without waking workers", async (t) => {
	const f = await fixture(t);
	const coordinator = await f.spawn();
	const working = await f.spawn();
	const failed = await f.spawn();
	const archived = await f.spawn();
	const parked = await f.spawn();
	const outsider = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: coordinator.id,
		draft: false,
		tasks: [{ title: "Auth" }, { title: "Docs" }],
	});
	for (const member of [working, failed, archived, parked]) {
		f.service.join(member.id, { missionId: mission.id });
		await until(() => f.workers.get(member.id)!.requests.find((command) => command.type === "input"));
	}
	f.service.join(working.id, { missionId: mission.id, taskId: "1" });
	f.service.join(failed.id, { missionId: mission.id, taskId: "2" });
	f.store.updateTask(mission.id, f.store.resolveTask(mission.id, "2").id, { status: "blocked" });
	f.workers.get(working.id)!.state = "working";
	f.workers.get(working.id)!.onPacket({ type: "working", working: true });
	f.workers.get(failed.id)!.state = "failed";
	f.workers.get(failed.id)!.error = "Model unavailable";
	f.workers.get(failed.id)!.onPacket({
		type: "working",
		working: false,
		completion: { outcome: "failed", outcomeAt: 42, outcomeReason: "Model unavailable" },
	});
	f.workers.get(archived.id)!.onPacket({
		type: "working",
		working: false,
		completion: { outcome: "done", outcomeAt: 43 },
	});
	await f.sessions.archive(archived.id);
	f.workers.get(parked.id)!.onPacket({
		type: "working",
		working: false,
		completion: { outcome: "stopped", outcomeAt: 44 },
	});
	await f.sessions["unparked"](parked.id);
	f.sessions["workers"].delete(parked.id);
	const before = f.sessions["workers"].size;
	const requests = [...f.workers.values()].map((worker) => worker.requests.length);
	const events = f.store.events(mission.id);
	const result = (await f.service.call(coordinator.id, "status", {})) as { members: Array<Record<string, unknown>> };
	assert.equal(result.members.length, 5);
	assert.ok(!result.members.some((member) => member.id === outsider.id));
	const members = new Map(result.members.map((member) => [member.id, member]));
	assert.equal(members.get(coordinator.id)?.coordinator, true);
	assert.equal(members.get(working.id)?.coordinator, false);
	assert.equal(members.get(working.id)?.state, "working");
	assert.deepEqual(members.get(working.id)?.tasks, [{ number: 1, title: "Auth", status: "in_progress" }]);
	assert.equal(members.get(failed.id)?.state, "failed");
	assert.equal(members.get(failed.id)?.outcome, "failed");
	assert.equal(members.get(failed.id)?.outcomeAt, 42);
	assert.equal(members.get(failed.id)?.outcomeReason, "Model unavailable");
	assert.equal(members.get(failed.id)?.error, "Model unavailable");
	assert.deepEqual(members.get(failed.id)?.tasks, [{ number: 2, title: "Docs", status: "blocked" }]);
	assert.equal(members.get(archived.id)?.state, "idle");
	assert.equal(members.get(archived.id)?.outcome, "done");
	assert.equal(typeof members.get(archived.id)?.archivedAt, "number");
	assert.equal(members.get(parked.id)?.state, "parked");
	assert.equal(members.get(parked.id)?.outcome, "stopped");
	assert.deepEqual(members.get(parked.id)?.tasks, []);
	assert.equal(f.sessions["workers"].size, before);
	assert.deepEqual(
		[...f.workers.values()].map((worker) => worker.requests.length),
		requests,
	);
	assert.deepEqual(f.store.events(mission.id), events);
});

test("a rejected task claim does not move a chat or release its previous work", async (t) => {
	const f = await fixture(t);
	const owner = await f.spawn();
	const candidate = await f.spawn();
	const previous = await f.service.create({
		projectId: f.project.id,
		title: "Previous",
		fromSessionId: candidate.id,
		draft: false,
		tasks: [{ title: "Existing work" }],
	});
	f.service.join(candidate.id, { missionId: previous.mission.id, taskId: "1" });
	const target = await f.service.create({
		projectId: f.project.id,
		title: "Target",
		tasks: [{ title: "Claimed work" }],
	});
	f.service.join(owner.id, { missionId: target.mission.id, taskId: "1" });
	const events = f.store.events(previous.mission.id);
	assert.throws(() => f.service.join(candidate.id, { missionId: target.mission.id, taskId: "1" }), /already claimed/);
	assert.equal(f.store.missionOf(candidate.id), previous.mission.id);
	assert.equal(f.store.require(previous.mission.id).coordinatorSessionId, candidate.id);
	assert.equal(f.store.tasks(previous.mission.id)[0]?.sessionId, candidate.id);
	assert.deepEqual(f.store.events(previous.mission.id), events);
	assert.deepEqual(f.store.members(target.mission.id), [owner.id]);
	// Repeating an existing owner's join remains idempotent.
	f.service.join(owner.id, { missionId: target.mission.id, taskId: "1" });
});

test("HTTP routes and WebSocket mission subscriptions", async (t) => {
	const f = await fixture(t);
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		new ModelCatalog(f.home),
		terminals,
		{ service: f.service, store: f.store },
	);
	let ws: WebSocket | undefined;
	// After hooks run in registration order: close the socket before the server waits for it.
	t.after(async () => {
		if (ws && ws.readyState !== ws.CLOSED) {
			const closed = once(ws, "close");
			ws.close();
			await closed;
		}
		terminals.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	const api = (path: string, init?: RequestInit) =>
		fetch(`http://127.0.0.1:${port}/api${path}`, {
			...init,
			headers: init?.body ? { "content-type": "application/json" } : {},
		});
	const created = await api("/missions", {
		method: "POST",
		body: JSON.stringify({ projectId: f.project.id, title: "API v2", goal: "Redesign" }),
	});
	assert.equal(created.status, 201);
	const detail = (await created.json()) as MissionDetail;
	const id = detail.mission.id;

	ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as ServerMessage));
	await once(ws, "open");
	await until(() => messages.find((message) => message.type === "missions"));
	ws.send(JSON.stringify({ type: "mission.subscribe", missionId: id }));
	await until(() => messages.find((message) => message.type === "mission"));

	assert.equal((await api(`/missions?projectId=${f.project.id}`).then((r) => r.json()))[0].id, id);
	const put = await api(`/missions/${id}/brief`, {
		method: "PUT",
		body: JSON.stringify({ markdown: "# Spec", expectedRevision: 0 }),
	});
	assert.equal(put.status, 200);
	const stale = await api(`/missions/${id}/brief`, {
		method: "PUT",
		body: JSON.stringify({ markdown: "# Other", expectedRevision: 0 }),
	});
	assert.equal(stale.status, 409);
	await stale.arrayBuffer();
	const pushed = await until(() =>
		messages.findLast((message) => message.type === "mission" && message.mission.brief?.revision === 1),
	);
	assert.ok(pushed);
	assert.equal((await api(`/missions/${id}/brief?revision=1`).then((r) => r.json())).markdown, "# Spec");
	const task = await api(`/missions/${id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Auth" }) });
	assert.equal(task.status, 201);
	const taskId = ((await task.json()) as { id: string }).id;
	const patched = await api(`/missions/${id}/tasks/${taskId}`, {
		method: "PATCH",
		body: JSON.stringify({ status: "blocked" }),
	});
	assert.equal(((await patched.json()) as { status: string }).status, "blocked");
	const resource = await api(`/missions/${id}/resources`, {
		method: "POST",
		body: JSON.stringify({ url: "https://github.com/o/r/pull/3", taskId }),
	});
	const resourceBody = (await resource.json()) as { kind: string; taskId: string; id: string };
	assert.equal(resourceBody.kind, "github.pr");
	assert.equal(resourceBody.taskId, taskId);
	const unlinked = await api(`/missions/${id}/resources/${resourceBody.id}`, { method: "DELETE" });
	assert.equal(unlinked.status, 200);
	await unlinked.arrayBuffer();
	const decision = await api(`/missions/${id}/decisions`, { method: "POST", body: JSON.stringify({ text: "D" }) });
	assert.equal(decision.status, 201);
	await decision.arrayBuffer();
	const update = await api(`/missions/${id}/events`, {
		method: "POST",
		body: JSON.stringify({ text: "Halfway", health: "at_risk" }),
	});
	assert.equal(update.status, 201);
	await update.arrayBuffer();
	const chat = await f.spawn();
	const joined = await api(`/sessions/${chat.id}/mission`, {
		method: "PUT",
		body: JSON.stringify({ missionId: id, taskId }),
	});
	assert.equal(((await joined.json()) as SessionSummary).missionId, id);
	assert.equal(f.store.task(id, taskId).sessionId, chat.id);
	const sessionsInMission = (await api(`/sessions?missionId=${id}`).then((r) => r.json())) as SessionSummary[];
	assert.deepEqual(
		sessionsInMission.map((session) => session.id),
		[chat.id],
	);
	const spawned = await api("/sessions", {
		method: "POST",
		body: JSON.stringify({ missionId: id, message: "Tackle the open tasks" }),
	});
	assert.equal(spawned.status, 201);
	const dedicated = (await spawned.json()) as SessionSummary;
	assert.equal(dedicated.projectId, f.project.id);
	assert.equal(dedicated.missionId, id);
	const dedicatedWorker = await until(() => f.workers.get(dedicated.id));
	assert.equal(dedicatedWorker.spec.mission?.id, id);
	assert.deepEqual(dedicatedWorker.spec.mission?.tasks, []);
	const unknownSpawn = await api("/sessions", {
		method: "POST",
		body: JSON.stringify({ missionId: "nope", message: "hello" }),
	});
	assert.equal(unknownSpawn.status, 404);
	await unknownSpawn.arrayBuffer();
	for (const status of ["done", "archived"] as const) {
		f.store.update(id, { status });
		const inactiveSpawn = await api("/sessions", {
			method: "POST",
			body: JSON.stringify({ missionId: id, message: "hello" }),
		});
		assert.equal(inactiveSpawn.status, 409);
		await inactiveSpawn.arrayBuffer();
	}
	const missing = await api("/missions/nope");
	assert.equal(missing.status, 404);
	await missing.arrayBuffer();
	const removed = await api(`/missions/${id}`, { method: "DELETE" });
	assert.equal(removed.status, 200);
	await removed.arrayBuffer();
	assert.equal(f.sessions.get(chat.id)?.missionId, undefined);
});
