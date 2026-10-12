import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { KernelCommand, KernelPacket, KernelSpec } from "@pilot/kernel";
import type { MissionDetail, ServerMessage, SessionState, SessionSummary } from "@pilot/protocol";
import { WebSocket } from "ws";
import { MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import type { PullRequestOptions } from "./pull-requests.ts";
import { createDaemonServer } from "./server.ts";
import { CommandRejected, type SessionWorker, SessionManager } from "./sessions.ts";
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
	t.mock.method(sessions, "selectTaskModel", async (_cwd: string, model?: string, thinking?: string) => ({
		model: model ?? "test/model",
		thinking: thinking ?? "medium",
	}));
	const service = new MissionService(store, sessions, projects);
	await sessions.load();
	t.after(async () => {
		await service.notices.stop();
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

test("get keeps recent user notes visible beyond the activity window for every member", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	const outsider = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
	});
	f.service.join(member.id, { missionId: mission.id });
	type Note = { kind: string; text: string; by: string; at: string; health?: string };
	const get = async (id: string) =>
		(await f.service.call(id, "get", {})) as { recentUserNotes: Note[]; recentActivity: Note[] };
	assert.deepEqual((await get(lead.id)).recentUserNotes, []);
	const update = f.store.log(mission.id, { text: "Keep the composer", health: "on_track" });
	const handoff = f.store.log(mission.id, { kind: "handoff", text: "Next: verify agent context" });
	const other = f.store.create({ projectId: f.project.id, title: "Other" });
	f.store.log(other.id, { text: "Not for this group" });
	for (let i = 0; i < 60; i++) f.store.update(mission.id, { goal: `Goal ${i}` });
	await f.service.call(member.id, "log", { text: "Agent update" });
	await f.service.call(lead.id, "log", { kind: "handoff", text: "Agent handoff" });
	const expected = [
		{ kind: "handoff", text: handoff.text, by: "user", at: new Date(handoff.at).toISOString() },
		{ kind: "update", text: update.text, by: "user", at: new Date(update.at).toISOString(), health: "on_track" },
	];
	for (const id of [lead.id, member.id]) {
		const result = await get(id);
		assert.deepEqual(result.recentUserNotes, expected);
		assert.equal(result.recentActivity.length, 15);
		assert.ok(result.recentActivity.every((event) => !expected.some((note) => note.text === event.text)));
	}
	for (let i = 0; i < 20; i++) f.store.log(mission.id, { text: `User note ${i}` });
	assert.deepEqual(
		(await get(member.id)).recentUserNotes.map((note) => note.text),
		Array.from({ length: 15 }, (_, i) => `User note ${19 - i}`),
	);
	await assert.rejects(get(outsider.id), /not part of a mission/);
});

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

test("member settlements wake only an idle lead with a guarded follow-up and no user-activity reset", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	const mission = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
	});
	f.store.addTask(mission.mission.id, { title: "Pagination" });
	f.service.join(member.id, { missionId: mission.mission.id, taskId: "1" });
	f.service.notices.start();
	const worker = f.workers.get(lead.id)!;
	const memberWorker = f.workers.get(member.id)!;
	const meta = f.sessions["require"](lead.id);
	const before = {
		updatedAt: meta.updatedAt,
		lastUserMessageAt: meta.lastUserMessageAt,
		prFollowUp: { ...meta.prFollowUp },
	};
	worker.busy = true;
	memberWorker.onPacket({ type: "working", working: true });
	memberWorker.onPacket({ type: "working", working: false, completion: { outcome: "done", outcomeAt: 1 } });
	const now = Date.now() + 120_000;
	t.mock.method(Date, "now", () => now);
	await f.service.notices.flush(now);
	assert.equal(f.store.pendingNotice(mission.mission.id), undefined);
	assert.equal(meta.pending?.length ?? 0, 0);
	worker.busy = false;
	await f.service.notices.flush(now);
	const inputs = worker.requests.filter(
		(command) => command.type === "input" && command.requestId.startsWith("mission-notice:"),
	);
	assert.equal(inputs.length, 1);
	assert.equal(inputs[0]!.type, "input");
	if (inputs[0]!.type !== "input") throw new Error("expected input");
	assert.equal(inputs[0]!.onlyIfIdle, true);
	assert.equal(inputs[0]!.mode, "followUp");
	assert.match(inputs[0]!.content, /#1 Pagination: chat finished/);
	assert.deepEqual(
		{ updatedAt: meta.updatedAt, lastUserMessageAt: meta.lastUserMessageAt, prFollowUp: { ...meta.prFollowUp } },
		before,
	);
	memberWorker.onPacket({
		type: "ready",
		model: "test/model",
		usage: {},
		working: false,
		completion: { outcome: "done", outcomeAt: 1 },
	});
	await f.service.notices.flush(now);
	assert.equal(
		worker.requests.filter((command) => command.type === "input" && command.requestId.startsWith("mission-notice:"))
			.length,
		1,
	);
});

test("kernel idle rejection leaves the frozen notice pending, without failing the chat", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const detail = await f.service.create({ projectId: f.project.id, title: "M", fromSessionId: lead.id, draft: false });
	f.service.notices.start();
	f.store.addComment(detail.mission.id, { text: "review this" });
	const worker = f.workers.get(lead.id)!;
	const request = worker.request.bind(worker);
	let reject = true;
	worker.request = async (command) => {
		await request(command);
		if (reject && command.type === "input") throw new CommandRejected("busy", "busy");
	};
	const now = Date.now() + 30_000;
	await f.service.notices.flush(now);
	const notice = f.store.pendingNotice(detail.mission.id)!;
	assert.ok(notice);
	assert.equal(f.sessions["require"](lead.id).inputError, undefined);
	assert.deepEqual(f.sessions["require"](lead.id).pending, []);
	reject = false;
	await f.service.notices.flush(now);
	assert.equal(f.store.pendingNotice(detail.mission.id), undefined);
	assert.equal((worker.requests.at(-1) as Extract<KernelCommand, { requestId: string }>).requestId, notice.requestId);
});

test("uncertain notice admission retries the original payload and ID before delivering newer events", async (t) => {
	t.mock.method(console, "warn", () => {});
	const f = await fixture(t);
	const lead = await f.spawn();
	const detail = await f.service.create({ projectId: f.project.id, title: "M", fromSessionId: lead.id, draft: false });
	f.service.notices.start();
	f.store.addComment(detail.mission.id, { text: "first event" });
	const worker = f.workers.get(lead.id)!;
	const accepted = new Set<string>();
	const request = worker.request.bind(worker);
	let loseAck = true;
	worker.request = async (command) => {
		await request(command);
		if ("requestId" in command) accepted.add(command.requestId);
		if (loseAck) throw new Error("ack lost");
	};
	const now = Date.now() + 120_000;
	await f.service.notices.flush(now);
	const notice = f.store.pendingNotice(detail.mission.id)!;
	const pending = [...f.sessions["require"](lead.id).pending!];
	assert.equal(pending[0]!.requestId, notice.requestId);
	f.store.addComment(detail.mission.id, { text: "later event" });
	loseAck = false;
	await f.service.notices.flush(now);
	assert.equal(accepted.size, 1);
	assert.deepEqual(worker.requests.at(-1), pending[0]);
	await f.service.notices.flush(now);
	assert.equal(accepted.size, 2);
	const last = worker.requests.at(-1)!;
	if (last.type !== "input") throw new Error("expected input");
	assert.match(last.content, /later event/);
	assert.doesNotMatch(last.content, /first event/);
});

test("daemon restart replays a durable notice once with the same request ID", async (t) => {
	t.mock.method(console, "warn", () => {});
	const f = await fixture(t);
	const lead = await f.spawn();
	const detail = await f.service.create({ projectId: f.project.id, title: "M", fromSessionId: lead.id, draft: false });
	f.service.notices.start();
	f.store.addComment(detail.mission.id, { text: "restart-safe update" });
	const accepted = new Set<string>();
	const attempts: KernelCommand[] = [];
	f.workers.get(lead.id)!.request = async (command) => {
		attempts.push(command);
		if ("requestId" in command) accepted.add(command.requestId);
		throw new Error("acknowledgement lost");
	};
	const now = Date.now() + 30_000;
	await f.service.notices.flush(now);
	assert.equal(accepted.size, 1);
	const notice = f.store.pendingNotice(detail.mission.id)!;
	await f.service.notices.stop();
	await f.sessions.shutdown();
	const workerFactory = f.sessions["factories"].worker!;
	const reopened = new SessionManager(
		join(f.home, "data"),
		f.projects,
		undefined,
		{
			...f.sessions["factories"],
			worker: (spec, onPacket, onExit) => {
				const worker = workerFactory(spec, onPacket, onExit);
				worker.request = async (command) => {
					attempts.push(command);
					accepted.add(command.requestId);
				};
				return worker;
			},
		},
		{
			runner: async () => {
				throw new Error("GitHub unavailable");
			},
		},
	);
	const service = new MissionService(f.store, reopened, f.projects);
	try {
		await reopened.load();
		await until(() => !reopened["starting"].has(lead.id));
		assert.equal(reopened["require"](lead.id).pending?.length ?? 0, 0);
		service.notices.start();
		await service.notices.flush(now);
		assert.equal(accepted.size, 1, "all delivery paths retry the same durable submission");
		assert.equal(attempts.length, 3, "initial delivery, session-outbox replay, then notice acknowledgement recovery");
		assert.ok(
			attempts.every(
				(attempt) => attempt.type === "input" && attempt.requestId === notice.requestId && attempt.onlyIfIdle,
			),
		);
		assert.deepEqual(f.store.noticeDeadlines(now), []);
	} finally {
		await service.notices.stop();
		await reopened.shutdown();
	}
});

test("role and active-state changes during persistence revoke notice delivery", async (t) => {
	for (const change of ["role", "inactive"] as const) {
		const f = await fixture(t);
		const lead = await f.spawn();
		const member = await f.spawn();
		const detail = await f.service.create({
			projectId: f.project.id,
			title: "M",
			fromSessionId: lead.id,
			draft: false,
		});
		f.service.join(member.id, { missionId: detail.mission.id });
		f.service.notices.start();
		f.store.addComment(detail.mission.id, { text: "pending event" });
		const save = f.sessions["save"].bind(f.sessions);
		let once = true;
		t.mock.method(f.sessions, "save" as never, async (meta: Parameters<typeof save>[0]) => {
			await save(meta);
			if (once && meta.pending?.some((command) => command.requestId.startsWith("mission-notice:"))) {
				once = false;
				f.store.update(
					detail.mission.id,
					change === "role" ? { coordinatorSessionId: member.id } : { status: "done" },
				);
			}
		});
		await f.service.notices.flush(Date.now() + 30_000);
		assert.equal(
			f.workers
				.get(lead.id)!
				.requests.filter((command) => command.type === "input" && command.requestId.startsWith("mission-notice:"))
				.length,
			0,
		);
		assert.equal(f.store.noticeDeadlines(Date.now()).length, 1, `${change} retains the events`);
		assert.deepEqual(f.sessions["require"](lead.id).pending, []);
	}
});

test("user input wins while notice persistence is in flight, without acknowledging an undelivered batch", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const detail = await f.service.create({ projectId: f.project.id, title: "M", fromSessionId: lead.id, draft: false });
	f.service.notices.start();
	f.store.addComment(detail.mission.id, { text: "pending event" });
	const save = f.sessions["save"].bind(f.sessions);
	let release!: () => void;
	let blocked!: () => void;
	const waiting = new Promise<void>((resolve) => {
		blocked = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let once = true;
	t.mock.method(f.sessions, "save" as never, async (meta: Parameters<typeof save>[0]) => {
		await save(meta);
		if (once && meta.pending?.some((command) => command.requestId.startsWith("mission-notice:"))) {
			once = false;
			blocked();
			await gate;
		}
	});
	const flushing = f.service.notices.flush(Date.now() + 30_000);
	try {
		await waiting;
		await f.sessions.send(lead.id, "new work", "followUp", "user-work");
		release();
		await flushing;
		const requests = f.workers.get(lead.id)!.requests;
		assert.equal(
			requests.filter((command) => command.type === "input" && command.requestId.startsWith("mission-notice:"))
				.length,
			0,
		);
		assert.equal((requests.at(-1) as Extract<KernelCommand, { requestId: string }>).requestId, "user-work");
		assert.ok(f.store.pendingNotice(detail.mission.id));
		await f.service.notices.flush(Date.now() + 30_000);
		assert.equal(
			requests.filter((command) => command.type === "input" && command.requestId.startsWith("mission-notice:"))
				.length,
			1,
		);
		assert.equal(f.store.pendingNotice(detail.mission.id), undefined);
	} finally {
		release();
		await flushing;
	}
});

test("a member resuming during notice persistence revokes admission until a new settle window", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	const detail = await f.service.create({ projectId: f.project.id, title: "M", fromSessionId: lead.id, draft: false });
	f.service.join(member.id, { missionId: detail.mission.id });
	f.service.notices.start();
	f.store.addComment(detail.mission.id, { text: "pending event" });
	const save = f.sessions["save"].bind(f.sessions);
	let once = true;
	t.mock.method(f.sessions, "save" as never, async (meta: Parameters<typeof save>[0]) => {
		await save(meta);
		if (once && meta.pending?.some((command) => command.requestId.startsWith("mission-notice:"))) {
			once = false;
			f.workers.get(member.id)!.state = "working";
			f.workers.get(member.id)!.onPacket({ type: "working", working: true });
		}
	});
	const now = Date.now() + 30_000;
	t.mock.method(Date, "now", () => now);
	await f.service.notices.flush(now);
	const requests = f.workers.get(lead.id)!.requests;
	assert.equal(
		requests.filter((command) => command.type === "input" && command.requestId.startsWith("mission-notice:")).length,
		0,
	);
	assert.ok(f.store.pendingNotice(detail.mission.id));
	f.workers.get(member.id)!.state = "idle";
	f.workers.get(member.id)!.onPacket({ type: "working", working: false });
	await f.service.notices.flush(now + 29_999);
	assert.equal(
		requests.filter((command) => command.type === "input" && command.requestId.startsWith("mission-notice:")).length,
		0,
	);
	t.mock.method(Date, "now", () => now + 30_000);
	await f.service.notices.flush(now + 30_000);
	assert.equal(
		requests.filter((command) => command.type === "input" && command.requestId.startsWith("mission-notice:")).length,
		1,
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

test("multi-task claims handle ranges, partial success and context updates while preserving single claims", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const owner = await f.spawn();
	const outsider = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: chat.id,
		draft: false,
		tasks: Array.from({ length: 7 }, (_, i) => ({ title: `Task ${i + 1}` })),
	});
	f.service.join(owner.id, { missionId: mission.id, taskId: "2" });
	const batch = (await f.service.call(chat.id, "claim", { ids: ["1-5", 7, "#1", "99"] })) as {
		claimed: Array<{ id: string; number: number; sessionId: string }>;
		skipped: Array<{ ref: string; reason: string }>;
	};
	assert.deepEqual(
		batch.claimed.map((task) => task.number),
		[1, 3, 4, 5, 7],
	);
	assert.ok(batch.claimed.every((task) => task.sessionId === chat.id));
	assert.deepEqual(
		batch.skipped.map((item) => item.ref),
		["2", "99"],
	);
	assert.match(batch.skipped[0]!.reason, /already claimed/);
	assert.match(batch.skipped[1]!.reason, /Unknown task/);
	assert.equal(f.store.resolveTask(mission.id, "2").sessionId, owner.id);
	assert.deepEqual(
		f.service.context(chat.id)?.tasks.map((task) => task.number),
		[1, 3, 4, 5, 7],
	);
	const last = f.workers.get(chat.id)!.sent.findLast((command) => command.type === "mission.context");
	assert.ok(last?.type === "mission.context");
	assert.equal(last.context?.tasks.length, 5);
	const range = (await f.service.call(chat.id, "claim", { id: "5-6" })) as typeof batch;
	assert.deepEqual(
		range.claimed.map((task) => task.number),
		[5, 6],
	);
	const single = (await f.service.call(chat.id, "claim", { id: batch.claimed[0]!.id })) as { number: number };
	assert.equal(single.number, 1, "single ID retains the task result");
	await assert.rejects(f.service.call(chat.id, "claim", { id: "2" }), /already claimed/);
	await assert.rejects(f.service.call(outsider.id, "claim", { ids: ["1-5"] }), /not part of a mission/);
	const before = f.store.tasks(mission.id);
	const events = f.store.events(mission.id);
	for (const args of [
		{},
		{ ids: [] },
		{ ids: "1-5" },
		{ id: "1", ids: ["2"] },
		{ id: [] },
		{ ids: ["1", "5-2"] },
		{ ids: ["1", null] },
		{ ids: ["1-1001"] },
	])
		await assert.rejects(f.service.call(chat.id, "claim", args));
	assert.deepEqual(f.store.tasks(mission.id), before);
	assert.deepEqual(f.store.events(mission.id), events);
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

test("start saves member and already-linked artifacts and parsed links before spawn; later chats inherit them", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const author = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
		tasks: [{ title: "Auth" }],
	});
	f.service.join(author.id, { missionId: mission.id });
	const first = await f.sessions["artifactStore"](lead.id).create({
		title: "Design",
		kind: "html",
		source: "<p>PRIVATE DESIGN CONTENT</p>",
	});
	const second = await f.sessions["artifactStore"](author.id).create({
		title: "Diagram",
		kind: "html",
		source: "<p>PRIVATE DIAGRAM CONTENT</p>",
	});
	await f.service.linkArtifact(mission.id, { sessionId: author.id, artifactId: second.id });
	f.service.leave(author.id); // An existing mission link remains a valid reference.
	const task = f.store.resolveTask(mission.id, "1");
	const spawn = f.sessions.spawn.bind(f.sessions);
	t.mock.method(f.sessions, "spawn", async (request: Parameters<SessionManager["spawn"]>[0]) => {
		const detail = f.store.detail(mission.id);
		assert.equal(detail.artifacts.filter((ref) => ref.taskId === task.id).length, 2);
		assert.equal(detail.resources.filter((ref) => ref.taskId === task.id).length, 2);
		return spawn(request);
	});
	const session = (await f.service.call(lead.id, "start", {
		id: "#1",
		artifacts: [{ artifactId: first.id, revision: 1 }, { artifactId: second.id }],
		links: [
			{ url: "https://github.com/octo/repo/issues/42?x=1#fragment", title: "Issue" },
			{ url: "https://linear.app/acme/issue/ENG-12/design" },
		],
	})) as SessionSummary;
	const content = async (id: string) => {
		const worker = await until(() => f.workers.get(id));
		const input = await until(() => worker.requests.find((command) => command.type === "input"));
		return input.type === "input" ? input.content : "";
	};
	const message = await content(session.id);
	assert.match(message, /Read them as needed/);
	assert.ok(message.includes(`Design (html): ${first.id}, revision 1`));
	assert.ok(message.includes(`Diagram (html): ${second.id}`));
	assert.match(message, /Issue \(github.issue\): https:\/\/github.com\/octo\/repo\/issues\/42/);
	assert.doesNotMatch(message, /PRIVATE.*CONTENT/);
	const detail = f.store.detail(mission.id);
	assert.deepEqual(detail.resources.map((ref) => [ref.kind, ref.externalId]).sort(), [
		["github.issue", "octo/repo#42"],
		["linear.issue", "ENG-12"],
	]);
	assert.equal(
		detail.artifacts.filter((ref) => ref.artifactId === second.id).length,
		2,
		"mission-level link is preserved",
	);
	for (const action of ["get", "tasks"] as const) {
		const result = (await f.service.call(session.id, action, {})) as {
			tasks: Array<{ artifacts: unknown[]; resources: unknown[] }>;
		};
		assert.equal(result.tasks[0]!.artifacts.length, 2);
		assert.equal(result.tasks[0]!.resources.length, 2);
	}
	f.service.leave(session.id);
	const later = await f.service.startTask(mission.id, task.id);
	assert.equal(await content(later.id), message);
});

test("start rejects foreign artifacts, invalid revisions and malformed links without writes or spawn", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const outsider = await f.spawn();
	const other = await f.spawn(f.other.id);
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
		tasks: [{ title: "A" }],
	});
	const valid = await f.sessions["artifactStore"](lead.id).create({ title: "Valid", kind: "html", source: "ok" });
	const foreign = await f.sessions["artifactStore"](outsider.id).create({
		title: "Foreign",
		kind: "html",
		source: "no",
	});
	const otherArtifact = await f.sessions["artifactStore"](other.id).create({
		title: "Other",
		kind: "html",
		source: "no",
	});
	const cases = [
		{ artifacts: [{ artifactId: foreign.id }] },
		{ artifacts: [{ artifactId: otherArtifact.id }] },
		{ artifacts: [{ artifactId: "missing" }] },
		{ artifacts: [{ artifactId: valid.id, revision: 2 }] },
		{ artifacts: [{ artifactId: valid.id, revision: 0 }] },
		{ artifacts: [{ artifactId: valid.id, revision: 1.5 }] },
		{ artifacts: [null] },
		{ artifacts: {} },
		{ links: {} },
		{ links: [null] },
		{ links: [{ url: "relative" }] },
		{ links: [{ url: "file:///tmp/read" }] },
		{ links: [{ url: "https://example.com", title: 4 }] },
		{ links: [{ url: "https://example.com", title: "x".repeat(201) }] },
		{ links: Array.from({ length: 41 }, () => ({ url: "https://example.com" })) },
	];
	const before = f.store.detail(mission.id);
	for (const args of cases) {
		await assert.rejects(f.service.call(lead.id, "start", { id: "1", ...args }));
		assert.deepEqual(f.store.detail(mission.id), before);
		assert.equal(f.sessions.list().length, 3);
	}
	await assert.rejects(
		f.service.call(lead.id, "start", {
			id: "1",
			artifacts: [{ artifactId: valid.id }, { artifactId: foreign.id }],
			links: [{ url: "https://example.com" }],
		}),
		/must already be linked/,
	);
	assert.deepEqual(f.store.detail(mission.id), before);
});

test("opening message cap includes task body, extra instructions and inherited references", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		tasks: [{ title: "A" }, { title: "B", body: "x".repeat(4000) }],
	});
	const before = f.store.detail(mission.id);
	for (const args of [
		{ message: "x".repeat(4000) },
		{ links: Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}`, title: "x".repeat(200) })) },
	]) {
		await assert.rejects(f.service.startTask(mission.id, "1", args), /Opening message is too long.*max 4000/);
		assert.deepEqual(f.store.detail(mission.id), before);
	}
	await assert.rejects(f.service.startTask(mission.id, "2"), /Opening message is too long/);
	for (let i = 0; i < 20; i++)
		f.store.addResource(mission.id, { taskId: "1", url: `https://example.com/${i}`, title: "x".repeat(200) });
	await assert.rejects(f.service.startTask(mission.id, "1"), /Opening message is too long/);
	assert.equal(f.sessions.list().length, 0);
	// A message exactly at the cap is accepted; one character above is rejected.
	const plain = f.store.addTask(mission.id, { title: "C" });
	const base = `Work on mission task #${plain.number}: C\n\nThis task is already claimed for this chat. Start by reading the mission with the mission tool.`;
	const extra = "x".repeat(4000 - base.length - 2);
	await assert.rejects(f.service.startTask(mission.id, plain.id, { message: `${extra}x` }), /max 4000/);
	const session = await f.service.startTask(mission.id, plain.id, { message: extra });
	const worker = await until(() => f.workers.get(session.id));
	const input = await until(() => worker.requests.find((command) => command.type === "input"));
	assert.equal(input.type === "input" ? input.content.length : 0, 4000);
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

test("task starts reject invalid model/thinking before spawning, and record explicit and default choices", async (t) => {
	const f = await fixture(t);
	const models = [
		["claude-opus-5-5", 4, 20, true],
		["small", 0.1, 0.4, false],
		["frontier", 10, 50, true],
		["outside", 0, 0, true],
	].map(([id, input, output, reasoning]) => ({
		id,
		name: id,
		provider: "test",
		api: "openai-completions",
		baseUrl: "http://unused",
		input: ["text"],
		reasoning,
		contextWindow: 32000,
		maxTokens: 4096,
		cost: { input, output, cacheRead: 0, cacheWrite: 0 },
	}));
	t.mock.method(
		ModelRuntime,
		"create",
		async () =>
			({
				getAvailable: async () => models,
				getModel: (_provider: string, id: string) => models.find((model) => model.id === id),
			}) as unknown as ModelRuntime,
	);
	await mkdir(join(f.project.path, ".pi"));
	await writeFile(
		join(f.project.path, ".pi", "settings.json"),
		JSON.stringify({
			defaultProvider: "test",
			defaultModel: "small",
			defaultThinkingLevel: "low",
			enabledModels: ["test/claude-opus-5-5", "test/small", "test/frontier"],
		}),
	);
	const catalog = new ModelCatalog(f.home);
	const select = t.mock.method(f.sessions, "selectTaskModel", catalog.selectTaskModel.bind(catalog));
	const coordinator = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: coordinator.id,
		draft: false,
		tasks: [{ title: "Explicit" }, { title: "Default" }],
	});
	for (const [args, error] of [
		[{ model: "test/outside" }, /not available.*Allowed models:/],
		[{ model: "test/frontier" }, /price cap.*Allowed models:/],
		[{ model: "test/small", thinking: "high" }, /not supported.*Allowed models:/],
		[{ model: 42 }, /model must be a non-empty/],
	] as const) {
		await assert.rejects(f.service.call(coordinator.id, "start", { id: "1", ...args }), error);
		assert.equal(f.sessions.list().length, 1);
		assert.equal(f.store.resolveTask(mission.id, "1").sessionId, undefined);
		assert.ok(!f.store.events(mission.id).some((event) => event.text.startsWith("Started #")));
	}
	const explicit = (await f.service.call(coordinator.id, "start", {
		id: "1",
		model: "test/claude-opus-5-5",
		thinking: "high",
	})) as SessionSummary;
	assert.deepEqual(select.mock.calls.at(-1)?.arguments, [f.project.path, "test/claude-opus-5-5", "high"]);
	const worker = await until(() => f.workers.get(explicit.id));
	assert.equal(worker.spec.model, "test/claude-opus-5-5");
	assert.equal(worker.spec.thinking, "high");
	// The HTTP start path shares the same validated default selection.
	const defaultSession = await f.service.startTask(mission.id, "2");
	const defaultWorker = await until(() => f.workers.get(defaultSession.id));
	assert.equal(defaultWorker.spec.model, "test/small");
	assert.equal(defaultWorker.spec.thinking, "off");
	const startEvent = f.store.events(mission.id).find((event) => event.text.startsWith("Started #2"))!;
	assert.equal(startEvent.kind, "task");
	assert.equal(startEvent.taskId, f.store.resolveTask(mission.id, "2").id);
	assert.deepEqual(f.store.userNotes(mission.id, 15), [], "automatic start activity is not an authored user note");
	assert.deepEqual(
		f.store
			.events(mission.id)
			.filter((event) => event.text.startsWith("Started #"))
			.map((event) => event.text)
			.sort(),
		["Started #1 on test/claude-opus-5-5, thinking high", "Started #2 on test/small, thinking off"],
	);
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
		["delete", { id: "1" }],
		["group", { ids: ["1"], milestone: "Next" }],
		["task", { id: "1", order: 0 }],
		["task", { title: "Not admitted", order: 0 }],
		["start", { id: "1" }],
		["send", { targetSessionId: coordinator.id, message: "Continue" }],
		["status", {}],
	] as const;
	const before = f.workers.get(coordinator.id)!.requests.length;
	const tasks = f.store.tasks(mission.id);
	for (const [action, args] of actions) {
		await assert.rejects(f.service.call(member.id, action, args), /Only the mission coordinator/);
		await assert.rejects(f.service.call(outsider.id, action, args), /not part of a mission/);
	}
	assert.equal(f.sessions.list().length, 3);
	assert.equal(f.store.resolveTask(mission.id, "1").sessionId, undefined);
	assert.equal(f.workers.get(coordinator.id)!.requests.length, before);
	assert.deepEqual(f.store.tasks(mission.id), tasks);
	f.store.update(mission.id, { coordinatorSessionId: member.id });
	for (const [action, args] of actions)
		await assert.rejects(f.service.call(coordinator.id, action, args), /Only the mission coordinator/);
	await f.service.call(member.id, "status", {});
	f.store.update(mission.id, { coordinatorSessionId: null });
	for (const [action, args] of actions)
		await assert.rejects(f.service.call(member.id, action, args), /Only the mission coordinator/);
	assert.deepEqual(f.store.tasks(mission.id), tasks);
});

test("task deletion, ordering and grouping validate inputs and preserve unrelated state", async (t) => {
	const f = await fixture(t);
	const coordinator = await f.spawn();
	const member = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: coordinator.id,
		draft: false,
		tasks: [{ title: "A", body: "Keep" }, { title: "B" }, { title: "C" }],
	});
	f.service.join(member.id, { missionId: mission.id });
	const [a, b, c] = f.store.tasks(mission.id);
	f.store.updateTask(mission.id, a!.id, { milestone: "Old" });
	f.store.updateTask(mission.id, b!.id, { dependsOn: [a!.id] });
	await f.service.call(member.id, "claim", { id: "1" });
	const link = f.store.addResource(mission.id, { taskId: a!.id, url: "https://example.com/work" });
	await f.service.call(member.id, "task", { id: "#3", status: "dropped" });
	assert.equal(f.store.task(mission.id, c!.id).status, "dropped");

	for (const order of ["0", null, Number.NaN, Number.POSITIVE_INFINITY])
		await assert.rejects(f.service.call(coordinator.id, "task", { id: "1", order }), /order must be a number/);
	await f.service.call(coordinator.id, "task", { id: b!.id, order: a!.order - 0.5 });
	assert.deepEqual(
		f.store.tasks(mission.id).map((task) => task.number),
		[2, 1, 3],
	);
	assert.deepEqual(f.store.task(mission.id, b!.id).dependsOn, [a!.id]);
	await f.service.call(coordinator.id, "task", { id: "#2", order: a!.order });
	assert.deepEqual(
		f.store.tasks(mission.id).map((task) => task.number),
		[1, 2, 3],
		"ties use task number",
	);
	const created = await f.service.call(coordinator.id, "task", { title: "First", order: -1 });
	assert.equal((created as { order: number }).order, -1);
	assert.equal(f.store.tasks(mission.id)[0]!.title, "First");
	assert.ok(
		f.store
			.detail(mission.id)
			.events.some((event) => event.text.includes("reordered") && event.sessionId === coordinator.id),
	);

	const before = f.store.tasks(mission.id);
	const invalid = [
		{},
		{ ids: "1-2", milestone: "New" },
		{ ids: [], milestone: "New" },
		{ id: "1", ids: ["2"], milestone: "New" },
		{ ids: ["1"] },
		{ ids: ["1"], milestone: null },
		{ ids: ["1"], milestone: "x".repeat(201) },
		{ ids: ["1-1001"], milestone: "New" },
		{ ids: ["1", "unknown"], milestone: "New" },
	];
	for (const args of invalid) {
		await assert.rejects(f.service.call(coordinator.id, "group", args));
		assert.deepEqual(f.store.tasks(mission.id), before, "invalid grouping never partly writes");
	}
	const grouped = await f.service.call(coordinator.id, "group", { ids: ["#1-2", a!.id, 3], milestone: " Next " });
	assert.deepEqual(
		grouped,
		{
			tasks: [a, b, c].map((task) => ({ id: task!.id, number: task!.number, milestone: "Next" })),
		},
		"duplicates are deduplicated and batch results do not repeat task bodies",
	);
	assert.deepEqual(
		f.store
			.tasks(mission.id)
			.filter((task) => task.milestone === "Next")
			.map((task) => task.number),
		[1, 2, 3],
	);
	assert.equal(f.store.task(mission.id, a!.id).body, "Keep");
	assert.equal(f.store.task(mission.id, a!.id).sessionId, member.id);
	assert.equal(f.store.task(mission.id, c!.id).status, "dropped");
	await f.service.call(coordinator.id, "group", { ids: ["1-2"], milestone: "" });
	assert.equal(f.store.task(mission.id, a!.id).milestone, undefined);
	assert.equal(f.store.task(mission.id, b!.id).milestone, undefined);
	assert.equal(f.store.task(mission.id, c!.id).milestone, "Next");

	for (const args of [{}, { id: "" }, { id: 1 }, { id: "unknown" }])
		await assert.rejects(f.service.call(coordinator.id, "delete", args));
	const deleted = await f.service.call(coordinator.id, "delete", { id: "#1" });
	assert.deepEqual(deleted, { id: a!.id, number: 1, deleted: true });
	assert.throws(() => f.store.task(mission.id, a!.id), /Unknown task/);
	assert.equal(f.store.task(mission.id, b!.id).dependsOn, undefined);
	assert.equal(f.store.detail(mission.id).resources.find((resource) => resource.id === link.id)?.taskId, undefined);
	assert.deepEqual(f.service.context(member.id)?.tasks, []);
	assert.ok(
		f.store
			.detail(mission.id)
			.events.some((event) => event.text.includes("removed") && event.sessionId === coordinator.id),
	);
	const other = f.store.create({ projectId: f.project.id, title: "Other", tasks: [{ title: "Outside" }] });
	const foreign = f.store.tasks(other.id)[0]!;
	await assert.rejects(f.service.call(coordinator.id, "delete", { id: foreign.id }), /Unknown task/);
	await assert.rejects(
		f.service.call(coordinator.id, "group", { ids: [b!.id, foreign.id], milestone: "Wrong" }),
		/Unknown task/,
	);
	assert.equal(f.store.task(mission.id, b!.id).milestone, undefined);
	await f.service.call(coordinator.id, "delete", { id: c!.id });
	assert.throws(() => f.store.task(mission.id, c!.id), /Unknown task/);
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
		model: "test/model",
		thinking: "high",
	})) as SessionSummary;
	assert.deepEqual(startTask.mock.calls.at(-1)?.arguments, [
		mission.id,
		"#1",
		{ message: "Focus on login", model: "test/model", thinking: "high" },
	]);
	assert.ok(f.store.events(mission.id).some((event) => event.text === "Started #1 on test/model, thinking high"));
	assert.equal(first.missionId, mission.id);
	assert.equal(first.projectId, f.project.id);
	assert.equal(first.title, "Auth");
	assert.equal(f.store.resolveTask(mission.id, "1").sessionId, first.id);
	assert.equal(f.store.resolveTask(mission.id, "1").status, "in_progress");
	const worker = await until(() => f.workers.get(first.id));
	assert.equal(worker.spec.model, "test/model");
	assert.equal(worker.spec.thinking, "high");
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
	assert.equal(detail.mission.needsYouCount, 0);
	// Sidebar clients receive count updates without subscribing to full detail.
	const summaryTask = f.store.addTask(id, { title: "Summary-only blocked task", status: "blocked" });
	const summaryComment = f.store.addComment(id, { text: "Needs user" }, { sessionId: "agent" });
	await until(() =>
		messages.findLast(
			(message) => message.type === "missions" && message.missions.some((m) => m.id === id && m.needsYouCount === 2),
		),
	);
	assert.equal((await api(`/missions?projectId=${f.project.id}`).then((r) => r.json()))[0].needsYouCount, 2);
	assert.equal((await api(`/missions/${id}`).then((r) => r.json())).mission.needsYouCount, 2);
	assert.ok(!messages.some((message) => message.type === "mission"));
	messages.length = 0;
	f.store.resolveComment(id, summaryComment.id);
	f.store.removeTask(id, summaryTask.id);
	await until(() =>
		messages.findLast(
			(message) => message.type === "missions" && message.missions.some((m) => m.id === id && m.needsYouCount === 0),
		),
	);
	assert.ok(!messages.some((message) => message.type === "mission"));
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
