import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { KernelCommand, KernelPacket, KernelSpec } from "@pilot/kernel";
import type { MissionDetail, ServerMessage, SessionState, SessionSummary } from "@pilot/protocol";
import { WebSocket } from "ws";
import { Conflict } from "./errors.ts";
import { draftMessage, MissionService } from "./mission-service.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import type { PullRequestOptions } from "./pull-requests.ts";
import { createDaemonServer } from "./server.ts";
import { CommandRejected, SessionManager, type SessionWorker } from "./sessions.ts";
import { SUBSCRIPTION_USAGE_MAX_AGE_MS, type SubscriptionUsageSource } from "./subscription-usage.ts";
import { TerminalManager } from "./terminals.ts";
import { legacyGitHub } from "./testing/legacy-github.ts";
import { requiredAuthRegistration } from "./testing/required-auth.ts";

test("coordinator tools associate, explicitly upgrade and split Linear ticket work with live context", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn(),
		member = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Delivery",
		fromSessionId: lead.id,
		draft: false,
	});
	f.service.join(member.id, { missionId: mission.id });
	const ref = (await f.service.call(lead.id, "link", { url: "https://linear.app/acme/issue/ENG-12" })) as {
		id: string;
		linearRole: string;
	};
	assert.equal(ref.linearRole, "reference");
	await assert.rejects(
		f.service.call(lead.id, "link", { url: "https://linear.app/acme/issue/ENG-12", linearRole: "managed" }),
		/PATCH/,
	);
	await assert.rejects(
		f.service.call(member.id, "updateLink", { resourceId: ref.id, linearRole: "managed" }),
		/Only the mission coordinator/,
	);
	await f.service.call(lead.id, "updateLink", { resourceId: ref.id, linearRole: "managed" });
	await assert.rejects(
		f.service.call(member.id, "split", { resourceId: ref.id, tasks: [{ title: "A" }] }),
		/Only the mission coordinator/,
	);
	const split = (await f.service.call(lead.id, "split", {
		resourceId: ref.id,
		tasks: [{ title: "A" }, { title: "B" }],
	})) as { tasks: { id: string }[] };
	const existing = f.store.addTask(mission.id, { title: "Context only" });
	await f.service.call(lead.id, "link", { taskId: existing.id, url: "https://linear.app/acme/issue/ENG-12" });
	f.store.claimTask(mission.id, split.tasks[0]!.id, member.id);
	assert.equal(f.service.context(lead.id)?.tickets?.[0]?.role, "managed");
	assert.equal(f.service.context(member.id)?.tickets?.[0]?.role, "contribution");
	const links = (await f.service.call(lead.id, "links", {})) as {
		links: { resourceId?: string; linearRole?: string }[];
	};
	assert.ok(links.links.some((ref) => ref.linearRole === "managed" && ref.resourceId));
	f.service.setLinearReader({
		call: async () => ({
			id: "ENG-12",
			url: "https://linear.app/acme/issue/ENG-12",
			title: "Ticket",
			description: "Untrusted text",
		}),
	});
	const context = (await f.service.call(lead.id, "ticket", { resourceId: ref.id })) as { description: string };
	assert.equal(context.description, "Untrusted text");
	assert.equal(JSON.stringify(f.service.context(lead.id)).includes("Untrusted text"), false);
	// Detach first so the context read can observe removal during its await.
	for (const resource of f.store.detail(mission.id).resources.filter((ref) => ref.linearRole === "contribution"))
		f.store.removeResource(mission.id, resource.id);
	f.service.setLinearReader({
		call: async () => {
			f.store.removeResource(mission.id, ref.id);
			return { id: "ENG-12", url: "https://linear.app/acme/issue/ENG-12" };
		},
	});
	await assert.rejects(f.service.call(lead.id, "ticket", { resourceId: ref.id }), /not found/);
});

test("mission drafts name the deliverables without repeating comment policy", () => {
	const message = draftMessage("Plan");
	assert.match(message, /short goal and draft the brief \(scope and requirements\)/);
	assert.match(message, /record agreed choices with decide/);
	assert.match(message, /create tasks with current status.*dependencies where order matters/);
	assert.match(message, /Do not start implementing tasks/);
	assert.doesNotMatch(message, /comments|resolve|reminders|decision ledger/);
});

test("PR guidance tool forwards live safeguards and recomputes task/link eligibility", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Delivery",
		fromSessionId: lead.id,
		draft: false,
	});
	const url = "https://linear.app/acme/issue/ENG-12";
	const manager = f.store.addResource(mission.id, { url, linearRole: "managed" });
	const task = f.store.addTask(mission.id, { title: "Only work" });
	f.store.addResource(mission.id, { url, taskId: task.id, linearRole: "contribution" });
	const guidance = async () =>
		(await f.service.call(lead.id, "prGuidance", { taskId: String(task.number) })) as {
			tickets: { closingAllowed: boolean; directive: string }[];
		};
	assert.equal((await guidance()).tickets[0]!.closingAllowed, false);
	f.service.setLinearClosingGuard(async (id, ref) => {
		assert.equal(id, mission.id);
		assert.equal(ref, manager.id);
		return { allowed: true };
	});
	assert.equal((await guidance()).tickets[0]!.directive, "Closes ENG-12");
	const earlier = f.store.addTask(mission.id, { title: "Another contributor" });
	f.store.addResource(mission.id, { url, taskId: earlier.id, linearRole: "contribution" });
	assert.equal((await guidance()).tickets[0]!.directive, "Related to ENG-12");
	await assert.rejects(f.service.call(lead.id, "prGuidance", {}), /requires taskId/);
});

test("coordinator start and status return navigable chat links without starting status targets", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Delivery",
		fromSessionId: lead.id,
		draft: false,
	});
	const task = f.store.addTask(mission.id, { title: "Implementation" });
	const started = (await f.service.call(lead.id, "start", { id: task.id })) as { id: string; chatUrl: string };
	assert.equal(started.chatUrl, `pilot://chat/${started.id}`);
	assert.equal(new URL(started.chatUrl).pathname, `/${started.id}`);
	const status = (await f.service.call(lead.id, "status", {})) as { members: { id: string; chatUrl: string }[] };
	assert.equal(status.members.find((member) => member.id === started.id)?.chatUrl, started.chatUrl);
	assert.equal(status.members.find((member) => member.id === lead.id)?.chatUrl, `pilot://chat/${lead.id}`);
	await until(() => !f.sessions["starting"].has(started.id));
	await f.sessions.stop(started.id);
	await f.sessions.archive(started.id);
	const spawn = t.mock.method(f.sessions, "spawn", async () => assert.fail("Reading status must not spawn a chat"));
	const targeted = (await f.service.call(lead.id, "status", { targetSessionId: started.id })) as {
		member: { id: string; chatUrl: string; archivedAt: number };
	};
	assert.equal(targeted.member.chatUrl, started.chatUrl);
	assert.equal(targeted.member.id, started.id);
	assert.ok(targeted.member.archivedAt);
	assert.equal(spawn.mock.calls.length, 0);
});

test("gated starts retain preferred model, thinking and app start options together", async (t) => {
	const f = await fixture(t);
	const { id } = f.store.create({ projectId: f.project.id, title: "Combined" });
	const first = f.store.addPhase(id, { name: "Build" });
	const later = f.store.addPhase(id, { name: "Ship" });
	f.store.addTask(id, { title: "Earlier", phaseId: first.id });
	const task = await f.service.addTask(id, {
		title: "Later",
		phaseId: later.id,
		preferredModel: "test/preferred",
		preferredThinking: "high",
	});
	f.store.update(id, { phaseGating: true });
	await f.service.updateTask(id, task.id, { phaseId: later.id, preferredThinking: "low" });
	const gated = f.store.task(id, task.id);
	assert.deepEqual(
		[gated.phaseId, gated.preferredModel, gated.preferredThinking, gated.storedStatus],
		[later.id, "test/preferred", "low", "todo"],
	);
	await assert.rejects(f.service.startTask(id, task.id), /earlier phases/);
	await assert.rejects(
		f.service.startTask(id, task.id, { overridePhaseGating: true }, "coordinator"),
		/Only the user/,
	);
	const links = [{ url: "https://example.com/spec" }];
	await assert.rejects(
		f.service.startTask(id, task.id, { overridePhaseGating: true, baseBranch: "release", links }),
		/private-clone project/,
	);
	assert.equal(f.store.detail(id).resources.length, 0);
	const spawn = t.mock.method(f.sessions, "spawn", f.sessions.spawn.bind(f.sessions));
	const started = await f.service.startTask(id, task.id, {
		overridePhaseGating: true,
		mode: "ask",
		baseBranch: "release",
		message: "Investigate only",
		links,
	});
	const request = spawn.mock.calls[0]!.arguments[0];
	assert.deepEqual([request.model, request.thinking, started.mode], ["test/preferred", "low", "ask"]);
	assert.equal(request.baseBranch, "release");
	assert.equal(f.store.task(id, task.id).storedStatus, "in_progress");
	assert.equal(f.store.task(id, task.id).preferredModelSetBy, "user");
	assert.deepEqual(
		f.store.detail(id).resources.map((resource) => resource.url),
		[links[0]!.url],
	);
});

test("phase tools enforce roles, assign by name or ID, and summarize grouped progress", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Phases",
		fromSessionId: lead.id,
		draft: false,
	});
	f.service.join(member.id, { missionId: mission.id });
	await assert.rejects(
		f.service.call(member.id, "phase", { operation: "create", name: "No" }),
		/Only the mission coordinator/,
	);
	const first = (await f.service.call(lead.id, "phase", {
		operation: "create",
		name: "Build",
		goal: "Foundation",
	})) as { id: string };
	const later = (await f.service.call(lead.id, "phase", { operation: "create", name: "Ship" })) as { id: string };
	await f.service.call(member.id, "task", { title: "A", phase: "Build" });
	await f.service.call(member.id, "task", { title: "B", phase: later.id });
	f.store.update(mission.id, { phaseGating: true });
	await assert.rejects(f.service.call(member.id, "claim", { id: "2", overridePhaseGating: true }), /earlier phases/);
	await assert.rejects(f.service.call(lead.id, "start", { id: "2", overridePhaseGating: true }), /earlier phases/);
	await f.service.call(lead.id, "phase", { operation: "rename", phase: first.id, name: "Foundation" });
	await f.service.call(lead.id, "phase", { operation: "reorder", phase: "Ship", order: 0 });
	const get = (await f.service.call(member.id, "get", {})) as {
		phases: { name: string; tasks: number[]; progress: { done: number; dropped: number; total: number } }[];
	};
	assert.deepEqual(
		get.phases.map((phase) => phase.name),
		["Ship", "Foundation", "No phase"],
	);
	assert.deepEqual(get.phases[0]!.tasks, [2]);
	assert.deepEqual(get.phases[0]!.progress, { done: 0, dropped: 0, total: 1 });
	await f.service.call(lead.id, "phase", { operation: "delete", phase: later.id });
	assert.equal(f.store.resolveTask(mission.id, "2").phaseId, undefined);
	await f.service.call(member.id, "task", { id: "1", phase: "" });
	assert.equal(f.store.resolveTask(mission.id, "1").milestone, undefined);
});

test("user phase-gating override survives final spawn admission; changed gates are rechecked", async (t) => {
	const f = await fixture(t);
	const { id } = f.store.create({ projectId: f.project.id, title: "Gated" });
	const first = f.store.addPhase(id, { name: "Build" });
	const later = f.store.addPhase(id, { name: "Ship" });
	f.store.addTask(id, { title: "A", phaseId: first.id });
	const b = f.store.addTask(id, { title: "B", phaseId: later.id });
	f.store.update(id, { phaseGating: true });
	await assert.rejects(f.service.startTask(id, b.id), /earlier phases/);
	const session = await f.service.startTask(id, b.id, { overridePhaseGating: true });
	assert.equal(f.store.task(id, b.id).sessionId, session.id);
	assert.equal(f.store.task(id, b.id).storedStatus, "in_progress");
	f.store.releaseTask(id, b.id);
	f.store.update(id, { phaseGating: false });
	t.mock.method(f.sessions, "selectTaskModel", async () => {
		f.store.update(id, { phaseGating: true });
		return { model: "test/model", thinking: "medium" };
	});
	await assert.rejects(f.service.startTask(id, b.id), /earlier phases/);
	assert.equal(f.store.task(id, b.id).sessionId, undefined);
});

test("session summaries resolve current membership without attention or task-detail reads", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Fixture",
		fromSessionId: lead.id,
		draft: false,
	});
	f.service.join(member.id, { missionId: mission.id });
	const get = t.mock.method(f.store, "get", () => assert.fail("summary must not count attention"));
	const tasks = t.mock.method(f.store, "tasks", () => assert.fail("summary must not read task bodies"));
	assert.equal(f.sessions.get(lead.id)?.activeMissionCoordinator, true);
	assert.equal(f.sessions.get(member.id)?.missionId, mission.id);
	assert.equal(f.sessions.get(member.id)?.activeMissionCoordinator, undefined);
	get.mock.restore();
	tasks.mock.restore();
	f.store.update(mission.id, { coordinatorSessionId: member.id });
	assert.equal(f.sessions.get(lead.id)?.activeMissionCoordinator, undefined);
	assert.equal(f.sessions.get(member.id)?.activeMissionCoordinator, true);
	f.store.update(mission.id, { status: "done" });
	assert.equal(f.sessions.get(member.id)?.activeMissionCoordinator, undefined);
});

test("linked PR polling projects owned resources without mission details or attention aggregates", async (t) => {
	const f = await fixture(t);
	const { id } = f.store.create({ projectId: f.project.id, title: "Active", tasks: [{ title: "Task" }] });
	const owned = "https://github.com/octo/repo/pull/42";
	f.store.addResource(id, { url: owned, taskId: "1" });
	f.store.addResource(id, { url: "https://github.com/octo/repo/pull/43" });
	f.store.addResource(id, { url: "https://example.com/reference", taskId: "1" });
	const done = f.store.create({ projectId: f.project.id, title: "Done", tasks: [{ title: "Task" }] });
	f.store.addResource(done.id, { url: "https://github.com/octo/repo/pull/44", taskId: "1" });
	f.store.update(done.id, { status: "done" });
	const pr = { number: 42, url: owned, title: "Change", state: "open" as const, checkedAt: 1 };
	f.store.updatePullRequest(pr);
	for (const method of ["list", "detail", "tasks", "get"] as const)
		t.mock.method(f.store, method, () => assert.fail(`PR polling must not call ${method}`));
	assert.deepEqual(
		[...f.sessions["missions"]!.linkedPullRequests!()],
		[{ url: owned, cwd: f.project.path, pullRequest: pr }],
	);
});

test("planning title follows creation, promotion and shared renames; demotion keeps the last title", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const member = await f.spawn();
	const changes: SessionSummary[] = [];
	f.sessions.onChange((session) => changes.push(session));
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Shared plan",
		fromSessionId: lead.id,
		draft: false,
	});
	assert.equal(f.sessions.get(lead.id)?.title, "Shared plan");
	f.service.join(member.id, { missionId: mission.id });
	f.store.update(mission.id, { coordinatorSessionId: member.id });
	assert.equal(f.sessions.get(member.id)?.title, "Shared plan");
	f.store.update(mission.id, { title: "Revised plan" });
	assert.equal(f.sessions.get(member.id)?.title, "Revised plan");
	assert.equal(f.sessions.get(lead.id)?.title, "Shared plan");
	assert.ok(changes.some((session) => session.id === member.id && session.title === "Revised plan"));
	const renamed = await f.sessions.rename(member.id, "  User\n chosen  ");
	assert.equal(renamed.title, "User chosen");
	assert.equal(f.store.require(mission.id).title, "User chosen");
	await f.sessions.rename(lead.id, "Independent");
	assert.equal(f.store.require(mission.id).title, "User chosen");
	f.store.update(mission.id, { coordinatorSessionId: null });
	f.store.update(mission.id, { title: "No leader" });
	assert.equal(f.sessions.get(member.id)?.title, "User chosen");
	await Promise.all(f.sessions["saving"].values());
	const persisted = JSON.parse(await readFile(join(f.home, "data", "sessions", member.id, "meta.json"), "utf8"));
	assert.equal(persisted.title, "User chosen");
});

test("promotion cancels a pending automatic title and does not start another generator", async (t) => {
	const f = await fixture(t);
	let resolve!: (title: string) => void;
	const generated = new Promise<string>((done) => {
		resolve = done;
	});
	const title = t.mock.fn(() => generated);
	f.sessions["factories"].title = title;
	const lead = await f.sessions.spawn({ projectId: f.project.id, message: "First message" });
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Shared plan",
		fromSessionId: lead.id,
		draft: false,
	});
	resolve("Unwanted automatic title");
	await Promise.all(f.sessions["titleTasks"]);
	assert.equal(f.sessions.get(lead.id)?.title, mission.title);
	assert.equal(f.sessions["require"](lead.id).titlePending, undefined);
	const calls = title.mock.callCount();
	f.sessions["generateTitle"](f.sessions["require"](lead.id));
	assert.equal(title.mock.callCount(), calls);
});

test("startup repairs legacy planning titles durably and idempotently", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Shared plan",
		fromSessionId: lead.id,
		draft: false,
	});
	await Promise.all(f.sessions["saving"].values());
	const path = join(f.home, "data", "sessions", lead.id, "meta.json");
	const legacy = JSON.parse(await readFile(path, "utf8"));
	legacy.title = "Legacy title";
	legacy.titlePending = { cwd: f.project.path, message: "Legacy message" };
	await writeFile(path, JSON.stringify(legacy));
	const title = t.mock.fn(async () => "Wrong title");
	f.sessions["factories"].title = title;
	await f.sessions.load();
	await Promise.all(f.sessions["saving"].values());
	assert.equal(f.sessions.get(lead.id)?.title, mission.title);
	const repaired = JSON.parse(await readFile(path, "utf8"));
	assert.equal(repaired.title, mission.title);
	assert.equal(repaired.titlePending, undefined);
	await f.sessions.load();
	assert.equal(f.sessions.get(lead.id)?.title, mission.title);
	assert.equal(title.mock.callCount(), 0);
});

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
	assert.deepEqual(f.service.context(worker.id)?.decisions, ["D2: Everyone"]);
	assert.deepEqual(f.service.context(lead.id)?.decisions, ["D2: Everyone", "D3: Coordinate"]);
	await f.service.call(worker.id, "task", { id: "1", decisionIds: [reference.id, coordinator.id] });
	assert.deepEqual(
		new Set(f.service.context(worker.id)?.decisions),
		new Set(["D1: Reference", "D2: Everyone", "D3: Coordinate"]),
	);
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
	assert.deepEqual(f.service.context(worker.id)?.decisions, ["D2: Revised"]);
	const foreign = f.store.create({ projectId: f.project.id, title: "Other" });
	const foreignDecision = f.store.addDecision(foreign.id, "Elsewhere");
	await assert.rejects(
		f.service.call(worker.id, "task", { id: "1", decisionIds: [foreignDecision.id] }),
		/Unknown decision/,
	);
});

test("single-task get includes dependencies, chat, cached links, artifacts and bounded activity", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.sessions, "refreshMissionPullRequests", () => {});
	const lead = await f.spawn();
	const worker = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Shared",
		fromSessionId: lead.id,
		draft: false,
	});
	f.service.join(worker.id, { missionId: mission.id });
	const dependency = f.store.addTask(mission.id, { title: "Foundation", status: "done" });
	const task = f.store.addTask(mission.id, {
		title: "Implement",
		body: "Acceptance criteria",
		milestone: "Delivery",
		dependsOn: [dependency.id],
	});
	const dependent = f.store.addTask(mission.id, { title: "Verify", dependsOn: [task.id] });
	f.store.claimTask(mission.id, task.id, worker.id);
	const url = "https://github.com/octo/repo/pull/42";
	f.store.addResource(mission.id, { url, taskId: task.id, relationship: "reference" });
	f.store.updatePullRequest({ number: 42, url, title: "Cached PR", state: "draft", checkedAt: Date.now() });
	f.store.addResource(mission.id, { url: "https://example.com/spec", taskId: task.id });
	f.store.addResource(mission.id, { url: "https://example.com/unrelated", taskId: dependent.id });
	f.store.linkArtifact(mission.id, {
		artifactId: "mock-layout",
		sessionId: worker.id,
		title: "Layout",
		kind: "html",
		revision: 2,
		taskId: task.id,
	});
	for (let i = 0; i < 20; i++)
		f.store.updateTask(mission.id, task.id, { title: `Implement ${i}` }, { sessionId: worker.id });
	f.store.updateTask(mission.id, dependent.id, { title: "Unrelated activity" });
	t.mock.method(f.store, "brief", () => assert.fail("targeted task must not read the brief"));
	t.mock.method(f.store, "events", () => assert.fail("targeted task must not scan unfiltered activity"));
	const read = async (id: string | number, action: "get" | "task" = "get") =>
		(await f.service.call(lead.id, action, { id })) as {
			id: string;
			number: number;
			body: string;
			milestone: string;
			dependsOn: number[];
			dependents: number[];
			assignee: { id: string; title: string; state: string } | null;
			resources: { url: string; kind: string; state?: string; relationship: string }[];
			artifacts: { artifactId: string; revision: number; kind: string }[];
			recentActivity: { id: number; taskId: string; by: string }[];
			activityCursor: number | null;
		};
	const full = await read(task.id);
	assert.deepEqual(await read(`#${task.number}`), full);
	assert.deepEqual(await read(task.number), full);
	assert.deepEqual(await read(String(task.number), "task"), full);
	assert.equal(full.id, task.id);
	assert.equal(full.body, "Acceptance criteria");
	assert.equal(full.milestone, "Delivery");
	assert.deepEqual(full.dependsOn, [dependency.number]);
	assert.deepEqual(full.dependents, [dependent.number]);
	assert.deepEqual(full.assignee, { id: worker.id, title: worker.title, state: "idle" });
	assert.equal(full.resources.length, 2);
	assert.ok(
		full.resources.some(
			(ref) =>
				ref.url === url && ref.kind === "github.pr" && ref.state === "draft" && ref.relationship === "reference",
		),
	);
	assert.ok(full.resources.some((ref) => ref.kind === "url"));
	assert.equal(full.artifacts[0]?.artifactId, "mock-layout");
	assert.equal(full.artifacts[0]?.revision, 2);
	assert.equal(full.artifacts[0]?.kind, "html");
	assert.equal(full.recentActivity.length, 15);
	assert.ok(full.recentActivity.every((event) => event.taskId === task.id && event.by === worker.id));
	assert.equal(full.activityCursor, full.recentActivity.at(-1)?.id);
	const older = (await f.service.call(lead.id, "activity", {
		taskId: String(task.number),
		cursor: full.activityCursor,
	})) as { recentActivity: { id: number; taskId: string }[] };
	assert.ok(older.recentActivity.every((event) => event.id < full.activityCursor! && event.taskId === task.id));
	const empty = await read(dependency.id);
	assert.equal(empty.body, "");
	assert.equal(empty.assignee, null);
	assert.deepEqual(empty.dependsOn, []);
	assert.deepEqual(empty.dependents, [task.number]);
	assert.equal(empty.activityCursor, null);
	const foreign = f.store.create({ projectId: f.project.id, title: "Other", tasks: [{ title: "Private" }] });
	for (const id of ["999", f.store.tasks(foreign.id)[0]!.id, "", null])
		await assert.rejects(f.service.call(lead.id, "get", { id }), /Unknown task|task id/);
});

test("activity filters precede limits and page stably through interleaved and new events", async (t) => {
	const f = await fixture(t);
	const worker = await f.spawn();
	const outsider = await f.spawn();
	const at = Date.parse("2026-10-14T12:00:00Z");
	let now = at - 2000;
	t.mock.method(Date, "now", () => now);
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Shared",
		fromSessionId: worker.id,
		draft: false,
	});
	const task = f.store.addTask(mission.id, { title: "Target" });
	const other = f.store.addTask(mission.id, { title: "Other" });
	const foreign = f.store.create({ projectId: f.project.id, title: "Elsewhere", tasks: [{ title: "Foreign" }] });
	// All events share a timestamp, so only the event cursor gives lossless boundaries.
	now = at;
	const since = f.store.events(mission.id)[0]!.id;
	for (let i = 0; i < 6; i++) {
		f.store.updateTask(mission.id, task.id, { title: `Target ${i}` });
		f.store.updateTask(mission.id, other.id, { title: `Noise ${i}` });
		f.store.log(mission.id, { text: `Noise note ${i}` });
		f.store.updateTask(foreign.id, f.store.tasks(foreign.id)[0]!.id, { title: `Foreign ${i}` });
	}
	type Page = {
		recentActivity: { id: number; kind: string; taskId?: string; health?: string }[];
		cursor: number | null;
		recentUserNotes?: unknown[];
	};
	const read = async (args: Record<string, unknown> = {}) =>
		(await f.service.call(worker.id, "activity", args)) as Page;
	const filters = { taskId: `#${task.number}`, kind: "task", since, limit: 2 };
	const first = await read(filters);
	assert.equal(first.recentActivity.length, 2);
	assert.equal(first.recentUserNotes, undefined);
	assert.equal(first.cursor, first.recentActivity.at(-1)?.id);
	f.store.updateTask(mission.id, task.id, { title: "Inserted after first page" });
	const second = await read({ ...filters, cursor: first.cursor });
	const last = await read({ ...filters, cursor: second.cursor });
	assert.equal(last.cursor, null);
	const ids = [...first.recentActivity, ...second.recentActivity, ...last.recentActivity].map((event) => event.id);
	assert.equal(ids.length, 6);
	assert.equal(new Set(ids).size, 6);
	assert.deepEqual(
		ids,
		ids.toSorted((a, b) => b - a),
	);
	assert.ok(
		[...first.recentActivity, ...second.recentActivity, ...last.recentActivity].every(
			(event) => event.kind === "task" && event.taskId === task.id,
		),
	);
	assert.deepEqual((await read({ taskId: task.id, since: "2026-10-14T12:00:00Z" })).recentActivity, []);
	assert.equal((await read({ taskId: task.id, since: "2026-10-14T13:59:59+02:00" })).recentActivity.length, 7);
	assert.deepEqual(
		(await read({ taskId: task.id, since: first.recentActivity[0]!.id })).recentActivity.map((event) => event.kind),
		["task"],
	);
	const note = f.store.log(mission.id, { text: "Health", health: "at_risk" });
	assert.equal((await read({ kind: "update", limit: 1 })).recentActivity[0]?.health, "at_risk");
	assert.equal((await read({ kind: "update", limit: 1 })).recentActivity[0]?.id, note.id);
	assert.deepEqual(await read({ kind: "github" }), { recentActivity: [], cursor: null });
	for (const args of [
		{ limit: 0 },
		{ limit: null },
		{ limit: 101 },
		{ limit: 1.5 },
		{ limit: "2" },
		{ cursor: 0 },
		{ cursor: "1" },
		{ since: "yesterday" },
		{ since: "2026-10-14" },
		{ since: -1 },
		{ since: 1.5 },
		{ since: null },
		{ kind: "unknown" },
	])
		await assert.rejects(read(args), /limit|cursor|since|kind/);
	await assert.rejects(read({ taskId: f.store.tasks(foreign.id)[0]!.id }), /Unknown task/);
	await assert.rejects(f.service.call(outsider.id, "activity", {}), /not part of a mission/);
	await assert.rejects(
		f.service.call(worker.id, "log", { kind: "task", text: "Invalid log" }),
		/kind must be update or handoff/,
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
	// No repository or subprocesses in this service fixture. Real source-role coverage lives in coordinator-role.test.ts.
	const roleHost = sessions as unknown as {
		refreshMainViews(): Promise<void>;
		prepareCoordinatorRole(id: string): Promise<void>;
	};
	t.mock.method(roleHost, "refreshMainViews", async () => {});
	t.mock.method(roleHost, "prepareCoordinatorRole", async (id: string) => {
		const meta = sessions["require"](id);
		if (sessions["isMissionCoordinator"](id))
			meta.coordinatorView ??= {
				originalCwd: meta.cwd,
				path: meta.cwd,
				scratch: join(home, "scratch", id),
				head: "a".repeat(40),
				repository: projectDir,
			};
		else delete meta.coordinatorView;
	});
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
	assert.equal(session.title, "Plan");
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

for (const scenario of [
	"idle",
	"working",
	"jobs",
	"follow-up",
	"dirty",
	"open",
	"unverified",
	"binding",
	"selected-base",
] as const) {
	test(`member workspaces refresh only at safe input admission: ${scenario}`, async (t) => {
		const f = await fixture(t);
		const member = await f.spawn();
		const { mission } = await f.service.create({ projectId: f.project.id, title: "M" });
		f.service.join(member.id, { missionId: mission.id });
		const meta = f.sessions["require"](member.id);
		meta.workspace = {
			source: f.project.path,
			base: "a".repeat(40),
			jj: true,
			branch: "fix/change",
			shared: { repository: "/owned", name: "member" },
		};
		const fetch = t.mock.method(f.sessions["sharedWorkspaces"], "fetchMain", async () => "b".repeat(40));
		const worker = f.workers.get(member.id)!;
		let jobs = scenario === "jobs";
		Object.assign(worker, { hasChildren: async () => jobs, awaitingJobFollowUp: scenario === "follow-up" });
		const refresh = t.mock.method(
			f.sessions["sharedWorkspaces"],
			"refreshBase",
			async (...args: Parameters<(typeof f.sessions)["sharedWorkspaces"]["refreshBase"]>) => {
				if (scenario === "binding") meta.prBindingOperation = "new-binding";
				const behind = scenario === "dirty" ? "The working copy has unpublished changes." : args[5]?.allowed?.();
				return behind ? { base: meta.workspace!.base, target: "b".repeat(40), behind } : { base: "b".repeat(40) };
			},
		);
		if (scenario === "open")
			meta.pullRequest = {
				number: 1,
				url: "https://github.com/o/r/pull/1",
				title: "Open",
				state: "open",
				branch: "fix/change",
				checkedAt: Date.now(),
			};
		if (scenario === "unverified") meta.boundPullRequests = ["https://github.com/o/r/pull/2"];
		if (scenario === "selected-base") meta.workspace.baseBranch = "release";
		if (scenario === "working") {
			worker.busy = true;
			worker.state = "working";
			worker.onPacket({ type: "working", working: true });
		}
		const activities = () => worker.requests.filter((cmd) => cmd.type === "activity").length;
		const before = activities();
		await f.sessions.refreshProjectMain(f.project.id);
		await f.sessions.commands(member.id);
		assert.equal(refresh.mock.calls.length, 0, "polling and opening a chat never move its workspace");
		await f.sessions.send(member.id, "next task");
		const unsafe = ["working", "jobs", "follow-up", "open", "unverified", "selected-base"].includes(scenario);
		assert.equal(refresh.mock.calls.length, unsafe ? 0 : 1);
		assert.equal(fetch.mock.calls.length, unsafe ? 1 : 2, "unsafe input does not fetch main");
		assert.equal(activities(), before, "routine workspace maintenance adds no timeline activity");
		assert.equal(meta.workspace.base, (unsafe || ["dirty", "binding"].includes(scenario) ? "a" : "b").repeat(40));
		if (scenario === "dirty") assert.match(meta.workspaceBehind!, /unpublished/);
		if (scenario === "binding") assert.match(meta.workspaceBehind!, /ownership/);
		if (["working", "jobs", "follow-up"].includes(scenario)) {
			jobs = false;
			worker.busy = false;
			worker.state = "idle";
			worker.onPacket({ type: "jobs.changed", jobs: [] });
			worker.onPacket({
				type: "working",
				working: false,
				completion: { outcome: "done", outcomeAt: Date.now() + 1 },
			});
			await until(() => !f.sessions["starting"].size);
			assert.equal(refresh.mock.calls.length, 0, "finishing work does not move files");
			await f.sessions.send(member.id, "another task");
			assert.equal(refresh.mock.calls.length, 1, "only the next idle input refreshes");
			assert.equal(meta.workspace.base, "b".repeat(40));
		}
	});
}

test("main bursts leave idle members alone; only the next working chat moves to latest main", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const first = await f.spawn();
	const second = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
	});
	for (const member of [first, second]) f.service.join(member.id, { missionId: mission.id });
	for (const chat of [lead, first, second])
		f.sessions["require"](chat.id).workspace = {
			source: f.project.path,
			base: "a".repeat(40),
			jj: true,
			shared: { repository: "/owned", name: chat.id },
		};
	let target = "b".repeat(40);
	const mainEvents: string[] = [];
	t.after(f.sessions.onMainMoved((event) => mainEvents.push(event.head)));
	t.mock.method(f.sessions["sharedWorkspaces"], "fetchMain", async () => target);
	const refresh = t.mock.method(
		f.sessions["sharedWorkspaces"],
		"refreshBase",
		async (...args: Parameters<(typeof f.sessions)["sharedWorkspaces"]["refreshBase"]>) => ({
			base: args[5]!.target!,
		}),
	);
	await f.sessions.refreshProjectMain(f.project.id);
	target = "c".repeat(40);
	await f.sessions.refreshProjectMain(f.project.id);
	assert.equal(refresh.mock.calls.length, 0);
	for (const chat of [first, second]) {
		assert.equal(f.sessions["require"](chat.id).workspace!.base, "a".repeat(40));
		assert.equal(f.workers.get(chat.id)!.requests.filter((cmd) => cmd.type === "activity").length, 0);
	}
	// Main can advance again before the scheduled watcher runs. Admission fetches current main.
	target = "d".repeat(40);
	await f.sessions.send(first.id, "next task");
	assert.equal(refresh.mock.calls.length, 1);
	assert.equal(refresh.mock.calls[0]!.arguments[5]!.target, target);
	assert.equal(f.sessions["require"](first.id).workspace!.base, target);
	assert.equal(f.sessions["require"](second.id).workspace!.base, "a".repeat(40));
	assert.equal(f.sessions["require"](lead.id).workspace!.base, "a".repeat(40));
	await f.sessions.send(first.id, "continue");
	assert.equal(refresh.mock.calls.length, 1, "unchanged main creates no additional jj change");
	assert.deepEqual(mainEvents, ["b".repeat(40), "c".repeat(40), "d".repeat(40)]);
});

test("sleep and wake do not refresh idle workspaces", async (t) => {
	const f = await fixture(t);
	const member = await f.spawn();
	const { mission } = await f.service.create({ projectId: f.project.id, title: "M" });
	f.service.join(member.id, { missionId: mission.id });
	const meta = f.sessions["require"](member.id);
	meta.workspace = {
		source: f.project.path,
		base: "a".repeat(40),
		jj: true,
		shared: { repository: "/owned", name: member.id },
	};
	t.mock.method(f.sessions["sharedWorkspaces"], "fetchMain", async () => "b".repeat(40));
	const refresh = t.mock.method(f.sessions["sharedWorkspaces"], "refreshBase", async () => ({ base: "b".repeat(40) }));
	const worker = f.workers.get(member.id)!;
	worker.onPacket({
		type: "jobs.changed",
		jobs: [{ id: "tests", name: "Tests", state: "running", startedAt: 1, outputPath: "/tmp/tests.log" }],
	});
	worker.onPacket({ type: "jobs.changed", jobs: [] });
	await f.sessions.pauseForSleep("100:1");
	assert.equal(meta.sleepPaused, true);
	await f.sessions.refreshProjectMain(f.project.id);
	assert.equal(refresh.mock.calls.length, 0);
	await f.sessions.resumeAfterSleep();
	await until(() => !f.sessions["starting"].size);
	assert.equal(refresh.mock.calls.length, 0, "wake retains the old workspace, including pending job results");
	assert.equal(meta.workspace.base, "a".repeat(40));
});

for (const race of ["work", "PR", "main", "offline", "update"] as const) {
	test(`input refresh fails closed without losing input when ${race} changes`, async (t) => {
		const f = await fixture(t);
		const member = await f.spawn();
		const { mission } = await f.service.create({ projectId: f.project.id, title: "M" });
		f.service.join(member.id, { missionId: mission.id });
		const meta = f.sessions["require"](member.id);
		meta.workspace = {
			source: f.project.path,
			base: "a".repeat(40),
			jj: true,
			shared: { repository: "/owned", name: member.id },
		};
		const worker = f.workers.get(member.id)!;
		t.mock.method(f.sessions["sharedWorkspaces"], "fetchMain", async () => {
			if (race === "work") worker.busy = true;
			if (race === "update") f.sessions["updateGate"].pause();
			if (race === "offline") throw new Error("fetch unavailable");
			return "b".repeat(40);
		});
		t.after(() => f.sessions["updateGate"].release());
		const refresh = t.mock.method(
			f.sessions["sharedWorkspaces"],
			"refreshBase",
			async (...args: Parameters<(typeof f.sessions)["sharedWorkspaces"]["refreshBase"]>) => {
				if (race === "PR") meta.boundPullRequests = ["https://github.com/o/r/pull/2"];
				if (race === "main") f.sessions["mainHeads"].set(f.project.id, "c".repeat(40));
				const behind = args[5]!.allowed!();
				assert.ok(behind, "the transaction rechecks late changes before touching files");
				return { base: meta.workspace!.base, target: "b".repeat(40), behind };
			},
		);
		const before = worker.requests.filter((cmd) => cmd.type === "input").length;
		await f.sessions.send(member.id, "continue safely");
		assert.equal(meta.workspace.base, "a".repeat(40));
		assert.equal(refresh.mock.calls.length, ["PR", "main"].includes(race) ? 1 : 0);
		assert.equal(worker.requests.filter((cmd) => cmd.type === "input").length, before + 1);
		assert.equal(meta.failure, undefined);
		if (race === "offline") assert.match(meta.workspaceBehind!, /fetch unavailable/);
	});
}

test("main refresh has no per-member write or workspace fan-out with 10000 chats", async (t) => {
	const f = await fixture(t);
	const member = await f.spawn();
	const meta = f.sessions["require"](member.id);
	const ids: string[] = [];
	t.mock.method(f.sessions["missions"]!, "membership", () => ({ missionId: "m", active: true }));
	t.mock.method(f.sessions["sharedWorkspaces"], "fetchMain", async () => "b".repeat(40));
	const refresh = t.mock.method(f.sessions["sharedWorkspaces"], "refreshBase", async () =>
		assert.fail("no idle moves"),
	);
	const save = t.mock.method(f.sessions as unknown as { save(): Promise<void> }, "save", async () => {});
	try {
		for (let i = 0; i < 10000; i++) {
			const id = `idle-${i}`;
			ids.push(id);
			f.sessions["metas"].set(id, {
				...meta,
				id,
				workspace: {
					source: f.project.path,
					base: "a".repeat(40),
					jj: true,
					shared: { repository: "/owned", name: id },
				},
			});
		}
		const start = performance.now();
		await f.sessions.refreshProjectMain(f.project.id);
		t.diagnostic(`10000 idle chats: main refresh ${(performance.now() - start).toFixed(1)}ms, no per-chat I/O`);
		assert.equal(save.mock.calls.length, 0);
		assert.equal(refresh.mock.calls.length, 0);
	} finally {
		for (const id of ids) f.sessions["metas"].delete(id);
		save.mock.restore();
	}
});

test("repository refresh bursts share a two-slot project fetch pool", async (t) => {
	const f = await fixture(t);
	const releases: (() => void)[] = [];
	let calls = 0;
	t.mock.method(f.sessions, "refreshProjectMain", async () => {
		calls++;
		await new Promise<void>((resolve) => releases.push(resolve));
	});
	for (let i = 0; i < 10; i++) f.sessions.requestMainRefresh("same");
	f.sessions.requestMainRefresh("second");
	f.sessions.requestMainRefresh("third");
	f.sessions["pumpMainRefreshes"]();
	assert.equal(calls, 2);
	assert.equal(f.sessions["mainRefreshes"].size, 2);
	releases[0]!();
	releases[1]!();
	await until(() => calls === 3);
	releases[2]!();
	await Promise.all(f.sessions["mainRefreshes"].values());
});

test("project watcher discovery deduplicates membership I/O on large projects", async (t) => {
	const f = await fixture(t);
	const member = await f.spawn();
	const meta = f.sessions["require"](member.id);
	const membership = t.mock.method(f.sessions["missions"]!, "membership", () => ({ missionId: "m", active: true }));
	const ids: string[] = [];
	try {
		for (let i = 0; i < 10000; i++) {
			const id = `large-${i}`;
			ids.push(id);
			f.sessions["metas"].set(id, {
				...meta,
				id,
				workspace: {
					source: f.project.path,
					base: "a".repeat(40),
					jj: true,
					shared: { repository: "/owned", name: id },
				},
			});
		}
		const start = performance.now();
		assert.deepEqual(f.sessions["mainProjects"](), [{ id: f.project.id }]);
		t.diagnostic(`10000 chats: project watcher discovery ${(performance.now() - start).toFixed(1)}ms`);
		assert.equal(membership.mock.calls.length, 1, "one membership read, not one per chat");
	} finally {
		for (const id of ids) f.sessions["metas"].delete(id);
	}
});

test("restart discards eager refresh hints and queued maintenance; next input fetches current main", async (t) => {
	const f = await fixture(t);
	const member = await f.spawn();
	const { mission } = await f.service.create({ projectId: f.project.id, title: "M" });
	f.service.join(member.id, { missionId: mission.id });
	await f.sessions["pullRequests"].stop();
	await until(() => !f.sessions["starting"].size);
	await Promise.all(f.sessions["saving"].values());
	f.sessions["workers"].delete(member.id);
	const meta = f.sessions["require"](member.id);
	meta.workspace = {
		source: f.project.path,
		base: "a".repeat(40),
		jj: true,
		shared: { repository: "/owned", name: member.id },
	};
	meta.workspaceMainDue = "b".repeat(40);
	meta.workspaceMainAttempted = "a".repeat(40);
	meta.workspaceMainDeferred = "b".repeat(40);
	meta.prActivities = [
		{ type: "activity", requestId: "main-workspace:old", text: "Old maintenance" },
		{ type: "activity", requestId: "other", text: "Keep this activity" },
	];
	await f.sessions["save"](meta);
	t.mock.method(f.sessions["sharedWorkspaces"], "fetchMain", async () => "c".repeat(40));
	const refresh = t.mock.method(f.sessions["sharedWorkspaces"], "refreshBase", async () => ({ base: "c".repeat(40) }));
	await f.sessions.load();
	await f.sessions.refreshProjectMain(f.project.id);
	const loaded = f.sessions["require"](member.id);
	assert.equal(refresh.mock.calls.length, 0, "restart and polling do not resume old eager maintenance");
	assert.equal(loaded.workspaceMainDue, undefined);
	assert.equal(loaded.workspaceMainAttempted, undefined);
	assert.equal(loaded.workspaceMainDeferred, undefined);
	assert.deepEqual(
		loaded.prActivities?.map((activity) => activity.requestId),
		["other"],
	);
	const persisted = JSON.parse(await readFile(join(f.home, "data", "sessions", member.id, "meta.json"), "utf8"));
	assert.equal(persisted.workspaceMainDue, undefined);
	await f.sessions.send(member.id, "next task");
	assert.equal(refresh.mock.calls.length, 1);
	assert.equal(refresh.mock.calls[0]!.arguments[5]!.target, "c".repeat(40));
	assert.equal(loaded.workspace!.base, "c".repeat(40));
	const activityIds = f.workers
		.get(member.id)!
		.requests.filter((cmd) => cmd.type === "activity")
		.map((cmd) => cmd.requestId);
	assert.deepEqual(activityIds, ["other"]);
});

for (const stop of [false, true]) {
	test(`next input waits for its main refresh; stop racing maintenance: ${stop}`, async (t) => {
		const f = await fixture(t);
		const member = await f.spawn();
		const { mission } = await f.service.create({ projectId: f.project.id, title: "M" });
		f.service.join(member.id, { missionId: mission.id });
		const meta = f.sessions["require"](member.id);
		meta.workspace = {
			source: f.project.path,
			base: "a".repeat(40),
			jj: true,
			shared: { repository: "/owned", name: "member" },
		};
		t.mock.method(f.sessions["sharedWorkspaces"], "fetchMain", async () => "b".repeat(40));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		t.after(release);
		const refresh = t.mock.method(f.sessions["sharedWorkspaces"], "refreshBase", async () => {
			await gate;
			return { base: "b".repeat(40) };
		});
		const worker = f.workers.get(member.id)!;
		const before = worker.requests.filter((cmd) => cmd.type === "input").length;
		const send = f.sessions.send(member.id, "next task");
		await until(() => refresh.mock.calls.length === 1);
		assert.equal(worker.requests.filter((cmd) => cmd.type === "input").length, before);
		const stopped = stop ? f.sessions.stop(member.id) : Promise.resolve();
		if (stop) await until(() => meta.pending?.some((cmd) => cmd.type === "abort"));
		release();
		await Promise.all([send, stopped]);
		assert.equal(meta.workspace.base, "b".repeat(40));
		assert.equal(worker.requests.filter((cmd) => cmd.type === "input").length, before + (stop ? 0 : 1));
	});
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
	// The member's agent created it.
	meta.agentPullRequests = [pullRequest.url];
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
	f.sessions["require"](member.id).agentPullRequests = [open.url];
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
	await until(() => !f.sessions["workspaceRefreshes"].size && !f.sessions["starting"].size);
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
	f.sessions["require"](chat.id).agentPullRequests = [pullRequest.url, other.url];
	await f.sessions["applyPullRequest"](f.sessions["require"](chat.id), {
		pullRequest,
		mergedAt: pullRequest.mergedAt,
		others: [other],
	});
	assert.equal(f.store.resolveTask(id, "1").status, "in_review");
	assert.equal(f.store.detail(id).resources.filter((resource) => resource.taskId).length, 2);
});

test("tool task links resolve numbers and never fan out to other owned tasks", async (t) => {
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
	assert.equal(f.store.detail(id).resources.length, 1);
	assert.equal(f.store.detail(id).resources[0]!.taskId, linked.taskId);
	await assert.rejects(f.service.call(chat.id, "link", { url, taskId: "missing" }), /Unknown task/);
});

test("multi-task creation and discovery require explicit attribution across service reopen", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const { id } = f.store.create({ projectId: f.project.id, title: "M", tasks: [{ title: "A" }, { title: "B" }] });
	f.service.join(chat.id, { missionId: id });
	await f.service.call(chat.id, "claim", { ids: ["1-2"] });
	const first = "https://github.com/octo/repo/pull/109";
	const second = "https://github.com/octo/repo/pull/110";
	f.sessions["missions"]!.pullRequestCreated!(chat.id, first);
	assert.equal(f.store.detail(id).resources.length, 0, "multiple claims are ambiguous");
	await f.service.call(chat.id, "link", { url: first, taskId: "1" });
	await f.service.call(chat.id, "task", { id: "1", status: "done" });
	f.sessions["missions"]!.pullRequestCreated!(chat.id, second);
	assert.equal(f.store.detail(id).resources.length, 1, "a completed claim does not imply the next PR's task");
	await f.service.call(chat.id, "link", { url: second, taskId: "2" });
	// Reproduce legacy cross-links, then the user's resource-API cleanup.
	const wrongFirst = f.store.addResource(id, { url: first, taskId: "2" });
	const wrongSecond = f.store.addResource(id, { url: second, taskId: "1" });
	f.store.removeResource(id, wrongFirst.id);
	f.store.removeResource(id, wrongSecond.id);
	const expected = f.store.detail(id).resources;
	await f.service.notices.stop();
	const reopened = new MissionService(f.store, f.sessions, f.projects);
	t.after(() => reopened.notices.stop());
	f.sessions["missions"]!.pullRequestsDiscovered!(chat.id, [first, second]);
	f.sessions["missions"]!.pullRequestCreated!(chat.id, first);
	f.sessions["missions"]!.pullRequestCreated!(chat.id, second);
	assert.deepEqual(f.store.detail(id).resources, expected);
	assert.deepEqual(
		expected.map((resource) => [resource.url, resource.taskId]).sort(),
		[
			[first, f.store.resolveTask(id, "1").id],
			[second, f.store.resolveTask(id, "2").id],
		].sort(),
	);
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
	t.mock.method(f.sessions, "spawn", async (...args: Parameters<typeof spawn>) => {
		const detail = f.store.detail(mission.id);
		assert.equal(detail.artifacts.filter((ref) => ref.taskId === task.id).length, 2);
		assert.equal(detail.resources.filter((ref) => ref.taskId === task.id).length, 2);
		return spawn(...args);
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

for (const [firstVia, secondVia] of [
	["HTTP", "HTTP"],
	["HTTP", "tool"],
	["tool", "HTTP"],
	["tool", "tool"],
] as const) {
	test(`concurrent ${firstVia}/${secondVia} task starts reserve canonical task IDs before async selection`, async (t) => {
		const f = await fixture(t);
		const lead = await f.spawn();
		const { mission } = await f.service.create({
			projectId: f.project.id,
			title: "M",
			fromSessionId: lead.id,
			draft: false,
			tasks: [{ title: "Auth" }],
		});
		const task = f.store.resolveTask(mission.id, "1");
		const terminals = new TerminalManager();
		const server = createDaemonServer(
			{ home: f.home, host: "127.0.0.1", port: 0 },
			f.sessions,
			f.projects,
			new ModelCatalog(f.home),
			terminals,
			{ service: f.service, store: f.store },
		);
		t.after(async () => {
			terminals.shutdown();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as AddressInfo).port;
		const start = async (via: "HTTP" | "tool", id: string) => {
			if (via === "HTTP") {
				const response = await fetch(
					`http://127.0.0.1:${port}/api/missions/${mission.id}/tasks/${encodeURIComponent(id)}/start`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
					},
				);
				return { status: response.status, body: (await response.json()) as { id?: string; error?: string } };
			}
			try {
				return { status: 201, body: (await f.service.call(lead.id, "start", { id })) as SessionSummary };
			} catch (error) {
				assert.ok(error instanceof Conflict);
				return { status: 409, body: { error: error.message } };
			}
		};
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let selecting!: () => void;
		const selectionStarted = new Promise<void>((resolve) => {
			selecting = resolve;
		});
		t.mock.method(f.sessions, "selectTaskModel", async () => {
			selecting();
			await blocked;
			return { model: "test/model", thinking: "medium" };
		});
		const spawn = t.mock.method(f.sessions, "spawn");
		const first = start(firstVia, task.id);
		try {
			await selectionStarted;
			// HTTP numbers and tool #number aliases share the UUID reservation.
			for (const alias of secondVia === "HTTP" ? ["1", task.id] : ["1", "#1"]) {
				const second = await start(secondVia, alias);
				assert.equal(second.status, 409);
				assert.match("error" in second.body ? (second.body.error ?? "") : "", /already starting/);
			}
			assert.equal(spawn.mock.callCount(), 0);
		} finally {
			release();
		}
		const winner = await first;
		assert.equal(winner.status, 201);
		assert.ok("id" in winner.body && winner.body.id);
		const id = winner.body.id;
		assert.equal(f.store.task(mission.id, task.id).sessionId, id);
		assert.equal(spawn.mock.callCount(), 1);
		assert.equal(f.sessions.list().length, 2);
		assert.deepEqual(new Set(f.store.members(mission.id)), new Set([lead.id, id]));
		assert.deepEqual(new Set(await readdir(join(f.home, "data", "sessions"))), new Set([lead.id, id]));
		const worker = await until(() => f.workers.get(id));
		assert.equal(worker.spec.mission?.tasks[0]?.number, task.number, "the claim precedes worker startup");
		assert.equal(f.workers.size, 2);
		assert.equal(f.store.events(mission.id).filter((event) => event.text.startsWith("Started #")).length, 1);
		const retry = await start(secondVia, "1");
		assert.equal(retry.status, 409);
		assert.match("error" in retry.body ? (retry.body.error ?? "") : "", /already claimed/);
	});
}

test("task start reservations remain held through spawn and do not block other tasks or missions", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		tasks: [{ title: "Auth" }, { title: "Other" }],
	});
	const other = f.store.create({ projectId: f.project.id, title: "Other", tasks: [{ title: "Auth" }] });
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let spawning!: () => void;
	const spawnStarted = new Promise<void>((resolve) => {
		spawning = resolve;
	});
	const original = f.sessions.spawn.bind(f.sessions);
	let calls = 0;
	t.mock.method(f.sessions, "spawn", async (...args: Parameters<typeof original>) => {
		if (++calls === 1) {
			spawning();
			await blocked;
		}
		return original(...args);
	});
	const first = f.service.startTask(mission.id, "1");
	try {
		await spawnStarted;
		await assert.rejects(f.service.startTask(mission.id, "#1"), /already starting/);
		const [sameMission, otherMission] = await Promise.all([
			f.service.startTask(mission.id, "2"),
			f.service.startTask(other.id, "1"),
		]);
		assert.equal(f.store.resolveTask(mission.id, "2").sessionId, sameMission.id);
		assert.equal(f.store.resolveTask(other.id, "1").sessionId, otherMission.id);
	} finally {
		release();
	}
	const winner = await first;
	assert.equal(f.store.resolveTask(mission.id, "1").sessionId, winner.id);
	assert.equal(calls, 3);
});

for (const failure of ["selection", "references", "admission"] as const) {
	test(`failed task ${failure} releases its start reservation and rejected admission leaves no orphan`, async (t) => {
		const f = await fixture(t);
		const { mission } = await f.service.create({ projectId: f.project.id, title: "M", tasks: [{ title: "Auth" }] });
		const task = f.store.resolveTask(mission.id, "1");
		let restore = () => {};
		if (failure === "selection") {
			const mock = t.mock.method(f.sessions, "selectTaskModel", async () => {
				throw new Error("selection failed");
			});
			restore = () => mock.mock.restore();
		} else if (failure === "admission") {
			const original = f.sessions["missions"]!.joinSpawn;
			const mock = t.mock.method(f.sessions["missions"]!, "joinSpawn", (...args: Parameters<typeof original>) => {
				original(...args);
				throw new Error("admission failed");
			});
			restore = () => mock.mock.restore();
		}
		await assert.rejects(
			f.service.startTask(mission.id, task.id, failure === "references" ? { message: "x".repeat(4000) } : {}),
			failure === "references" ? /Opening message is too long/ : /failed/,
		);
		restore();
		assert.equal(f.store.task(mission.id, task.id).sessionId, undefined);
		assert.deepEqual(f.store.members(mission.id), []);
		assert.equal(f.sessions.list({ archived: "all" }).length, 0);
		assert.equal(f.workers.size, 0);
		assert.deepEqual(await readdir(join(f.home, "data", "sessions")), []);
		assert.ok(!f.store.events(mission.id).some((event) => event.text.startsWith("Started #")));
		const retry = await f.service.startTask(mission.id, "#1");
		assert.equal(f.store.task(mission.id, task.id).sessionId, retry.id);
	});
}

for (const change of ["claimed", "deleted"] as const) {
	test(`task ${change} during spawn preparation rejects before worker startup and cleans persisted metadata`, async (t) => {
		const f = await fixture(t);
		const owner = await f.spawn();
		const { mission } = await f.service.create({ projectId: f.project.id, title: "M", tasks: [{ title: "Auth" }] });
		const task = f.store.resolveTask(mission.id, "1");
		const lifecycle = f.sessions["lifecycle"];
		const flush = t.mock.method(lifecycle, "flush", lifecycle.flush.bind(lifecycle));
		let prepared!: () => void;
		const preparing = new Promise<void>((resolve) => {
			prepared = resolve;
		});
		const original = f.sessions["missions"]!.spawnProject;
		const mock = t.mock.method(f.sessions["missions"]!, "spawnProject", (id: string) => {
			const project = original(id);
			prepared();
			return project;
		});
		const pending = assert.rejects(
			f.service.startTask(mission.id, task.id),
			change === "claimed" ? /already claimed/ : /Unknown task/,
		);
		await preparing;
		if (change === "claimed") f.service.join(owner.id, { missionId: mission.id, taskId: task.id });
		else f.store.removeTask(mission.id, task.id);
		await pending;
		assert.equal(
			flush.mock.calls.length,
			1,
			"rejected admission drains lifecycle writes before removing its directory",
		);
		mock.mock.restore();
		assert.deepEqual(
			f.sessions.list({ archived: "all" }).map((session) => session.id),
			[owner.id],
		);
		assert.deepEqual([...f.workers.keys()], [owner.id]);
		assert.deepEqual(await readdir(join(f.home, "data", "sessions")), [owner.id]);
		assert.deepEqual(f.store.members(mission.id), change === "claimed" ? [owner.id] : []);
		assert.ok(!f.store.events(mission.id).some((event) => event.text.startsWith("Started #")));
		if (change === "claimed") {
			assert.equal(f.store.task(mission.id, task.id).sessionId, owner.id);
			f.store.releaseTask(mission.id, task.id);
			const retry = await f.service.startTask(mission.id, "1");
			assert.equal(f.store.task(mission.id, task.id).sessionId, retry.id);
		}
	});
}

test("multi-start orders a single chat's tasks and attaches supplied references to every task", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
		tasks: [
			{ title: "Base", body: "Build base" },
			{ title: "Feature", body: "Build feature" },
			{ title: "Docs", body: "Write docs" },
		],
	});
	const [a, b, c] = f.store.tasks(mission.id);
	f.store.updateTask(mission.id, b!.id, { dependsOn: [a!.id] });
	const artifact = await f.sessions["artifactStore"](lead.id).create({ title: "Spec", kind: "html", source: "ok" });
	const session = (await f.service.call(lead.id, "start", {
		ids: [b!.id, "1-3", "#1"],
		message: "Ship carefully",
		artifacts: [{ artifactId: artifact.id, revision: 1 }],
		links: [{ url: "https://example.com/spec", title: "Context" }],
	})) as SessionSummary;
	assert.equal(session.title, "Base");
	assert.equal(f.sessions.list().length, 2);
	for (const task of [a!, b!, c!]) {
		assert.equal(f.store.task(mission.id, task.id).sessionId, session.id);
		assert.equal(f.store.task(mission.id, task.id).status, "in_progress");
		const detail = f.store.detail(mission.id);
		assert.equal(
			detail.artifacts.filter((ref) => ref.taskId === task.id && ref.artifactId === artifact.id).length,
			1,
		);
		assert.equal(
			detail.resources.filter((ref) => ref.taskId === task.id && ref.url === "https://example.com/spec").length,
			1,
		);
	}
	const worker = await until(() => f.workers.get(session.id));
	assert.deepEqual(
		worker.spec.mission?.tasks.map((task) => task.number),
		[1, 2, 3],
	);
	const input = await until(() => worker.requests.find((command) => command.type === "input"));
	assert.equal(input.type, "input");
	if (input.type !== "input") return;
	assert.match(input.content, /#1: Base\nBuild base[\s\S]*#2: Feature\nBuild feature[\s\S]*#3: Docs\nWrite docs/);
	assert.match(input.content, /one PR per task/);
	assert.match(input.content, /--base <previous-head>/);
	assert.match(input.content, /gh stack link/);
	assert.match(input.content, /link \+ taskId/);
	assert.match(input.content, /Ship carefully/);
	assert.ok(input.content.length <= 4000);
	assert.equal(f.store.events(mission.id).filter((event) => event.text.startsWith("Started #")).length, 3);
});

test("multi-start uses dependency order then given order, not display or task-number order", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		tasks: [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }],
	});
	f.store.updateTask(mission.id, "2", { dependsOn: ["1"] });
	f.store.updateTask(mission.id, "1", { order: 100 });
	f.store.updateTask(mission.id, "4", { order: -100 });
	const spawn = t.mock.method(f.sessions, "spawn");
	await f.service.startTasks(mission.id, ["2", "3", "1", "4"]);
	const args = spawn.mock.calls[0]!.arguments;
	assert.deepEqual(
		args[2],
		["3", "1", "2", "4"].map((ref) => f.store.resolveTask(mission.id, ref).id),
	);
	assert.match(args[0].message, /#3: C[\s\S]*#1: A[\s\S]*#2: B[\s\S]*#4: D/);
});

test("multi-start rejects outside unfinished dependencies and cycles without writes", async (t) => {
	const f = await fixture(t);
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		tasks: [{ title: "A" }, { title: "B" }, { title: "C" }],
	});
	f.store.updateTask(mission.id, "2", { dependsOn: ["1"] });
	for (const status of ["todo", "dropped"] as const) {
		f.store.updateTask(mission.id, "1", { status });
		const before = f.store.detail(mission.id);
		await assert.rejects(
			f.service.startTasks(mission.id, ["2", "3"]),
			/#2 depends on task #1 outside the start list, which is not done/,
		);
		assert.deepEqual(f.store.detail(mission.id), before);
	}
	f.store.updateTask(mission.id, "1", { status: "done" });
	await f.service.startTasks(mission.id, ["2", "3"]);
	// Cycles can exist in task metadata; start must reject them before creating a chat.
	f.store.updateTask(mission.id, "1", { status: "todo", dependsOn: ["2"] });
	f.store.releaseTask(mission.id, "2");
	const before = f.store.detail(mission.id);
	await assert.rejects(f.service.startTasks(mission.id, ["2", "1"]), /Dependency cycle among tasks #2, #1/);
	assert.deepEqual(f.store.detail(mission.id), before);
	assert.equal(f.sessions.list().length, 1);
});

test("multi-start reports every claim/terminal conflict and rolls back the entire selection", async (t) => {
	const f = await fixture(t);
	const owner = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		tasks: [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }],
	});
	f.service.join(owner.id, { missionId: mission.id, taskId: "2" });
	f.store.updateTask(mission.id, "3", { status: "done" });
	f.store.updateTask(mission.id, "4", { status: "dropped" });
	const before = f.store.detail(mission.id);
	await assert.rejects(
		f.service.startTasks(mission.id, ["1", "2", "3", "4"]),
		/#2 is already claimed[\s\S]*#3 is done[\s\S]*#4 is dropped/,
	);
	assert.deepEqual(f.store.detail(mission.id), before);
	assert.equal(f.sessions.list().length, 1);
	// No leaked reservation on the otherwise eligible task.
	await f.service.startTask(mission.id, "1");
});

for (const first of ["single", "batch"] as const) {
	test(`multi-start shares all reservations with single starts (${first} first)`, async (t) => {
		const f = await fixture(t);
		const { mission } = await f.service.create({
			projectId: f.project.id,
			title: "M",
			tasks: [{ title: "A" }, { title: "B" }, { title: "C" }],
		});
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const preparing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const original = f.sessions.spawn.bind(f.sessions);
		let calls = 0;
		t.mock.method(f.sessions, "spawn", async (...args: Parameters<typeof original>) => {
			if (++calls === 1) {
				entered();
				await blocked;
			}
			return original(...args);
		});
		const pending =
			first === "single" ? f.service.startTask(mission.id, "2") : f.service.startTasks(mission.id, ["1", "2"]);
		try {
			await preparing;
			await assert.rejects(
				first === "single" ? f.service.startTasks(mission.id, ["1", "2"]) : f.service.startTask(mission.id, "#2"),
				/already starting/,
			);
			if (first === "batch") await assert.rejects(f.service.startTask(mission.id, "1"), /already starting/);
			else await f.service.startTask(mission.id, "1"); // failed batch never reserved its free task
			await f.service.startTask(mission.id, "3");
		} finally {
			release();
		}
		const winner = await pending;
		assert.equal(f.store.resolveTask(mission.id, "2").sessionId, winner.id);
	});
}

test("multi-start admission rechecks every claim after spawn I/O with no partial claim", async (t) => {
	const f = await fixture(t);
	const owner = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		tasks: [{ title: "A" }, { title: "B" }],
	});
	let prepared!: () => void;
	const preparing = new Promise<void>((resolve) => {
		prepared = resolve;
	});
	const original = f.sessions["missions"]!.spawnProject;
	t.mock.method(f.sessions["missions"]!, "spawnProject", (id: string) => {
		const project = original(id);
		prepared();
		return project;
	});
	const pending = assert.rejects(f.service.startTasks(mission.id, ["1", "2"]), /#2 is already claimed/);
	await preparing;
	f.service.join(owner.id, { missionId: mission.id, taskId: "2" });
	await pending;
	assert.equal(f.store.resolveTask(mission.id, "1").sessionId, undefined);
	assert.equal(f.store.resolveTask(mission.id, "2").sessionId, owner.id);
	assert.deepEqual(f.store.members(mission.id), [owner.id]);
	assert.deepEqual(
		f.sessions.list().map((session) => session.id),
		[owner.id],
	);
	assert.deepEqual(await readdir(join(f.home, "data", "sessions")), [owner.id]);
	assert.ok(!f.store.events(mission.id).some((event) => event.text.startsWith("Started #")));
	f.store.releaseTask(mission.id, "2");
	await f.service.startTasks(mission.id, ["1", "2"]);
});

test("multi-start caps the whole prompt including bodies, instructions and references", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
		tasks: [
			{ title: "A", body: "a".repeat(2000) },
			{ title: "B", body: "b".repeat(2000) },
		],
	});
	const before = f.store.detail(mission.id);
	await assert.rejects(
		f.service.call(lead.id, "start", { ids: ["1-2"] }),
		/Opening message is too long \(\d+ characters; max 4000\)/,
	);
	assert.deepEqual(f.store.detail(mission.id), before);
	f.store.updateTask(mission.id, "1", { body: "" });
	f.store.updateTask(mission.id, "2", { body: "" });
	const basePrompt = f.sessions.spawn;
	const probe = t.mock.method(f.sessions, "spawn", async (..._args: Parameters<SessionManager["spawn"]>) => {
		throw new Error("probe");
	});
	await assert.rejects(f.service.startTasks(mission.id, ["1", "2"]), /probe/);
	const base = probe.mock.calls[0]!.arguments[0].message;
	probe.mock.restore();
	assert.equal(f.sessions.spawn, basePrompt);
	const extra = "x".repeat(4000 - base.length - 2);
	const clean = f.store.detail(mission.id);
	await assert.rejects(
		f.service.startTasks(mission.id, ["1", "2"], { message: extra + "x", links: [{ url: "https://example.com" }] }),
		/max 4000/,
	);
	await assert.rejects(f.service.startTasks(mission.id, ["1", "2"], { message: extra + "x" }), /4001 characters/);
	assert.deepEqual(f.store.detail(mission.id), clean);
	const session = await f.service.startTasks(mission.id, ["1", "2"], { message: extra });
	const worker = await until(() => f.workers.get(session.id));
	const input = await until(() => worker.requests.find((command) => command.type === "input"));
	assert.equal(input.type === "input" ? input.content.length : 0, 4000);
});

test("coordinator start validates ids selectors without changing single-id admission", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
		tasks: [{ title: "A" }, { title: "B" }],
	});
	for (const args of [
		{ ids: [] },
		{ ids: "1-2" },
		{ ids: [false] },
		{ ids: ["2-1"] },
		{ id: "1", ids: [2] },
		{ ids: [3] },
	])
		await assert.rejects(f.service.call(lead.id, "start", args));
	assert.equal(f.store.resolveTask(mission.id, "1").sessionId, undefined);
	const session = (await f.service.call(lead.id, "start", { ids: [2, "1"] })) as SessionSummary;
	assert.equal(f.store.resolveTask(mission.id, "1").sessionId, session.id);
	assert.equal(f.store.resolveTask(mission.id, "2").sessionId, session.id);
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
	assert.equal(worker.spec.mission?.id, mission.id);
	assert.equal(worker.spec.mission?.tasks[0]?.number, task.number, "the first context already includes the claim");
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
				...requiredAuthRegistration,
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

test("preferred task models are validated, kept from the coordinator and used by starts unless overridden", async (t) => {
	const f = await fixture(t);
	const select = t.mock.method(
		f.sessions,
		"selectTaskModel",
		async (_cwd: string, model?: string, thinking?: string) => {
			if (model === "test/outside")
				throw new Error("Model test/outside is not available in the project's scope. Allowed models: test/model");
			return { model: model?.trim() ?? "test/default", thinking: thinking ?? "medium" };
		},
	);
	const coordinator = await f.spawn();
	const member = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: coordinator.id,
		draft: false,
		tasks: [{ title: "User pick" }, { title: "Lead pick" }, { title: "Override" }, { title: "Stale" }],
	});
	f.service.join(member.id, { missionId: mission.id });
	// App writes pass the same scope and price-cap validation as starts, and save the canonical ID.
	await assert.rejects(f.service.updateTask(mission.id, "1", { preferredModel: "test/outside" }), /not available/);
	assert.equal(f.store.resolveTask(mission.id, "1").preferredModel, undefined);
	await f.service.updateTask(mission.id, "1", { preferredModel: " test/user ", preferredThinking: "high" });
	assert.deepEqual(select.mock.calls.at(-1)?.arguments, [f.project.path, " test/user ", "high"]);
	assert.equal(f.store.resolveTask(mission.id, "1").preferredModel, "test/user");
	// Only the coordinator sets preferences through the tool, and never over the user's.
	await assert.rejects(
		f.service.call(member.id, "task", { id: "2", model: "test/lead" }),
		/Only the mission coordinator can use task model or thinking/,
	);
	await assert.rejects(
		f.service.call(coordinator.id, "task", { id: "1", model: "test/lead" }),
		/user-set preferred model \(test\/user\)/,
	);
	await f.service.call(coordinator.id, "task", { id: "2", model: "test/lead", thinking: "low" });
	const lead = f.store.resolveTask(mission.id, "2");
	assert.deepEqual(
		[lead.preferredModel, lead.preferredThinking, lead.preferredModelSetBy],
		["test/lead", "low", "coordinator"],
	);
	const shown = (await f.service.call(coordinator.id, "get", { id: "2" })) as Record<string, unknown>;
	assert.deepEqual([shown.preferredModel, shown.preferredThinking], ["test/lead", "low"]);
	// The coordinator's start cannot override a user-set preference, but omitting the choice uses it.
	for (const args of [{ model: "test/other" }, { thinking: "low" }])
		await assert.rejects(f.service.call(coordinator.id, "start", { id: "1", ...args }), /Omit model and thinking/);
	assert.equal(f.store.resolveTask(mission.id, "1").sessionId, undefined);
	const user = (await f.service.call(coordinator.id, "start", { id: "1" })) as SessionSummary;
	let worker = await until(() => f.workers.get(user.id));
	assert.deepEqual([worker.spec.model, worker.spec.thinking], ["test/user", "high"]);
	// A coordinator-set preference can be overridden by the coordinator.
	const leadStart = (await f.service.call(coordinator.id, "start", {
		id: "2",
		model: "test/model",
	})) as SessionSummary;
	worker = await until(() => f.workers.get(leadStart.id));
	assert.deepEqual([worker.spec.model, worker.spec.thinking], ["test/model", "medium"]);
	// The app's explicit choice overrides a user-set preference.
	await f.service.updateTask(mission.id, "3", { preferredModel: "test/user", preferredThinking: "high" });
	const override = await f.service.startTask(mission.id, "3", { model: "test/model", thinking: "low" });
	worker = await until(() => f.workers.get(override.id));
	assert.deepEqual([worker.spec.model, worker.spec.thinking], ["test/model", "low"]);
	// A preference that left the scope fails with the task named, before claiming or spawning.
	f.store.updateTask(mission.id, "4", { preferredModel: "test/outside" });
	const sessions = f.sessions.list().length;
	await assert.rejects(f.service.startTask(mission.id, "4"), /Preferred model of task #4: Model test\/outside/);
	assert.equal(f.sessions.list().length, sessions);
	assert.equal(f.store.resolveTask(mission.id, "4").sessionId, undefined);
});

test("app task starts validate mode and base branch before saving references", async (t) => {
	const f = await fixture(t);
	const mission = f.store.create({ projectId: f.project.id, title: "M", tasks: [{ title: "Task" }] });
	const links = [{ url: "https://example.com/spec" }];
	for (const [request, error] of [
		[{ mode: "plan" }, /mode must be build or ask/],
		[{ baseBranch: "main" }, /baseBranch requires a private-clone project/],
		[{ mode: "ask", baseBranch: "HEAD" }, /baseBranch must be a valid exact origin branch name/],
	] as const) {
		await assert.rejects(f.service.startTask(mission.id, "1", { ...request, links } as never), error);
		assert.equal(f.sessions.list().length, 0);
		assert.deepEqual(f.store.detail(mission.id).resources, [], "a rejected start saves no references");
	}
	const ask = await f.service.startTask(mission.id, "1", { mode: "ask", message: "Only investigate", links });
	assert.equal(ask.mode, "ask");
	assert.equal(f.store.resolveTask(mission.id, "1").sessionId, ask.id);
	assert.deepEqual(
		f.store.detail(mission.id).resources.map((item) => item.url),
		["https://example.com/spec"],
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
		"coordinator",
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
	const outcomeAt = Date.now();
	worker.state = "idle";
	worker.onPacket({ type: "jobs.changed", jobs });
	worker.onPacket({ type: "working", working: false, completion: { outcome: "done", outcomeAt } });
	const status = (await f.service.call(lead.id, "status", {})) as { members: Array<Record<string, unknown>> };
	const reported = status.members.find((chat) => chat.id === member.id)!;
	assert.equal(reported.state, "waiting on background job");
	assert.equal(reported.outcome, undefined);
	assert.deepEqual(reported.runningJobs, [{ id: "tests", name: "Tests", startedAt: 1 }]);
	const get = (await f.service.call(lead.id, "get", {})) as { members: Array<Record<string, unknown>> };
	assert.equal(get.members.find((chat) => chat.title === "Background tests")?.state, "waiting on background job");
	worker.onPacket({ type: "jobs.changed", jobs: [] });
	const pending = (await f.service.call(lead.id, "status", {})) as { members: Array<Record<string, unknown>> };
	assert.equal(pending.members.find((chat) => chat.id === member.id)?.outcome, undefined);
	assert.equal(f.sessions.get(member.id)?.working, true);
	// Finishing the jobs alone is not a result. Only their fresh follow-up turn publishes one.
	worker.state = "working";
	worker.onPacket({ type: "working", working: true });
	worker.state = "idle";
	worker.onPacket({ type: "working", working: false, completion: { outcome: "done", outcomeAt: outcomeAt + 1 } });
	const done = (await f.service.call(lead.id, "status", {})) as { members: Array<Record<string, unknown>> };
	assert.equal(done.members.find((chat) => chat.id === member.id)?.outcome, "done");
	assert.equal(f.sessions.get(member.id)?.working, false);
});

test("a coordinator's idle kernel accepts notices while its own jobs keep the chat working", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "M",
		fromSessionId: lead.id,
		draft: false,
	});
	await until(() => !f.sessions["starting"].has(lead.id));
	f.service.notices.start();
	const worker = f.workers.get(lead.id)!;
	worker.state = "idle";
	worker.onPacket({
		type: "jobs.changed",
		jobs: [{ id: "tests", name: "Tests", state: "running", startedAt: 1, outputPath: "/tmp/tests.log" }],
	});
	worker.onPacket({ type: "working", working: false, completion: { outcome: "done", outcomeAt: Date.now() } });
	assert.equal(f.sessions.get(lead.id)?.working, true);
	assert.equal(f.sessions.canSendNotice(lead.id), true);
	f.store.addComment(mission.id, { text: "Update while tests run" });
	await f.service.notices.flush(Date.now() + 30_000);
	const notices = worker.requests.filter(
		(command) => command.type === "input" && command.requestId.startsWith("mission-notice:"),
	);
	assert.equal(notices.length, 1);
	assert.deepEqual(f.store.noticeDeadlines(Date.now()), []);
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
	const phaseCreate = await api(`/missions/${id}/phases`, {
		method: "POST",
		body: JSON.stringify({ name: "Build", goal: "Foundation", order: 1 }),
	});
	assert.equal(phaseCreate.status, 201);
	const buildPhase = (await phaseCreate.json()) as { id: string };
	const shipPhase = (await api(`/missions/${id}/phases`, {
		method: "POST",
		body: JSON.stringify({ name: "Ship", order: 2 }),
	}).then((response) => response.json())) as { id: string };
	const renamedPhase = await api(`/missions/${id}/phases/${buildPhase.id}`, {
		method: "PATCH",
		body: JSON.stringify({ name: "Foundation", order: 0 }),
	});
	assert.equal(renamedPhase.status, 200);
	assert.equal((await renamedPhase.json()).name, "Foundation");
	assert.deepEqual(
		(await api(`/missions/${id}/phases`).then((response) => response.json())).map(
			(phase: { id: string }) => phase.id,
		),
		[buildPhase.id, shipPhase.id],
	);
	const gateTask = (await api(`/missions/${id}/tasks`, {
		method: "POST",
		body: JSON.stringify({ title: "Earlier", phaseId: buildPhase.id }),
	}).then((response) => response.json())) as { id: string };
	assert.equal(
		(
			await api(`/missions/${id}`, { method: "PATCH", body: JSON.stringify({ phaseGating: true }) }).then(
				(response) => response.json(),
			)
		).phaseGating,
		true,
	);
	const assignedPhase = await api(`/missions/${id}/tasks/${taskId}`, {
		method: "PATCH",
		body: JSON.stringify({ phaseId: shipPhase.id }),
	}).then((response) => response.json());
	assert.equal(assignedPhase.status, "blocked");
	assert.equal(assignedPhase.storedStatus, "todo");
	assert.equal(assignedPhase.milestone, "Ship");
	const gatedStart = await api(`/missions/${id}/tasks/${taskId}/start`, { method: "POST", body: "{}" });
	assert.equal(gatedStart.status, 409);
	await gatedStart.arrayBuffer();
	const deletedPhase = await api(`/missions/${id}/phases/${shipPhase.id}`, { method: "DELETE" });
	assert.equal(deletedPhase.status, 200);
	await deletedPhase.arrayBuffer();
	const unphased = (await api(`/missions/${id}`).then((response) => response.json())).tasks.find(
		(value: { id: string }) => value.id === taskId,
	);
	assert.equal(unphased.phaseId, undefined);
	assert.equal(unphased.milestone, undefined);
	await api(`/missions/${id}/tasks/${gateTask.id}`, { method: "DELETE" }).then((response) => response.arrayBuffer());
	await api(`/missions/${id}/phases/${buildPhase.id}`, { method: "DELETE" }).then((response) =>
		response.arrayBuffer(),
	);
	await api(`/missions/${id}`, { method: "PATCH", body: JSON.stringify({ phaseGating: false }) }).then((response) =>
		response.arrayBuffer(),
	);
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
	const linearUrl = "https://linear.app/acme/issue/ENG-12";
	const linearReference = await api(`/missions/${id}/resources`, {
		method: "POST",
		body: JSON.stringify({ url: linearUrl }),
	}).then((response) => response.json());
	assert.equal(linearReference.linearRole, "reference");
	const upgrade = await api(`/missions/${id}/resources/${linearReference.id}`, {
		method: "PATCH",
		body: JSON.stringify({ linearRole: "managed" }),
	});
	assert.equal(upgrade.status, 200);
	assert.equal((await upgrade.json()).linearRole, "managed");
	const contribution = await api(`/missions/${id}/resources`, {
		method: "POST",
		body: JSON.stringify({ url: linearUrl, taskId, linearRole: "contribution" }),
	}).then((response) => response.json());
	assert.equal(contribution.linearRole, "contribution");
	assert.equal(contribution.linearKey, "acme/ENG-12");
	const syncPath = `/missions/${id}/resources/${linearReference.id}/linear-sync`;
	const pausedLinear = await api(syncPath, { method: "POST", body: JSON.stringify({ action: "pause" }) });
	assert.equal(pausedLinear.status, 200);
	assert.equal((await pausedLinear.json()).linearSync.state, "paused");
	const resumedLinear = await api(syncPath, { method: "POST", body: JSON.stringify({ action: "resume" }) });
	assert.equal(resumedLinear.status, 200);
	assert.equal((await resumedLinear.json()).linearSync.state, "idle");
	const invalidSync = await api(syncPath, { method: "POST", body: JSON.stringify({ action: "anything" }) });
	assert.equal(invalidSync.status, 400);
	await invalidSync.arrayBuffer();
	const referenceSync = await api(`/missions/${id}/resources/${contribution.id}/linear-sync`, {
		method: "POST",
		body: JSON.stringify({ action: "resume" }),
	});
	assert.equal(referenceSync.status, 404);
	await referenceSync.arrayBuffer();
	const unsafeDetach = await api(`/missions/${id}/resources/${linearReference.id}`, { method: "DELETE" });
	assert.equal(unsafeDetach.status, 409);
	await unsafeDetach.arrayBuffer();
	const invalidRole = await api(`/missions/${id}/resources/${contribution.id}`, {
		method: "PATCH",
		body: JSON.stringify({ linearRole: "invalid" }),
	});
	assert.equal(invalidRole.status, 400);
	await invalidRole.arrayBuffer();
	const pushedLinear = await until(() =>
		messages.findLast(
			(message) =>
				message.type === "mission" &&
				message.mission.resources.some((link) => link.id === contribution.id && link.linearRole === "contribution"),
		),
	);
	assert.ok(pushedLinear);
	await api(`/missions/${id}/resources/${contribution.id}`, { method: "DELETE" }).then((response) =>
		response.arrayBuffer(),
	);
	await api(`/missions/${id}/resources/${linearReference.id}`, { method: "DELETE" }).then((response) =>
		response.arrayBuffer(),
	);
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

	const proposed = (await f.service.call(lead.id, "propose", {
		decisionId: "D1",
		text: "Accepted wording",
		reason: "Clarify",
	})) as { id: string };
	const accepted = await api(`/missions/${id}/decision-proposals/${proposed.id}/accept`, {
		method: "POST",
		body: JSON.stringify({ text: "Edited wording" }),
	});
	assert.equal(accepted.status, 200);
	assert.equal((await accepted.json()).status, "accepted");
	assert.equal(f.store.detail(id).decisions[0]!.text, "Edited wording");
	const removal = (await f.service.call(lead.id, "propose", { decisionId: "D1", remove: true, reason: "Old" })) as {
		id: string;
	};
	const rejected = await api(`/missions/${id}/decision-proposals/${removal.id}/reject`, {
		method: "POST",
		body: "{}",
	});
	assert.equal(rejected.status, 200);
	assert.equal((await rejected.json()).status, "rejected");
	assert.equal(f.store.detail(id).decisions.length, 1);
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

test("proposals expose only coordinator results and never alter member prompt wording until accepted", async (t) => {
	const f = await fixture(t);
	const lead = await f.spawn();
	const worker = await f.spawn();
	const { mission } = await f.service.create({
		projectId: f.project.id,
		title: "Shared",
		fromSessionId: lead.id,
		draft: false,
	});
	f.service.join(worker.id, { missionId: mission.id });
	f.store.addDecision(mission.id, "Binding", {}, "all");
	await assert.rejects(
		f.service.call(worker.id, "propose", { decisionId: "D1", text: "Change", reason: "Why" }),
		/Only the mission coordinator/,
	);
	const proposal = (await f.service.call(lead.id, "propose", {
		decisionId: "D1",
		text: "Replacement",
		reason: "Superseded",
	})) as { id: string };
	assert.deepEqual(f.service.context(worker.id)?.decisions, ["D1: Binding"]);
	let result = (await f.service.call(lead.id, "get", {})) as {
		decisionProposals: { id: string; status: string }[];
		decisions: string[];
	};
	assert.equal(result.decisionProposals[0]!.status, "pending");
	assert.deepEqual(result.decisions, ["D1"]);
	assert.equal("decisionProposals" in ((await f.service.call(worker.id, "get", {})) as object), false);
	f.store.resolveProposal(mission.id, proposal.id, true);
	assert.deepEqual(f.service.context(worker.id)?.decisions, ["D1: Replacement"]);
	result = (await f.service.call(lead.id, "get", {})) as typeof result;
	assert.equal(result.decisionProposals[0]!.status, "accepted");
});
