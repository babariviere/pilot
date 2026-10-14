import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { KernelCommand, KernelPacket, KernelSpec } from "@pilot/kernel";
import type { MissionDetail, ServerMessage, SessionState, SessionSummary } from "@pilot/protocol";
import { WebSocket } from "ws";
import { draftMessage, MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import type { PullRequestOptions } from "./pull-requests.ts";
import { createDaemonServer } from "./server.ts";
import { CommandRejected, type SessionWorker, SessionManager } from "./sessions.ts";
import { type SubscriptionUsageSource, SUBSCRIPTION_USAGE_MAX_AGE_MS } from "./subscription-usage.ts";
import { TerminalManager } from "./terminals.ts";
import { legacyGitHub } from "./testing/legacy-github.ts";

test("decision audiences and task pins select prompts and avoid duplicate detail reads", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const worker = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Shared",
		fromSessionId: lead.id,
		draft: false,
		tasks: [{ title: "Implement" }],
	});
	f.service.join(worker.id, { missionId: mission.id, taskId: "1" });
	const reference = f.store.addDecision(mission.id, "Reference");
	const all = f.store.addDecision(mission.id, "Everyone", {}, "all");
	const coordinator = f.store.addDecision(mission.id, "Coordinate", {}, "coordinator");
	assert.deepEqual(f.service.context(worker.id)?.decisions, ["Everyone"]);
	assert.deepEqual(f.service.context(lead.id)?.decisions, ["Everyone", "Coordinate"]);
	await f.service.call(worker.id, "task", { id: "1", decisionIds: [reference.id, coordinator.id] });
	assert.deepEqual(new Set(f.service.context(worker.id)?.decisions), new Set(["Reference", "Everyone", "Coordinate"]));
	assert.equal(f.service.context(worker.id)?.remainingDecisions, 0);
	const before = f.service.context(worker.id)!.decisionEntries;
	assert.deepEqual(
		((await f.service.call(worker.id, "decisions", { _promptDecisions: before })) as { decisions: unknown[] })
			.decisions,
		[],
	);
	f.store.updateDecision(mission.id, all.id, "Revised");
	f.store.removeDecision(mission.id, reference.id);
	const result = (await f.service.call(worker.id, "decisions", { _promptDecisions: before })) as {
		decisions: { text: string }[];
		retired: { text: string }[];
	};
	assert.deepEqual(
		result.decisions.map((d) => d.text),
		["Revised"],
	);
	assert.deepEqual(
		result.retired.map((d) => d.text),
		["Reference"],
	);
	await f.service.call(worker.id, "task", { id: "1", decisionIds: [] });
	assert.deepEqual(f.service.context(worker.id)?.decisions, ["Revised"]);
	const foreign = f.store.create({ projectId: f.project.id, title: "Other" });
	const foreignDecision = f.store.addDecision(foreign.id, "Elsewhere");
	await assert.rejects(
		f.service.call(worker.id, "task", { id: "1", decisionIds: [foreignDecision.id] }),
		/Unknown decision/,
	);
});

test("compact get stays within estimated token budgets on a large fixture, with detail on demand", async (t) => {
	const f = await fixture(t);
	// No GitHub fetch or kernel wake-up is needed for agent reads.
	t.mock.method(f.sessions, "refreshMissionPullRequests", () => {});
	const lead = await f.spawn();
	const worker = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Shared delivery",
		fromSessionId: lead.id,
		draft: false,
		goal: "Ship a durable shared workflow with compact agent context and safe ownership.",
	});
	f.service.join(worker.id, { missionId: mission.id });
	const tasks = Array.from({ length: 82 }, (_, i) =>
		f.store.addTask(mission.id, {
			title: `Improve workflow validation and reference handling ${i + 1}`,
			body: "Detailed acceptance criteria. ".repeat(100),
			status: i < 49 ? "done" : i === 49 ? "in_progress" : i === 50 ? "in_review" : "todo",
			milestone: i % 2 ? "Delivery" : "Foundation",
			...(i === 49 ? { sessionId: worker.id } : {}),
			...(i > 49 ? { dependsOn: ["50"] } : {}),
		}),
	);
	for (let i = 0; i < 43; i++)
		f.store.addResource(mission.id, {
			taskId: tasks[i]!.id,
			url: `https://github.com/octo/repo/pull/${i + 1}`,
			title: "A long completed pull request title with stored review metadata",
		});
	f.store.addResource(mission.id, { taskId: tasks[49]!.id, url: "https://example.com/spec", title: "Specification" });
	f.store.addResource(mission.id, { taskId: tasks[50]!.id, url: "https://github.com/octo/repo/pull/99" });
	for (let i = 0; i < 64; i++)
		f.store.linkArtifact(mission.id, {
			artifactId: `artifact-${i}`,
			sessionId: worker.id,
			title: `Workflow layout ${i}`,
			kind: "html",
			taskId: tasks[i < 63 ? i % 49 : 49]!.id,
		});
	for (let i = 0; i < 30; i++)
		f.store.addDecision(mission.id, `Rule ${i}: ${"Detailed binding reference. ".repeat(8)}`);
	const reviewer = await f.spawn();
	f.service.join(reviewer.id, { missionId: mission.id, taskId: "52" });
	f.store.updateTask(mission.id, "52", { status: "blocked" });
	f.store.addComment(mission.id, { text: "Review the validation requirement.", targetSessionId: lead.id });
	for (let i = 0; i < 100; i++)
		f.store.log(mission.id, { text: "Old history that must not be returned. ".repeat(20) });
	f.store.writeBrief(mission.id, "# Specification\n" + "Details. ".repeat(1000), 0);
	t.mock.method(f.store, "brief", () => assert.fail("agent summary must not read brief history"));
	t.mock.method(f.store, "events", () => assert.fail("agent summary must not read events"));
	t.mock.method(f.store, "userNotes", () => assert.fail("agent summary must not read user notes"));
	for (const [member, budget] of [
		[worker, 4000],
		[lead, 8000],
	] as const) {
		const get = await f.service.call(member.id, "get", {});
		const serialized = JSON.stringify(get);
		t.diagnostic(
			`${member.id === worker.id ? "worker" : "coordinator"} get: ${Buffer.byteLength(serialized)} bytes (~${Math.ceil(Buffer.byteLength(serialized) / 4)} tokens)`,
		);
		assert.ok(
			Buffer.byteLength(serialized) < budget,
			`get is ${Buffer.byteLength(serialized)} bytes, budget ${budget} (~${budget / 4} tokens)`,
		);
		assert.doesNotMatch(serialized, /Old history|Detailed acceptance|Detailed binding|completed pull request/);
		assert.doesNotMatch(serialized, new RegExp(mission.id + "|" + worker.id + "|" + tasks[49]!.id));
	}
	const summary = (await f.service.call(worker.id, "get", {})) as {
		counts: { doneTasks: number; links: number; artifacts: number; decisions: number };
		tasks: { number: number; resources: unknown[]; artifacts: unknown[] }[];
		openTasks: unknown[];
	};
	assert.deepEqual(summary.counts, { doneTasks: 49, droppedTasks: 0, links: 45, artifacts: 64, decisions: 30 });
	assert.equal(summary.tasks[0]!.number, 50);
	assert.equal(summary.tasks[0]!.resources.length, 1);
	assert.equal(summary.tasks[0]!.artifacts.length, 1);
	assert.equal(summary.openTasks.length, 32);
	const coordinator = (await f.service.call(lead.id, "get", {})) as {
		members: { title: string; state: string; tasks: number[] }[];
		needsYou: { blockedTasks: number[]; comments: { text: string }[] };
		prsInReview: { task: number; url: string }[];
	};
	assert.equal(coordinator.members.length, 3);
	assert.ok(coordinator.members.some((member) => member.tasks.includes(52) && member.state === "idle"));
	assert.deepEqual(coordinator.needsYou.blockedTasks, [52]);
	assert.equal(coordinator.needsYou.comments[0]?.text, "Review the validation requirement.");
	assert.equal(coordinator.prsInReview[0]?.task, 51);
	const full = (await f.service.call(worker.id, "task", { id: "1" })) as { body: string; number: number };
	assert.equal(full.number, 1);
	assert.match(full.body, /Detailed acceptance/);
	const readTasks = async (args: Record<string, unknown>) =>
		((await f.service.call(worker.id, "tasks", args)) as { tasks: unknown[] }).tasks;
	assert.equal((await readTasks({})).length, 33);
	assert.equal((await readTasks({ mine: true })).length, 1);
	assert.equal((await readTasks({ milestone: "Foundation" })).length, 16);
	assert.equal((await readTasks({ filter: "done" })).length, 49);
	assert.equal((await readTasks({ filter: "all" })).length, 82);
	assert.equal(((await f.service.call(worker.id, "links", {})) as { links: unknown[] }).links.length, 2);
	assert.equal(
		((await f.service.call(worker.id, "links", { filter: "done" })) as { links: unknown[] }).links.length,
		43,
	);
	assert.equal(((await f.service.call(worker.id, "artifacts", {})) as { artifacts: unknown[] }).artifacts.length, 1);
	assert.equal(
		((await f.service.call(worker.id, "artifacts", { taskId: "1", filter: "all" })) as { artifacts: unknown[] })
			.artifacts.length,
		2,
	);
	assert.equal(((await f.service.call(worker.id, "decisions", {})) as { decisions: unknown[] }).decisions.length, 30);
	await assert.rejects(f.service.call(worker.id, "tasks", { filter: "bogus" }), /filter must be/);
});

class FakeWorker implements SessionWorker {
	ready = Promise.resolve();
	state: SessionState = "idle";
	error?: string;
	busy = false;
	stopped = false;
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
		if (command.type === "abort") this.stopped = true;
		if (command.type === "input") {
			if (!command.requestId.startsWith("mission:send:")) this.stopped = false;
			this.onPacket({
				type: "accepted",
				requestId: command.requestId,
				delivery: this.state === "working" || this.stopped ? "queued" : "delivered",
			});
		}
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
	usageSource?: SubscriptionUsageSource,
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
		{ ...(usageSource ? { subscriptionUsage: () => usageSource } : {}) },
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

test("new mission starts a coordinator with the draft request and user context before its first turn", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Plan",
		goal: "Ship a small feature",
		startCoordinator: true,
		model: "test/chosen",
		thinking: "high",
		message: "Use https://example.com/spec. Keep it small.",
	});
	assert.ok(mission.coordinatorSessionId);
	const session = f.sessions.get(mission.coordinatorSessionId)!;
	assert.equal(session.missionId, mission.id);
	assert.equal(session.projectId, f.project.id);
	assert.equal(session.thinking, "high");
	assert.deepEqual(f.store.members(mission.id), [session.id]);
	const worker = await until(() => f.workers.get(session.id));
	assert.equal(worker.spec.model, "test/chosen");
	assert.equal(worker.spec.mission?.coordinator, "self");
	const input = await until(() => worker.requests.find((command) => command.type === "input"));
	assert.equal(
		input.type === "input" ? input.content : "",
		`${draftMessage("Plan")}\n\nShip a small feature\n\nUse https://example.com/spec. Keep it small.`,
	);
});

test("new mission with start disabled or omitted creates no chat", async (t) => {
	const f = await fixture(t);
	for (const startCoordinator of [false, undefined]) {
		const { mission } = await f.service.create({
			projectId: f.project.id,
			title: "Plan",
			goal: "Goal",
			startCoordinator,
		});
		assert.equal(mission.coordinatorSessionId, undefined);
		assert.deepEqual(f.store.members(mission.id), []);
	}
	assert.equal(f.sessions.list().length, 0);
});

test("PR handoff actions check coordinator role and membership and share task-link behavior with user binds", async (t) => {
	const f = await fixture(t);
	const coordinator = await f.spawn();
	const member = await f.spawn();
	const outsider = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Handoff",
		fromSessionId: coordinator.id,
		draft: false,
	});
	f.store.join(member.id, mission.id);
	const url = "https://github.com/octo/repo/pull/12";
	for (const action of ["bindPr", "unbindPr"] as const) {
		await assert.rejects(
			f.service.call(member.id, action, { targetSessionId: member.id, url }),
			/Only the mission coordinator/,
		);
		await assert.rejects(
			f.service.call(coordinator.id, action, { targetSessionId: outsider.id, url }),
			/not in this mission/,
		);
		await assert.rejects(f.service.call(coordinator.id, action, { url }), /requires targetSessionId and url/);
	}
	const meta = f.sessions["metas"].get(member.id)!;
	meta.workspace = {
		source: f.project.path,
		upstream: "git@github.com:octo/repo.git",
		branch: "feat/other",
		base: "origin/main",
		jj: false,
	};
	const first = f.store.addTask(mission.id, { title: "First" });
	f.store.claimTask(mission.id, first.id, member.id);
	await f.service.call(coordinator.id, "bindPr", { targetSessionId: member.id, url });
	assert.ok(f.store.detail(mission.id).resources.some((r) => r.url === url && r.taskId === first.id));
	f.store.updatePullRequest({
		number: 12,
		url,
		title: "Hand-built",
		state: "open",
		branch: "feat/other",
		checkedAt: 1,
	});
	assert.equal(f.store.task(mission.id, first.id).status, "in_review");
	await f.sessions.unbindPullRequest(member.id, url);
	assert.equal(f.store.detail(mission.id).resources.filter((r) => r.url === url).length, 0);
	assert.equal(f.store.task(mission.id, first.id).status, "in_progress");
	const second = f.store.addTask(mission.id, { title: "Second" });
	f.store.claimTask(mission.id, second.id, member.id);
	await assert.rejects(f.sessions.bindPullRequest(member.id, url), /Ambiguous.*taskId/);
	await f.sessions.bindPullRequest(member.id, url, {}, second.id);
	assert.deepEqual(
		f.store
			.detail(mission.id)
			.resources.filter((r) => r.url === url)
			.map((r) => r.taskId),
		[second.id],
	);
	const events = f.store.detail(mission.id).events.filter((e) => /Pull request (bound|unbound)/.test(e.text));
	assert.ok(events.some((e) => e.text.includes("bound") && e.sessionId === coordinator.id));
	assert.ok(events.some((e) => e.text.includes("unbound") && e.sessionId === undefined));
});

test("PR tools report actual ownership and link changes, and get/status expose cached owners", async (t) => {
	const f = await fixture(t);
	const coordinator = await f.spawn();
	const first = await f.spawn();
	const second = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Handoff",
		fromSessionId: coordinator.id,
		draft: false,
	});
	for (const member of [first, second]) {
		f.store.join(member.id, mission.id);
		f.sessions["metas"].get(member.id)!.workspace = {
			source: f.project.path,
			upstream: "git@github.com:octo/repo.git",
			branch: "feat/work",
			base: "origin/main",
			jj: false,
		};
	}
	const a = f.store.addTask(mission.id, { title: "First" });
	const b = f.store.addTask(mission.id, { title: "Second" });
	f.store.claimTask(mission.id, a.id, first.id);
	f.store.claimTask(mission.id, b.id, second.id);
	const url = "https://github.com/octo/repo/pull/12";
	const reference = await f.service.call(first.id, "link", { url, taskId: a.id, relationship: "reference" });
	f.store.addResource(mission.id, { url });
	const bind = (id: string, taskId?: string) =>
		f.service.call(coordinator.id, "bindPr", { targetSessionId: id, url, ...(taskId ? { taskId } : {}) });
	const unbind = (id: string) => f.service.call(coordinator.id, "unbindPr", { targetSessionId: id, url });
	assert.deepEqual(await bind(first.id), { changed: true, previousOwner: null, taskLinkRemoved: false });
	assert.deepEqual(await bind(first.id), {
		changed: false,
		previousOwner: { id: first.id, title: first.title },
		taskLinkRemoved: false,
	});
	const get = (await f.service.call(first.id, "get", {})) as {
		resources: { owner: unknown }[];
		tasks: { resources: { owner: unknown }[] }[];
	};
	for (const r of get.tasks.flatMap((task) => task.resources)) assert.equal(r.owner, first.title);
	const status = (await f.service.call(coordinator.id, "status", {})) as {
		members: { id: string; boundPullRequests: string[] }[];
	};
	assert.deepEqual(status.members.find((m) => m.id === first.id)?.boundPullRequests, [url]);
	assert.deepEqual(status.members.find((m) => m.id === second.id)?.boundPullRequests, []);
	assert.deepEqual(await bind(second.id), {
		changed: true,
		previousOwner: { id: first.id, title: first.title },
		taskLinkRemoved: true,
	});
	assert.deepEqual(await unbind(first.id), {
		changed: false,
		previousOwner: { id: second.id, title: second.title },
		taskLinkRemoved: false,
	});
	assert.ok(f.store.detail(mission.id).resources.some((r) => r.taskId === b.id && r.relationship === "ownership"));
	assert.deepEqual(await unbind(second.id), {
		changed: true,
		previousOwner: { id: second.id, title: second.title },
		taskLinkRemoved: true,
	});
	const events = f.store.events(mission.id).length;
	assert.deepEqual(await unbind(second.id), { changed: false, previousOwner: null, taskLinkRemoved: false });
	assert.equal(f.store.events(mission.id).length, events);
	const remaining = f.store.detail(mission.id).resources;
	assert.equal(remaining.length, 2);
	assert.ok(remaining.some((r) => r.id === (reference as { id: string }).id));
	const unbound = (await f.service.call(first.id, "links", {})) as { links: { owner: unknown }[] };
	assert.ok(unbound.links.every((r) => r.owner === null));
	// Relinking the same owner to another task is still a change, even without a metadata change.
	await bind(first.id, a.id);
	assert.deepEqual(await bind(first.id, b.id), {
		changed: true,
		previousOwner: { id: first.id, title: first.title },
		taskLinkRemoved: true,
	});
});

test("unlink is scoped and idempotent, permits authors and coordinator, and never unbinds a PR", async (t) => {
	const f = await fixture(t);
	const coordinator = await f.spawn();
	const author = await f.spawn();
	const member = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Links",
		fromSessionId: coordinator.id,
		draft: false,
	});
	f.store.join(author.id, mission.id);
	f.store.join(member.id, mission.id);
	const task = f.store.addTask(mission.id, { title: "Work" });
	const url = "https://github.com/octo/repo/pull/12";
	for (const taskId of [undefined, task.id])
		await f.service.call(author.id, "link", { url, ...(taskId ? { taskId } : {}) });
	await assert.rejects(f.service.call(member.id, "unlink", { url }), /only remove links they added/);
	assert.equal(f.store.detail(mission.id).resources.length, 2);
	assert.equal(
		((await f.service.call(author.id, "unlink", { url: `${url}/files?x=1` })) as { removed: boolean }).removed,
		true,
	);
	assert.deepEqual(await f.service.call(author.id, "unlink", { url }), { removed: false });
	assert.equal(f.store.detail(mission.id).resources[0]?.taskId, task.id);
	assert.equal(
		((await f.service.call(coordinator.id, "unlink", { url, taskId: "#1" })) as { removed: boolean }).removed,
		true,
	);
	f.store.addResource(mission.id, { url }); // User-added link.
	await assert.rejects(f.service.call(author.id, "unlink", { url }), /only remove links they added/);
	assert.equal(((await f.service.call(coordinator.id, "unlink", { url })) as { removed: boolean }).removed, true);
	await assert.rejects(f.service.call(author.id, "unlink", {}), /requires url/);
	await assert.rejects(f.service.call(author.id, "unlink", { url, taskId: 1 }), /taskId/);
	await assert.rejects(f.service.call(author.id, "unlink", { url, taskId: "unknown" }), /Unknown task/);
	f.sessions["metas"].get(author.id)!.workspace = {
		source: f.project.path,
		upstream: "git@github.com:octo/repo.git",
		branch: "feat/work",
		base: "origin/main",
		jj: false,
	};
	await f.sessions.bindPullRequest(author.id, url, { sessionId: author.id }, task.id);
	await f.service.call(author.id, "link", { url, taskId: task.id, relationship: "reference" });
	const removed = (await f.service.call(author.id, "unlink", { url, taskId: task.id })) as {
		resource: { relationship: string };
	};
	assert.equal(removed.resource.relationship, "reference");
	await f.service.call(author.id, "unlink", { url, taskId: task.id });
	assert.deepEqual(f.sessions.get(author.id)?.boundPullRequests, [url]);
	// A member can still remove their ownership link when someone else's reference shares the scope.
	await f.service.call(author.id, "link", { url, taskId: task.id });
	const otherReference = (await f.service.call(member.id, "link", {
		url,
		taskId: task.id,
		relationship: "reference",
	})) as { id: string };
	const own = (await f.service.call(author.id, "unlink", { url, taskId: task.id })) as {
		resource: { relationship: string };
	};
	assert.equal(own.resource.relationship, "ownership");
	assert.equal(f.store.detail(mission.id).resources[0]?.id, otherReference.id);
});

test("failed coordinator model admission leaves the created mission without a coordinator or chat", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.sessions, "selectTaskModel", async () => {
		throw new Error("Model exceeds price cap");
	});
	await assert.rejects(
		f.service.create({ projectId: f.project.id, title: "Plan", startCoordinator: true }),
		/price cap/,
	);
	const mission = f.store.list()[0]!;
	assert.equal(mission.coordinatorSessionId, undefined);
	assert.deepEqual(f.store.members(mission.id), []);
	assert.equal(f.sessions.list().length, 0);
	assert.deepEqual(await readdir(join(f.home, "data", "sessions")), []);
});

test("start coordinator on an existing mission uses project defaults and rejects replacing a coordinator", async (t) => {
	const f = await fixture(t);
	await f.projects.update(f.project.id, { model: "test/project-default" });
	const { mission } = await f.service.create({ projectId: f.project.id, title: "Existing", goal: "Goal" });
	const session = await f.service.startCoordinator(mission.id, { message: "Review the existing brief." });
	assert.equal(f.store.require(mission.id).coordinatorSessionId, session.id);
	assert.equal(session.model, "test/project-default");
	const worker = await until(() => f.workers.get(session.id));
	assert.equal(worker.spec.mission?.coordinator, "self");
	const input = await until(() => worker.requests.find((command) => command.type === "input"));
	assert.match(input.type === "input" ? input.content : "", /Review the existing brief/);
	await assert.rejects(f.service.startCoordinator(mission.id), /already has a coordinator/);
	assert.equal(f.sessions.list().length, 1);
});

test("coordinator final admission failures remove saved metadata and leave no coordinator", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({ projectId: f.project.id, title: "Plan" });
	const spawnProject = f.sessions["missions"]!.spawnProject;
	t.mock.method(f.sessions["missions"]!, "spawnProject", (id: string) => {
		const project = spawnProject(id);
		f.store.update(id, { status: "done" });
		return project;
	});
	await assert.rejects(f.service.startCoordinator(mission.id), /Reopen/);
	assert.equal(f.store.require(mission.id).coordinatorSessionId, undefined);
	assert.deepEqual(f.store.members(mission.id), []);
	assert.equal(f.sessions.list().length, 0);
	assert.equal(f.workers.size, 0);
	assert.deepEqual(await readdir(join(f.home, "data", "sessions")), []);
});

test("concurrent coordinator starts admit only one chat and clean up the loser", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({ projectId: f.project.id, title: "Plan" });
	const results = await Promise.allSettled([
		f.service.startCoordinator(mission.id),
		f.service.startCoordinator(mission.id),
	]);
	assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
	assert.equal(f.sessions.list().length, 1);
	assert.equal(f.store.members(mission.id).length, 1);
	assert.equal((await readdir(join(f.home, "data", "sessions"))).length, 1);
	assert.equal(f.store.require(mission.id).coordinatorSessionId, f.store.members(mission.id)[0]);
});

test("coordinator admission rolls back membership and promotion if the bridge fails after joining", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({ projectId: f.project.id, title: "Plan" });
	const joinSpawn = f.sessions["missions"]!.joinSpawn;
	t.mock.method(f.sessions["missions"]!, "joinSpawn", (...args: Parameters<typeof joinSpawn>) => {
		joinSpawn(...args);
		throw new Error("admission failed");
	});
	await assert.rejects(f.service.startCoordinator(mission.id), /admission failed/);
	assert.equal(f.store.require(mission.id).coordinatorSessionId, undefined);
	assert.deepEqual(f.store.members(mission.id), []);
	assert.equal(f.sessions.list().length, 0);
	assert.equal(f.workers.size, 0);
	assert.deepEqual(await readdir(join(f.home, "data", "sessions")), []);
});

test("failed promoted admission drains queued metadata before removing the session", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({ projectId: f.project.id, title: "Plan" });
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let joined!: () => void;
	const joining = new Promise<void>((resolve) => {
		joined = resolve;
	});
	let id!: string;
	const joinSpawn = f.sessions["missions"]!.joinSpawn;
	t.mock.method(f.sessions["missions"]!, "joinSpawn", (...args: Parameters<typeof joinSpawn>) => {
		id = args[0];
		f.sessions["saving"].set(id, blocked);
		joinSpawn(...args); // Promotion queues its write behind an earlier save.
		joined();
		throw new Error("admission failed");
	});
	const rejection = assert.rejects(f.service.startCoordinator(mission.id), /admission failed/);
	try {
		await joining;
		assert.ok(f.sessions["metas"].has(id), "removal must wait for queued promotion and rollback writes");
	} finally {
		release();
	}
	await rejection;
	assert.equal(f.store.require(mission.id).coordinatorSessionId, undefined);
	assert.deepEqual(f.store.members(mission.id), []);
	assert.equal(f.sessions.list().length, 0);
	assert.equal(f.workers.size, 0);
	assert.deepEqual(await readdir(join(f.home, "data", "sessions")), []);
});

test("activity keeps recent user notes visible beyond the event window for every member", async (t) => {
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
		(await f.service.call(id, "activity", {})) as { recentUserNotes: Note[]; recentActivity: Note[] };
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

test("workspace refresh is role-scoped, idle-only, throttled and merge-triggered", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	const meta = f.sessions["require"](lead.id);
	meta.workspace = {
		source: f.project.path,
		base: "a".repeat(40),
		baseBranch: "main",
		jj: true,
		branch: "fix/previous",
		shared: { repository: "/owned", name: "lead" },
	};
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
	});
	f.service.join(member.id, { missionId: mission.id });
	f.sessions["require"](member.id).workspace = { ...meta.workspace };
	assert.equal(meta.workspace.branch, undefined, "promotion detaches the task bookmark without deleting it");
	await f.sessions["applyPullRequest"](meta, { branch: "fix/previous" });
	assert.equal(meta.workspace.branch, undefined, "discovery must not reattach the old task bookmark");
	const refresh = t.mock.method(f.sessions["sharedWorkspaces"], "refreshBase", async () => ({ base: "b".repeat(40) }));
	const worker = f.workers.get(lead.id)!;
	worker.state = "working";
	worker.busy = true;
	worker.onPacket({ type: "working", working: true });
	await f.sessions.refreshCoordinatorWorkspace(lead.id);
	await f.sessions.refreshCoordinatorWorkspace(member.id, true);
	assert.equal(refresh.mock.calls.length, 0);
	worker.state = "idle";
	worker.busy = false;
	worker.onPacket({ type: "working", working: false });
	await Promise.all([
		f.sessions.refreshCoordinatorWorkspace(lead.id),
		f.sessions.refreshCoordinatorWorkspace(lead.id),
	]);
	assert.equal(refresh.mock.calls.length, 1, "coalesced calls");
	assert.equal(f.sessions.get(lead.id)!.workspaceBase, "b".repeat(40));
	assert.ok(f.sessions.get(lead.id)!.workspaceUpdatedAt);
	await f.sessions.refreshCoordinatorWorkspace(lead.id);
	assert.equal(refresh.mock.calls.length, 1, "10 minute throttle");
	meta.workspaceCheckedAt! -= 10 * 60_000;
	worker.onPacket({ type: "workspace.prepare", callId: "turn" });
	await until(() => worker.sent.find((command) => command.type === "workspace.prepared" && command.callId === "turn"));
	assert.equal(refresh.mock.calls.length, 2, "next turn requests refresh after throttle expires");
	const task = f.store.addTask(mission.id, { title: "Linked change" }, {});
	const url = "https://github.com/org/repo/pull/59";
	f.store.addResource(mission.id, { url, taskId: task.id }, {});
	const pr = {
		number: 59,
		url,
		title: "Linked change",
		state: "merged" as const,
		branch: "fix/change",
		checkedAt: Date.now(),
	};
	worker.state = "working";
	worker.busy = true;
	worker.onPacket({ type: "working", working: true });
	f.sessions["missions"]!.pullRequestUpdated!(pr);
	await delay(5);
	assert.equal(refresh.mock.calls.length, 2, "merge waits for current work");
	assert.equal(meta.workspaceRefreshDue, true);
	worker.state = "idle";
	worker.busy = false;
	worker.onPacket({ type: "working", working: false });
	await until(() => refresh.mock.calls.length === 3);
	await f.sessions.refreshCoordinatorWorkspace(lead.id);
	f.sessions["missions"]!.pullRequestUpdated!(pr);
	assert.equal(refresh.mock.calls.length, 3, "unchanged merged state does not refetch");
});

test("conflicting workspace refresh leaves the base unchanged and posts one explanatory comment", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
	});
	const meta = f.sessions["require"](lead.id);
	meta.workspace = {
		source: f.project.path,
		base: "a".repeat(40),
		baseBranch: "main",
		jj: true,
		shared: { repository: "/owned", name: "lead" },
	};
	t.mock.method(f.sessions["sharedWorkspaces"], "refreshBase", async () => ({
		base: meta.workspace!.base,
		target: "b".repeat(40),
		behind: "Rebasing this chat's changes would conflict with the latest base.",
	}));
	await f.sessions.refreshCoordinatorWorkspace(lead.id);
	assert.equal(meta.workspace.base, "a".repeat(40));
	assert.equal(f.store.detail(mission.id).comments.length, 1);
	assert.match(f.store.detail(mission.id).comments[0]!.text, /behind main.*conflict/);
	assert.equal(f.sessions.get(lead.id)!.workspaceUpdatedAt, undefined);
	meta.workspaceCheckedAt! -= 10 * 60_000;
	await f.sessions.refreshCoordinatorWorkspace(lead.id);
	assert.equal(f.store.detail(mission.id).comments.length, 1, "same failure does not spam activity");
});

test("the first-request barrier includes a second merge arriving during an idle fetch", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	await f.service.create({ projectId: f.project.id, title: "M", fromSessionId: lead.id, draft: false });
	const meta = f.sessions["require"](lead.id);
	meta.workspace = {
		source: f.project.path,
		base: "a".repeat(40),
		baseBranch: "main",
		jj: true,
		shared: { repository: "/owned", name: "lead" },
	};
	const releases: (() => void)[] = [];
	let calls = 0;
	t.mock.method(f.sessions["sharedWorkspaces"], "refreshBase", async () => {
		const call = ++calls;
		await new Promise<void>((resolve) => {
			releases.push(resolve);
		});
		return { base: (call === 1 ? "b" : "c").repeat(40) };
	});
	const first = f.sessions.refreshCoordinatorWorkspace(lead.id);
	await until(() => calls === 1);
	const worker = f.workers.get(lead.id)!;
	worker.onPacket({ type: "workspace.prepare", callId: "barrier" });
	f.sessions.coordinatorBaseMerged(lead.id);
	releases[0]!();
	await until(() => calls === 2);
	assert.equal(
		worker.sent.some((command) => command.type === "workspace.prepared"),
		false,
	);
	releases[1]!();
	await first;
	const reply = await until(() => worker.sent.find((command) => command.type === "workspace.prepared"));
	assert.ok(reply.type === "workspace.prepared");
	assert.equal(reply.workspace?.base, "c".repeat(40));
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

test("a task-linked PR merge after the member finishes queues one grouped notice", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	await f.sessions.rename(member.id, "Implementation");
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
		tasks: [{ title: "Foundation" }],
	});
	f.service.join(member.id, { missionId: mission.id, taskId: "1" });
	f.service.notices.start();
	const open = {
		number: 42,
		url: "https://github.com/octo/repo/pull/42",
		title: "Foundation",
		state: "open" as const,
		checkedAt: Date.now(),
	};
	await f.sessions["applyPullRequest"](f.sessions["require"](member.id), { pullRequest: open });
	const settledAt = Date.now();
	f.workers
		.get(member.id)!
		.onPacket({ type: "working", working: false, completion: { outcome: "done", outcomeAt: settledAt } });
	const merged = { ...open, state: "merged" as const, mergedAt: Date.now(), checkedAt: Date.now() };
	await f.sessions["applyPullRequest"](f.sessions["require"](member.id), {
		pullRequest: merged,
		mergedAt: merged.mergedAt,
	});
	assert.equal(f.sessions.get(member.id)!.outcomeAt, settledAt);
	assert.equal(f.store.resolveTask(mission.id, "1").status, "done");
	assert.equal(f.store.events(mission.id).filter((event) => /PR #42 .*merged/.test(event.text)).length, 1);
	assert.equal(
		f.workers
			.get(lead.id)!
			.requests.filter((command) => command.type === "input" && command.requestId.startsWith("mission-notice:"))
			.length,
		0,
	);
	const now = Date.now() + 30_000;
	t.mock.method(Date, "now", () => now);
	await f.service.notices.flush(now);
	const notices = f.workers
		.get(lead.id)!
		.requests.filter((command) => command.type === "input" && command.requestId.startsWith("mission-notice:"));
	assert.equal(notices.length, 1);
	assert.match(
		(notices[0] as Extract<KernelCommand, { type: "input" }>).content,
		/PR #42 Foundation merged \(chat Implementation, task #1 marked done\)/,
	);
	await f.sessions["applyPullRequest"](f.sessions["require"](member.id), {
		pullRequest: { ...merged, checkedAt: now },
		mergedAt: merged.mergedAt,
	});
	assert.deepEqual(f.store.noticeDeadlines(now), []);
});

test("bound chat-only PRs are polled even while archived; references neither poll nor wake", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
	});
	f.service.join(member.id, { missionId: mission.id });
	const meta = f.sessions["require"](member.id);
	meta.workspace = {
		source: f.project.path,
		upstream: "git@github.com:octo/repo.git",
		branch: "feat/owned",
		base: "origin/main",
		jj: false,
	};
	const url = "https://github.com/octo/repo/pull/42";
	await f.sessions.bindPullRequest(member.id, url);
	assert.ok(
		[...f.sessions["missions"]!.linkedPullRequests!()].some((target) => target.url === url),
		"unknown bindings are linked polling targets",
	);
	const open = { number: 42, url, title: "Chat-only", state: "open" as const, checkedAt: Date.now() };
	await f.sessions["applyPullRequest"](meta, { pullRequest: open });
	const referenceUrl = "https://github.com/octo/repo/pull/43";
	f.store.addResource(mission.id, { url: referenceUrl });
	f.sessions["missions"]!.pullRequestUpdated!({
		...open,
		number: 43,
		url: referenceUrl,
		state: "merged",
		mergedAt: Date.now(),
	});
	assert.deepEqual(f.store.noticeDeadlines(Date.now()), []);
	await f.sessions.archive(member.id);
	assert.equal(f.store.detail(mission.id).resources.filter((r) => r.relationship === "ownership").length, 0);
	const targets = [...f.sessions["missions"]!.linkedPullRequests!()];
	assert.ok(targets.some((target) => target.url === url));
	assert.ok(!targets.some((target) => target.url === referenceUrl));
	const merged = { ...open, state: "merged" as const, checkedAt: Date.now() + 1, mergedAt: Date.now() };
	f.sessions["missions"]!.pullRequestUpdated!(merged);
	assert.match(f.store.prepareNotice(mission.id, lead.id, Date.now() + 30_000)!.content, /PR #42 Chat-only merged/);
	assert.equal(
		[...f.sessions["missions"]!.linkedPullRequests!()].find((target) => target.url === url)!.pullRequest!.state,
		"merged",
		"durable cache settles linked polling without mutating archived metadata",
	);
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
		mission: { title: string };
		tasks: Array<{ owner: string }>;
		briefRevision: number;
		counts: { decisions: number };
	};
	assert.equal(got.mission.title, "API v2");
	assert.equal(got.tasks[0]!.owner, "you");
	assert.equal(got.briefRevision, 1);
	assert.equal(got.counts.decisions, 1);
	const denied = await call("get", {}, f.workers.get(outsider.id)!);
	assert.match(denied.error ?? "", /not part of a mission/);
	await call("task", { title: "Docs" });
	const started = (await call("start", { id: "2" })).result as unknown as SessionSummary;
	assert.equal(started.missionId, mission.id);
	const memberWorker = await until(() => f.workers.get(started.id));
	const sent = await call("send", { targetSessionId: started.id, message: "Cover error cases" });
	assert.deepEqual(sent.result, { sessionId: started.id, sent: true, delivery: "delivered", mode: "followUp" });
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
		assert.deepEqual(worker.spec.mission?.decisions, []);
		assert.equal(worker.spec.mission?.remainingDecisions, 1);
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
			{ url: "https://linear.app/acme/issue/ENG-12/design" },
			{ url: "https://github.com/octo/repo/issues/42?x=1#fragment", title: "Issue" },
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
	assert.match(message, /ENG-12 \(linear\.issue\): https:\/\/linear\.app\/acme\/issue\/ENG-12/);
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
	const laterMessage = await content(later.id);
	for (const reference of [
		first.id,
		second.id,
		"https://github.com/octo/repo/issues/42",
		"https://linear.app/acme/issue/ENG-12/design",
	]) {
		assert.ok(laterMessage.includes(reference), `later chat inherits ${reference}`);
	}
});

test("artifact reference IPC reads pinned and latest sources for later members without waking the author", async (t) => {
	const f = await fixture(t);
	const author = await f.spawn();
	const reader = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: author.id,
		draft: false,
		tasks: [{ title: "A" }, { title: "B" }],
	});
	f.service.join(reader.id, { missionId: mission.id });
	const store = f.sessions["artifactStore"](author.id);
	const first = await store.create({ title: "Pinned", kind: "html", source: "PINNED SOURCE" });
	const latest = await store.create({ title: "Latest", kind: "html", source: "OLD SOURCE" });
	await f.service.linkArtifact(mission.id, { sessionId: author.id, artifactId: first.id, revision: 1, taskId: "1" });
	await f.service.linkArtifact(mission.id, { sessionId: author.id, artifactId: latest.id });
	await store.update(first.id, { title: "Pinned", kind: "html", source: "NEW SOURCE" });
	await store.update(latest.id, { title: "Latest", kind: "html", source: "LATEST SOURCE" });
	f.service.leave(author.id); // A persisted reference survives its author leaving the group.
	const worker = f.workers.get(reader.id)!;
	const sent = f.workers.get(author.id)!.sent.length;
	const requests = f.workers.get(author.id)!.requests.length;
	const read = async (id: string, revision?: number) => {
		const callId = `read:${worker.sent.length}`;
		worker.onPacket({ type: "artifact.reference.get", callId, id, revision });
		return await until(() =>
			worker.sent.find(
				(command): command is Extract<KernelCommand, { type: "artifact.reference.result" }> =>
					command.type === "artifact.reference.result" && command.callId === callId,
			),
		);
	};
	const pin = await read(first.id);
	assert.equal(pin.result?.source, "PINNED SOURCE");
	assert.equal(pin.result?.revision, 1);
	assert.equal(pin.result?.sessionId, author.id);
	assert.ok(!("html" in pin.result!));
	assert.equal((await read(latest.id)).result?.source, "LATEST SOURCE");
	assert.equal((await read(latest.id, 1)).result?.source, "OLD SOURCE");
	assert.match((await read(latest.id, 99)).error!, /revision/);
	assert.match((await read(first.id, 2)).error!, /not linked/);
	assert.equal(f.workers.get(author.id)!.sent.length, sent);
	assert.equal(f.workers.get(author.id)!.requests.length, requests);
	assert.deepEqual(await f.sessions.artifacts(reader.id), []);
	// Several task references can pin different revisions. Never silently select one.
	f.store.attachTaskReferences(
		mission.id,
		f.store.resolveTask(mission.id, "2").id,
		[{ ...f.store.detail(mission.id).artifacts.find((ref) => ref.artifactId === first.id)!, revision: 2 }],
		[],
	);
	assert.match((await read(first.id)).error!, /conflicting revisions/);
	assert.equal((await read(first.id, 2)).result?.source, "NEW SOURCE");
	f.store.unlinkArtifact(mission.id, first.id, undefined, "1");
	assert.equal((await read(first.id)).result?.revision, 2);
	f.store.unlinkArtifact(mission.id, first.id, undefined, "2");
	assert.match((await read(first.id)).error!, /not authorized/);
	f.store.attachTaskReferences(
		mission.id,
		f.store.resolveTask(mission.id, "2").id,
		[{ ...f.store.detail(mission.id).artifacts.find((ref) => ref.artifactId === latest.id)!, revision: 1 }],
		[],
	);
	assert.match((await read(latest.id)).error!, /conflicting revisions/);
	assert.equal((await read(latest.id, 2)).result?.source, "LATEST SOURCE");
	f.service.leave(reader.id);
	assert.match((await read(latest.id)).error!, /not authorized/);
});

test("artifact reference reads reject foreign sources, forged links and revoked access", async (t) => {
	const f = await fixture(t);
	const member = await f.spawn();
	const outsider = await f.spawn();
	const other = await f.spawn(f.other.id);
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: member.id,
		draft: false,
	});
	const foreignMission = await f.service.create({
		projectId: f.other.id,
		title: "Other",
		fromSessionId: other.id,
		draft: false,
	});
	const make = (id: string) =>
		f.sessions["artifactStore"](id).create({ title: "Private", kind: "html", source: "PRIVATE" });
	const own = await make(member.id);
	const foreign = await make(outsider.id);
	const crossProject = await make(other.id);
	await f.service.linkArtifact(foreignMission.mission.id, { sessionId: other.id, artifactId: crossProject.id });
	const read = (caller: string, id: string, revision?: number) =>
		f.service.readArtifactReference(caller, id, revision);
	const diskRead = t.mock.method(f.sessions, "artifact");
	for (const id of [own.id, foreign.id, crossProject.id, "missing", "../../foreign"]) {
		await assert.rejects(read(member.id, id), /not authorized/);
	}
	assert.equal(diskRead.mock.callCount(), 0, "denied IDs never reach a foreign store");
	await f.service.linkArtifact(mission.id, { sessionId: member.id, artifactId: own.id, revision: 1 });
	await assert.rejects(read(outsider.id, own.id), /not authorized/);
	await assert.rejects(read(other.id, own.id), /not authorized/);
	for (const revision of [0, -1, 1.5, NaN, Infinity])
		await assert.rejects(read(member.id, own.id, revision), /positive integer/);
	// Even a corrupted persisted link cannot cross project boundaries.
	f.store.join(other.id, mission.id);
	f.store.linkArtifact(mission.id, {
		artifactId: crossProject.id,
		sessionId: other.id,
		title: "Forged",
		kind: "html",
	});
	f.store.leave(other.id);
	await assert.rejects(read(member.id, crossProject.id), /own project/);
	const original = f.sessions.artifact.bind(f.sessions);
	t.mock.method(f.sessions, "artifact", async (...args: Parameters<SessionManager["artifact"]>) => {
		const result = await original(...args);
		f.store.unlinkArtifact(mission.id, own.id);
		return result;
	});
	await assert.rejects(read(member.id, own.id), /not authorized/);
	t.mock.method(f.sessions, "artifact", original);
	await f.service.linkArtifact(mission.id, { sessionId: member.id, artifactId: own.id });
	t.mock.method(f.sessions, "artifact", async (...args: Parameters<SessionManager["artifact"]>) => {
		const result = await original(...args);
		f.service.leave(member.id);
		return result;
	});
	await assert.rejects(read(member.id, own.id), /not authorized/);
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

for (const status of ["done", "archived"] as const) {
	test(`Start chat rejects ${status} missions before spawning and requires reopening`, async (t) => {
		const f = await fixture(t);
		const { mission } = await f.service.create({ projectId: f.project.id, title: "M", tasks: [{ title: "Auth" }] });
		const task = f.store.tasks(mission.id)[0]!;
		const spawn = t.mock.method(f.sessions, "spawn");
		f.store.update(mission.id, { status });
		await assert.rejects(f.service.startTask(mission.id, task.id), /Reopen the mission/);
		assert.equal(spawn.mock.callCount(), 0);
		assert.equal(f.sessions.list({ archived: "all" }).length, 0);
		assert.equal(f.workers.size, 0);
		assert.deepEqual(f.store.members(mission.id), []);
		assert.equal(f.store.task(mission.id, task.id).sessionId, undefined);
		assert.deepEqual(await readdir(join(f.home, "data", "sessions")), []);
		f.store.update(mission.id, { status: "active" });
		const session = await f.service.startTask(mission.id, task.id);
		assert.equal(session.missionId, mission.id);
		assert.equal(f.store.task(mission.id, task.id).sessionId, session.id);
	});

	test(`Start chat rejects a mission that becomes ${status} during model selection`, async (t) => {
		const f = await fixture(t);
		const { mission } = await f.service.create({ projectId: f.project.id, title: "M", tasks: [{ title: "Auth" }] });
		const task = f.store.tasks(mission.id)[0]!;
		const selectTaskModel = f.sessions.selectTaskModel.bind(f.sessions);
		t.mock.method(f.sessions, "selectTaskModel", async (...args: Parameters<typeof selectTaskModel>) => {
			const selection = await selectTaskModel(...args);
			f.store.update(mission.id, { status });
			return selection;
		});
		await assert.rejects(f.service.startTask(mission.id, task.id), /Reopen the mission/);
		assert.equal(f.sessions.list({ archived: "all" }).length, 0);
		assert.equal(f.workers.size, 0);
		assert.deepEqual(f.store.members(mission.id), []);
		assert.equal(f.store.task(mission.id, task.id).sessionId, undefined);
		assert.deepEqual(await readdir(join(f.home, "data", "sessions")), []);
	});

	test(`Start chat cleans up when the mission becomes ${status} during async spawn preparation`, async (t) => {
		const f = await fixture(t);
		const { mission } = await f.service.create({ projectId: f.project.id, title: "M", tasks: [{ title: "Auth" }] });
		const task = f.store.tasks(mission.id)[0]!;
		const joinSpawn = t.mock.method(f.sessions["missions"]!, "joinSpawn");
		let prepared!: () => void;
		const preparing = new Promise<void>((resolve) => {
			prepared = resolve;
		});
		const spawnProject = f.sessions["missions"]!.spawnProject;
		t.mock.method(f.sessions["missions"]!, "spawnProject", (missionId: string) => {
			const projectId = spawnProject(missionId);
			prepared();
			return projectId;
		});
		const pending = f.service.startTask(mission.id, task.id);
		await preparing;
		// spawn has checked the active status, then yielded to async directory/metadata preparation.
		f.store.update(mission.id, { status });
		await assert.rejects(pending, /Reopen the mission/);
		assert.equal(joinSpawn.mock.callCount(), 1, "the final admission guard ran after metadata was saved");
		assert.equal(f.sessions.list({ archived: "all" }).length, 0);
		assert.equal(f.workers.size, 0);
		assert.deepEqual(f.store.members(mission.id), []);
		assert.equal(f.store.task(mission.id, task.id).sessionId, undefined);
		assert.deepEqual(await readdir(join(f.home, "data", "sessions")), [], "no orphan survives restart");
	});
}

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
	assert.equal(worker.spec.mission?.id, mission.id);
	assert.ok(
		worker.sent.some(
			(command) => command.type === "mission.context" && command.context?.tasks[0]?.number === task.number,
		),
	);
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

test("only the current lead gets allowlisted subscription readings in status and start", async (t) => {
	const fetchedAt = Date.now();
	const source: SubscriptionUsageSource = {
		get: (provider) => ({
			provider,
			fetchedAt,
			windows: [
				{ label: "5-hour", usedPercent: 67.3, resetsAt: "2026-10-15T12:00:00Z" },
				{ label: "Weekly", usedPercent: 12.4, resetsAt: "2026-10-20T12:00:00Z" },
			],
			account: "private-account",
			cost: 100,
		}),
		start: async () => {},
		close() {},
	};
	const f = await fixture(t, undefined, source);
	const lead = await f.spawn();
	const worker = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Shared",
		fromSessionId: lead.id,
		draft: false,
		tasks: [{ title: "Implement" }],
	});
	f.service.join(worker.id, { missionId: mission.id });
	const status = (await f.service.call(lead.id, "status", {})) as { subscriptionUsage: unknown };
	const reading = { status: "current", fetchedAt, windows: source.get("anthropic")!.windows };
	assert.deepEqual(status.subscriptionUsage, {
		anthropic: reading,
		openai: reading,
	});
	assert.doesNotMatch(JSON.stringify(status), /private-account|cost|account/);
	const started = (await f.service.call(lead.id, "start", { id: "1" })) as {
		id: string;
		subscriptionUsage: unknown;
		usage?: unknown;
	};
	assert.deepEqual(started.subscriptionUsage, status.subscriptionUsage);
	assert.equal(started.usage, undefined);
	assert.equal(f.store.resolveTask(mission.id, "1").sessionId, started.id);
	for (const id of [worker.id, started.id]) {
		await assert.rejects(f.service.call(id, "status", {}), /Only the mission coordinator/);
		await assert.rejects(f.service.call(id, "start", { id: "1" }), /Only the mission coordinator/);
		for (const action of [
			"get",
			"tasks",
			"decisions",
			"links",
			"artifacts",
			"comments",
			"activity",
			"brief",
		] as const) {
			assert.doesNotMatch(
				JSON.stringify(await f.service.call(id, action, {})),
				/subscription|67\.3|12\.4|private-account/,
			);
		}
		assert.doesNotMatch(
			JSON.stringify(await f.service.call(id, "task", { id: "1" })),
			/subscription|67\.3|private-account/,
		);
	}
	// The raw start summary used to forward subscription errors and all session usage.
	t.mock.method(f.service, "startTask", async () => ({
		...worker,
		usage: { subscription: { fetchedAt, windows: [], error: "private-account" } },
	}));
	const filtered = await f.service.call(lead.id, "start", { id: "1" });
	assert.doesNotMatch(JSON.stringify(filtered), /private-account|"usage"/);
	f.store.update(mission.id, { coordinatorSessionId: worker.id });
	await assert.rejects(f.service.call(lead.id, "status", {}), /Only the mission coordinator/);
	assert.deepEqual(
		((await f.service.call(worker.id, "status", {})) as { subscriptionUsage: unknown }).subscriptionUsage,
		status.subscriptionUsage,
	);
	// Recheck authority after asynchronous spawn, not just before it.
	t.mock.method(f.service, "startTask", async () => {
		f.store.update(mission.id, { coordinatorSessionId: lead.id });
		return worker;
	});
	await assert.rejects(f.service.call(worker.id, "start", { id: "1" }), /Only the mission coordinator/);
});

test("status returns stale or unknown cache data while a provider refresh is stalled", async (t) => {
	const fetchedAt = Date.now() - SUBSCRIPTION_USAGE_MAX_AGE_MS;
	let release!: () => void;
	const stalled = new Promise<void>((resolve) => {
		release = resolve;
	});
	t.after(release);
	let starts = 0;
	const source: SubscriptionUsageSource = {
		get: (provider) =>
			provider === "anthropic"
				? { fetchedAt, windows: [{ label: "5h", usedPercent: 70 }] }
				: { fetchedAt, windows: [], error: "private provider failure" },
		start: async () => {
			if (++starts > 1) await stalled;
		},
		close() {},
	};
	const f = await fixture(t, undefined, source);
	const lead = await f.spawn();
	await f.service.create({ projectId: f.project.id, title: "Shared", fromSessionId: lead.id, draft: false });
	const refreshing = source.start();
	const workerCount = f.workers.size;
	const before = performance.now();
	const result = await Promise.race([
		f.service.call(lead.id, "status", {}),
		delay(250).then(() => {
			throw new Error("status blocked on a provider");
		}),
	]);
	assert.ok(performance.now() - before < 250);
	assert.deepEqual((result as { subscriptionUsage: unknown }).subscriptionUsage, {
		anthropic: { status: "stale", fetchedAt, windows: [{ label: "5h", usedPercent: 70, resetsAt: null }] },
		openai: { status: "unknown", windows: [] },
	});
	assert.equal(starts, 2, "status never requests another refresh");
	assert.equal(f.workers.size, workerCount);
	release();
	await refreshing;
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
	await assert.rejects(
		f.service.call(coordinator.id, "send", { targetSessionId: member.id, message: "Text", mode: "bad" }),
		/mode must be/,
	);
	const worker = f.workers.get(member.id)!;
	await until(() => worker.requests.find((command) => command.type === "input"));
	for (const [state, mode] of [
		["idle", "steer"],
		["working", "steer"],
		["working", "followUp"],
	] as const) {
		worker.state = state;
		worker.onPacket({ type: "working", working: state === "working" });
		const message = `Continue while ${state} ${mode}`;
		const result = await f.service.call(coordinator.id, "send", { targetSessionId: member.id, message, mode });
		assert.deepEqual(result, {
			sessionId: member.id,
			sent: true,
			delivery: state === "working" ? "queued" : "delivered",
			mode,
		});
		const input = await until(() =>
			worker.requests.find((command) => command.type === "input" && command.content === message),
		);
		assert.ok(input?.type === "input");
		assert.equal(input.content, message);
		assert.equal(input.mode, mode);
	}
	worker.state = "idle";
	worker.onPacket({ type: "working", working: false });
	await until(() => !f.sessions["starting"].has(member.id));
	await f.sessions.archive(member.id);
	assert.deepEqual(await f.service.call(coordinator.id, "send", { targetSessionId: member.id, message: "Continue" }), {
		sessionId: member.id,
		sent: false,
		delivery: "rejected",
		mode: "followUp",
		reason: "archived",
		error: "Restore the archived session before sending a message",
	});
	f.service.leave(member.id);
	await assert.rejects(
		f.service.call(coordinator.id, "send", { targetSessionId: member.id, message: "Continue" }),
		/not in this mission/,
	);
	t.mock.method(f.sessions, "sendReported", async () => {
		throw new Error("Delivery failed");
	});
	await assert.rejects(
		f.service.call(coordinator.id, "send", { targetSessionId: coordinator.id, message: "Continue" }),
		/Delivery failed/,
	);
});

for (const acknowledgement of ["queued", "missing"] as const) {
	test(`coordinator send uses the kernel's ${acknowledgement} acknowledgement rather than an idle state guess`, async (t) => {
		const f = await fixture(t);
		const coordinator = await f.spawn();
		const member = await f.spawn();
		const { mission } = await f.service.create({
			projectId: f.project.id,
			title: "M",
			fromSessionId: coordinator.id,
			draft: false,
		});
		f.service.join(member.id, { missionId: mission.id });
		const worker = f.workers.get(member.id)!;
		assert.equal(worker.state, "idle");
		t.mock.method(worker, "request", async (command: KernelCommand) => {
			assert.equal(command.type, "input");
			if (command.type !== "input") return;
			assert.equal(command.reportDelivery, true);
			if (acknowledgement === "queued")
				worker.onPacket({ type: "accepted", requestId: command.requestId, delivery: "queued" });
		});
		const sent = f.service.call(coordinator.id, "send", { targetSessionId: member.id, message: "Continue" });
		if (acknowledgement === "queued")
			assert.deepEqual(await sent, { sessionId: member.id, sent: true, delivery: "queued", mode: "followUp" });
		else await assert.rejects(sent, /acknowledgement is uncertain/);
		assert.equal(f.sessions["deliveryReports"].size, 0);
	});
}

for (const outcome of ["failed", "archived", "stopped", "parked"] as const) {
	test(`coordinator send reports ${outcome} admission without claiming a dropped message was delivered`, async (t) => {
		const f = await fixture(t);
		const coordinator = await f.spawn();
		const member = await f.spawn();
		const { mission } = await f.service.create({
			projectId: f.project.id,
			title: "M",
			fromSessionId: coordinator.id,
			draft: false,
		});
		f.service.join(member.id, { missionId: mission.id });
		const worker = f.workers.get(member.id)!;
		const before = worker.requests.length;
		if (outcome === "failed") {
			worker.state = "failed";
			worker.error = "Model unavailable";
		}
		if (outcome === "archived") await f.sessions.archive(member.id);
		if (outcome === "parked") {
			await f.sessions["unparked"](member.id);
			f.sessions["workers"].delete(member.id);
		}
		let release!: () => void;
		let saved!: () => void;
		const saving = new Promise<void>((resolve) => {
			saved = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		t.after(() => release());
		if (outcome === "stopped") {
			const save = f.sessions["save"].bind(f.sessions);
			let gated = false;
			t.mock.method(f.sessions, "save" as never, async (...args: Parameters<typeof save>) => {
				if (
					!gated &&
					args[0].id === member.id &&
					args[0].pending?.some(
						(command) => command.type === "input" && command.requestId.startsWith("mission:send:"),
					)
				) {
					gated = true;
					saved();
					await gate;
				}
				return save(...args);
			});
		}
		const sent = f.service.call(coordinator.id, "send", { targetSessionId: member.id, message: "Continue" });
		if (outcome === "stopped") {
			await saving;
			await f.sessions.stop(member.id);
			release();
		}
		const result = await sent;
		if (outcome === "stopped") {
			assert.deepEqual(result, { sessionId: member.id, sent: true, delivery: "queued", mode: "followUp" });
			assert.ok(
				worker.requests.slice(before).some((command) => command.type === "input" && command.content === "Continue"),
			);
		} else if (outcome === "parked") {
			assert.deepEqual(result, { sessionId: member.id, sent: true, delivery: "delivered", mode: "followUp" });
			assert.notEqual(f.workers.get(member.id), worker);
			assert.ok(
				f.workers
					.get(member.id)
					?.requests.some((command) => command.type === "input" && command.content === "Continue"),
			);
		} else {
			assert.deepEqual(result, {
				sessionId: member.id,
				sent: false,
				delivery: "rejected",
				mode: "followUp",
				reason: outcome,
				...(outcome === "failed" ? { error: "Model unavailable" } : {}),
				...(outcome === "archived" ? { error: "Restore the archived session before sending a message" } : {}),
			});
			assert.ok(
				!worker.requests
					.slice(before)
					.some((command) => command.type === "input" && command.content === "Continue"),
			);
		}
		assert.equal(f.sessions["deliveryReports"].size, 0);
		if (outcome === "archived") {
			await f.sessions.restore(member.id);
			assert.deepEqual(
				await f.service.call(coordinator.id, "send", { targetSessionId: member.id, message: "Restored" }),
				{ sessionId: member.id, sent: true, delivery: "delivered", mode: "followUp" },
			);
		}
	});
}

test("status and get report idle chats with live jobs as waiting, not done", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	await f.sessions.rename(member.id, "Background tests");
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
	});
	f.service.join(member.id, { missionId: mission.id });
	await until(() => f.workers.get(member.id)!.requests.find((command) => command.type === "input"));
	const worker = f.workers.get(member.id)!;
	const jobs = [{ id: "tests", name: "Tests", state: "running" as const, startedAt: 1, outputPath: "/tmp/tests.log" }];
	worker.state = "idle";
	worker.onPacket({ type: "jobs.changed", jobs });
	worker.onPacket({ type: "working", working: false, completion: { outcome: "done", outcomeAt: Date.now() } });
	const status = (await f.service.call(lead.id, "status", {})) as { members: Array<Record<string, unknown>> };
	const reported = status.members.find((chat) => chat.id === member.id)!;
	assert.equal(reported.state, "waiting on background job");
	assert.equal(reported.outcome, undefined);
	assert.deepEqual(reported.runningJobs, [{ id: "tests", name: "Tests", startedAt: 1 }]);
	const get = (await f.service.call(lead.id, "get", {})) as { members: Array<Record<string, unknown>> };
	assert.equal(get.members.find((chat) => chat.title === "Background tests")?.state, "waiting on background job");
	worker.onPacket({ type: "jobs.changed", jobs: [] });
	const done = (await f.service.call(lead.id, "status", {})) as { members: Array<Record<string, unknown>> };
	assert.equal(done.members.find((chat) => chat.id === member.id)?.outcome, "done");
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
	const catalog = new ModelCatalog(f.home);
	const cappedModels = { models: [{ id: "test/small", provider: "test", name: "Small" }] };
	const modelList = t.mock.method(catalog, "listTaskModels", async () => cappedModels);
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		catalog,
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
	const choices = await api(`/models?projectId=${f.project.id}&purpose=task-start`);
	assert.equal(choices.status, 200);
	assert.deepEqual(await choices.json(), cappedModels);
	assert.deepEqual(modelList.mock.calls[0]?.arguments, [f.project.path]);
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
	const decisionBody = (await decision.json()) as { id: string; audience: string };
	assert.equal(decisionBody.audience, "reference");
	const tagged = await api(`/missions/${id}/decisions/${decisionBody.id}`, {
		method: "PATCH",
		body: JSON.stringify({ audience: "all" }),
	});
	assert.equal(tagged.status, 200);
	assert.equal(((await tagged.json()) as { audience: string; text: string }).audience, "all");
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
	const unassigned = f.store.addTask(id, { title: "Reopen before starting" });
	const beforeSessions = f.sessions.list({ archived: "all" }).map((session) => session.id);
	const beforeMembers = f.store.members(id);
	const beforeFiles = (await readdir(join(f.home, "data", "sessions"))).sort();
	const spawn = t.mock.method(f.sessions, "spawn");
	for (const status of ["done", "archived"] as const) {
		const inactive = await api(`/missions/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
		assert.equal(inactive.status, 200);
		await inactive.arrayBuffer();
		const inactiveSpawn = await api("/sessions", {
			method: "POST",
			body: JSON.stringify({ missionId: id, message: "hello" }),
		});
		assert.equal(inactiveSpawn.status, 409);
		await inactiveSpawn.arrayBuffer();
		const spawnCalls = spawn.mock.callCount();
		const inactiveStart = await api(`/missions/${id}/tasks/${unassigned.id}/start`, {
			method: "POST",
			body: "{}",
		});
		assert.equal(inactiveStart.status, 409);
		assert.match(await inactiveStart.text(), /Reopen the mission/);
		const inactiveCoordinator = await api(`/missions/${id}/coordinator/start`, { method: "POST", body: "{}" });
		assert.equal(inactiveCoordinator.status, 409);
		assert.match(await inactiveCoordinator.text(), /Reopen the mission/);
		assert.equal(spawn.mock.callCount(), spawnCalls, "REST rejects before spawning");
		assert.deepEqual(
			f.sessions.list({ archived: "all" }).map((session) => session.id),
			beforeSessions,
		);
		assert.deepEqual(f.store.members(id), beforeMembers);
		assert.equal(f.store.task(id, unassigned.id).sessionId, undefined);
		assert.deepEqual((await readdir(join(f.home, "data", "sessions"))).sort(), beforeFiles);
	}
	const reopened = await api(`/missions/${id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
	assert.equal(reopened.status, 200);
	await reopened.arrayBuffer();
	const restarted = await api(`/missions/${id}/tasks/${unassigned.id}/start`, { method: "POST", body: "{}" });
	assert.equal(restarted.status, 201);
	const restartedChat = (await restarted.json()) as SessionSummary;
	assert.equal(restartedChat.missionId, id);
	assert.equal(f.store.task(id, unassigned.id).sessionId, restartedChat.id);
	const startedCoordinator = await api(`/missions/${id}/coordinator/start`, {
		method: "POST",
		body: JSON.stringify({ message: "Review the current plan", thinking: "high" }),
	});
	assert.equal(startedCoordinator.status, 201);
	const lead = (await startedCoordinator.json()) as SessionSummary;
	assert.equal(lead.missionId, id);
	assert.equal(f.store.require(id).coordinatorSessionId, lead.id);
	const duplicateCoordinator = await api(`/missions/${id}/coordinator/start`, { method: "POST", body: "{}" });
	assert.equal(duplicateCoordinator.status, 409);
	await duplicateCoordinator.arrayBuffer();
	const missing = await api("/missions/nope");
	assert.equal(missing.status, 404);
	await missing.arrayBuffer();
	const removed = await api(`/missions/${id}`, { method: "DELETE" });
	assert.equal(removed.status, 200);
	await removed.arrayBuffer();
	assert.equal(f.sessions.get(chat.id)?.missionId, undefined);
});
test("release accepts claim selectors, enforces ownership and reads claimant titles and IDs", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	const outsider = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
		tasks: [{ title: "A" }, { title: "B" }, { title: "C" }],
	});
	f.service.join(member.id, { missionId: mission.id, taskId: "1" });
	f.store.claimTask(mission.id, "2", lead.id);
	f.store.claimTask(mission.id, "3", member.id);
	for (const action of ["get", "tasks"] as const) {
		const read = (await f.service.call(member.id, action, {})) as {
			tasks: Array<{ owner: string }>;
		};
		assert.equal(read.tasks[0]!.owner, "you");
	}
	await assert.rejects(f.service.call(member.id, "release", { id: "2" }), /only the coordinator/);
	await assert.rejects(f.service.call(outsider.id, "release", { ids: ["1-3"] }), /not part of a mission/);
	for (const args of [{}, { id: "1", ids: ["2"] }, { ids: "1" }, { ids: ["3-1"] }, { ids: ["1-1001"] }]) {
		await assert.rejects(f.service.call(lead.id, "release", args));
	}
	const batch = (await f.service.call(member.id, "release", { id: "1-2, #1,99" })) as {
		released: Array<{ number: number }>;
		skipped: unknown[];
	};
	assert.deepEqual(
		batch.released.map((task) => task.number),
		[1],
	);
	assert.equal(batch.skipped.length, 2);
	const single = (await f.service.call(lead.id, "release", { id: "2" })) as { status: string; sessionId?: string };
	assert.equal(single.status, "todo");
	assert.equal(single.sessionId, undefined);
	const remaining = (await f.service.call(lead.id, "release", { ids: ["3"] })) as typeof batch;
	assert.deepEqual(
		remaining.released.map((task) => task.number),
		[3],
	);
});

test("status flags idle claimed work without a viable PR, excluding inactive and busy chats", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
		tasks: [{ title: "Implement" }],
	});
	f.service.join(member.id, { missionId: mission.id, taskId: "1" });
	const base = { ...f.sessions.get(member.id)!, state: "idle" as const, branch: "feat/example" };
	const coordinator = { ...f.sessions.get(lead.id)!, state: "idle" as const, outcome: "done" as const };
	f.store.addTask(mission.id, { title: "Lead work", sessionId: lead.id, status: "in_progress" });
	let summary: SessionSummary = base;
	t.mock.method(f.sessions, "list", () => [coordinator, summary]);
	t.mock.method(f.sessions, "history", () => {
		throw new Error("Full status must not read history");
	});
	const status = async () => {
		const result = (await f.service.call(lead.id, "status", {})) as { members: Array<Record<string, unknown>> };
		assert.equal(result.members[0]!.finishedWithoutPR, false);
		return result.members[1]!;
	};
	assert.equal((await status()).finishedWithoutPR, true);
	assert.equal((await status()).branch, "feat/example");
	for (const state of ["open", "draft", "merged", "closed"] as const) {
		const pr = {
			number: 7,
			url: "https://github.com/octo/repo/pull/7",
			title: "Verbose PR title",
			state,
			checkedAt: 1,
		};
		summary = { ...base, pullRequests: [pr] };
		const row = await status();
		assert.equal(row.finishedWithoutPR, state === "closed");
		assert.deepEqual(row.pullRequests, [{ number: 7, state, draft: state === "draft" }]);
		// Older summaries only have the primary PR.
		summary = { ...base, pullRequest: pr };
		assert.equal((await status()).finishedWithoutPR, state === "closed");
	}
	for (const overrides of [
		{ state: "parked" as const, outcome: "done" as const },
		{ state: "working" as const },
		{ state: "starting" as const },
		{ state: "failed" as const },
		{ archivedAt: 42 },
		{
			runningJobs: [
				{ id: "j1", name: "Test", startedAt: 1, state: "running" as const, outputPath: "/tmp/test.log" },
			],
		},
	]) {
		summary = { ...base, ...overrides };
		assert.equal((await status()).finishedWithoutPR, false);
	}
	const task = f.store.resolveTask(mission.id, "1");
	f.store.updateTask(mission.id, task.id, { status: "done" });
	summary = base;
	assert.equal((await status()).finishedWithoutPR, false);
	summary = { ...base, outcome: "done" };
	assert.equal((await status()).finishedWithoutPR, true);
	f.store.updateTask(mission.id, task.id, { status: "dropped" });
	assert.equal((await status()).finishedWithoutPR, false);
	f.store.releaseTask(mission.id, task.id, { sessionId: member.id });
	assert.equal((await status()).finishedWithoutPR, false);
});

test("targeted status reads only one member and a truncated last assistant reply without waking workers", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	const outsider = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
		tasks: [{ title: "Implement" }],
	});
	f.service.join(member.id, { missionId: mission.id, taskId: "1" });
	f.workers
		.get(member.id)!
		.onPacket({ type: "working", working: false, completion: { outcome: "done", outcomeAt: 42 } });
	const requests = [...f.workers.values()].map((worker) => worker.requests.length);
	const events = f.store.events(mission.id);
	t.mock.method(f.sessions, "list", () => {
		throw new Error("Targeted status must not list all chats");
	});
	const reply = "A".repeat(1800);
	let reads = 0;
	t.mock.method(f.sessions, "history", async (id: string, before: number, limit: number) => {
		assert.equal(id, member.id);
		assert.equal(limit, 64);
		reads++;
		if (before === Number.MAX_SAFE_INTEGER)
			return { entries: [{ id: 10, kind: "pi.tool-result", model: [] }], more: true };
		assert.equal(before, 10);
		return {
			entries: [
				{
					id: 7,
					kind: "pi.assistant",
					model: [{ role: "assistant", content: [{ type: "text", text: "Old reply" }] }],
				},
				{
					id: 8,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "Do not expose" },
								{ type: "text", text: reply },
							],
						},
					],
				},
				{ id: 9, kind: "pi.user", model: [{ role: "user", content: "Latest user input" }] },
			],
			more: false,
		};
	});
	const result = (await f.service.call(lead.id, "status", { targetSessionId: member.id })) as {
		subscriptionUsage: unknown;
		member: Record<string, unknown>;
	};
	assert.deepEqual(Object.keys(result), ["subscriptionUsage", "member"]);
	assert.deepEqual(result.subscriptionUsage, f.sessions.subscriptionUsageSnapshot());
	assert.equal(result.member.id, member.id);
	assert.equal(result.member.state, "idle");
	assert.equal(result.member.outcome, "done");
	assert.equal(result.member.outcomeAt, 42);
	assert.equal(result.member.lastAssistantReply, reply.slice(0, 1500));
	assert.equal(result.member.finishedWithoutPR, true);
	assert.deepEqual(result.member.tasks, [{ number: 1, title: "Implement", status: "in_progress" }]);
	assert.equal(reads, 2);
	for (const targetSessionId of [outsider.id, "unknown"])
		await assert.rejects(f.service.call(lead.id, "status", { targetSessionId }), /not in this mission/);
	for (const targetSessionId of ["", " ", 1, null])
		await assert.rejects(f.service.call(lead.id, "status", { targetSessionId }), /non-empty targetSessionId/);
	await assert.rejects(f.service.call(member.id, "status", { targetSessionId: member.id }), /coordinator/);
	assert.equal(reads, 2);
	t.mock.method(f.sessions, "history", async () => ({ entries: [], more: false }));
	assert.equal(await f.sessions.lastAssistantReply(member.id, 1500), undefined);
	assert.deepEqual(
		[...f.workers.values()].map((worker) => worker.requests.length),
		requests,
	);
	assert.deepEqual(f.store.events(mission.id), events);
});

test("held and discarded message events wake the lead once, survive outbox replay, and never re-send the message", async (t) => {
	const f = await fixture(t);
	const coordinator = await f.spawn();
	const member = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: coordinator.id,
		draft: false,
	});
	f.service.join(member.id, { missionId: mission.id });
	const worker = f.workers.get(member.id)!;
	const initial = worker.requests.length;
	const held = {
		id: "1:1",
		requestId: `mission:send:${mission.id}:example`,
		state: "held",
		preview: "Fix the edge case",
	} as const;
	const discarded = { ...held, id: "1:2", state: "discarded" } as const;
	for (const event of [held, held, discarded, discarded]) worker.onPacket({ type: "systemMessageState", event });
	const updates = f.store.detail(mission.id).events.filter((event) => event.text.includes(":example"));
	assert.equal(updates.length, 2);
	assert.ok(updates.some((event) => event.text.includes("held because the user stopped the chat")));
	assert.ok(updates.some((event) => event.text.includes("discarded by the user")));
	assert.equal(worker.sent.filter((command) => command.type === "systemMessageState.ack").length, 4);
	const now = Date.now() + 60_000;
	f.store.setNoticeActivity(mission.id, false, now - 60_000);
	const notice = f.store.prepareNotice(mission.id, coordinator.id, now);
	assert.match(notice!.content, /held because the user stopped the chat/);
	assert.match(notice!.content, /discarded by the user/);
	assert.equal(worker.requests.length, initial, "lifecycle events must not auto-requeue input");
	await f.sessions.heldMessages(member.id, "send");
	await f.sessions.heldMessages(member.id, "discard");
	await f.sessions.heldMessages(member.id, "discard", 42);
	assert.deepEqual(
		worker.requests.slice(initial).map((command) => command.type),
		["sendHeldMessages", "discardHeldMessages", "discardHeldMessages"],
	);
});
