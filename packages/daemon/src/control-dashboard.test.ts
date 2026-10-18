import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
	DelegationGrant,
	Mission,
	OperationHost,
	Project,
	SessionSummary,
	SharedContextBinding,
	Watch,
} from "@pilot/protocol";
import { WebSocket } from "ws";
import { buildControlDashboard, type ControlDashboardSources } from "./control-dashboard.ts";
import { ControlPilot } from "./control-pilot.ts";
import { MissionStore } from "./missions.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { WatchService } from "./watch-service.ts";

const chat = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
	id,
	title: `Chat ${id}`,
	cwd: "/unused",
	projectId: "p",
	missionId: "m",
	state: "parked",
	createdAt: 100,
	updatedAt: 200,
	...patch,
});
const watch: Watch = {
	id: "w",
	createdAt: 100,
	event: "chat.settled",
	target: { kind: "chat", id: "run" },
	mode: "once",
	note: "Read the result and report it",
};
function sharedFixture(t: TestContext) {
	const store = new MissionStore(":memory:"),
		authority = new MissionStore(":memory:");
	t.after(async () => {
		await store.close();
		await authority.close();
	});
	const host: OperationHost = { hostId: "daemon", daemonId: "local", lineageId: "local-lineage" };
	const remote: OperationHost = { hostId: "daemon", daemonId: "devbox", lineageId: "remote-lineage" };
	const mission = store.create({ projectId: "p", title: "Home", tasks: [{ title: "Remote build" }] });
	store.shareMission(mission.id);
	const task = store.tasks(mission.id)[0]!;
	const grant: DelegationGrant = {
		delegationId: "grant",
		task: { mission: { home: host, missionId: mission.id }, taskId: task.id },
		executionEpoch: 1,
		bindingId: "outgoing",
		bindingGeneration: 1,
		target: { host: remote, projectId: "remote-project" },
		session: { host: remote, sessionId: "remote-chat" },
		definitionRevision: store.sharedDefinitionRevision(task.id),
		context: { memory: 0, mission: store.sharedHead() },
		manifestId: "manifest",
		references: [],
		request: { projectId: "remote-project", message: "Do work", model: "test/model" },
		state: "reserved",
	};
	store.reserveSharedGrant(grant, 0);
	const remoteMission = authority.create({
		projectId: "remote-project",
		title: "Remote home",
		tasks: [{ title: "Committed title" }],
	});
	authority.shareMission(remoteMission.id);
	const snapshot = authority.sharedSnapshot(remoteMission.id);
	const binding: SharedContextBinding = {
		schemaVersion: 1,
		bindingId: "incoming",
		generation: 1,
		logicalProjectId: "logical",
		memoryHome: { host: remote, projectId: "remote-project" },
		missionHome: remote,
		executionProject: { host, projectId: "p" },
		missionIds: [remoteMission.id],
		shareMemory: false,
		state: "active",
	};
	store.sharingPut("binding", binding.bindingId, binding);
	const replica = {
		sequence: snapshot.sequence,
		complete: true,
		syncedAt: 1000,
		missions: { [remoteMission.id]: snapshot },
	};
	store.sharingPut("replica", binding.bindingId, replica);
	const remoteTask = snapshot.detail.tasks[0]!;
	for (const [proposalId, state] of [
		["pending", "pending"],
		["conflict", "conflict"],
		["rejected", "rejected"],
		["applied", "committed"],
	])
		store.sharingPut(`proposal:${binding.bindingId}`, proposalId!, {
			proposalId,
			missionId: remoteMission.id,
			entityId: remoteTask.id,
			expectedRevision: 1,
			action: "task",
			args: { id: remoteTask.id, title: "Proposed title", status: "done" },
			origin: { host, sessionId: "local-chat" },
			state,
		});
	return { store, host, remote, mission, task, grant, remoteMission, remoteTask, binding, replica };
}
function fixture(): { sources: ControlDashboardSources; chats: SessionSummary[] } {
	const chats = [
		chat("run", {
			state: "working",
			working: true,
			lastUserMessageAt: 1000,
			model: "test/model",
			outcome: "question",
		}),
		chat("starting", { state: "starting" }),
		chat("job", { state: "idle", working: true }),
		chat("failed", { outcome: "failed", outcomeReason: "Could not start", outcomeAt: 200 }),
		chat("question", { outcome: "question", outcomeReason: "Which environment?" }),
		chat("startup", { state: "failed", error: "Startup failed" }),
		chat("other", { projectId: "q", missionId: undefined, state: "working" }),
		chat("archived", { archivedAt: 500, state: "working" }),
		chat("pr", {
			pullRequest: {
				number: 1,
				url: "https://github.com/example/repo/pull/1",
				title: "PR",
				state: "open",
				checkedAt: 200,
				readiness: { state: "blocked", checkedAt: 200, reasons: [{ code: "failing_checks" }] },
			},
		}),
	];
	return {
		chats,
		sources: {
			sessions: {
				list: (query) =>
					chats.filter(
						(c) =>
							!c.archivedAt &&
							(!query?.projectId || c.projectId === query.projectId) &&
							(!query?.missionId || c.missionId === query.missionId),
					),
			},
			projects: () =>
				[
					{ id: "p", name: "Project" },
					{ id: "q", name: "Other" },
				] as Project[],
			missions: () =>
				[
					{ id: "m", projectId: "p", title: "Mission", status: "active", tasksDone: 2, tasksTotal: 3 },
					{ id: "done", projectId: "q", title: "Done", status: "done", tasksDone: 1, tasksTotal: 1 },
				] as Mission[],
			linear: (projectId) => [
				{ id: `${projectId}-issue`, title: "Issue", missionId: projectId === "p" ? "m" : undefined },
			],
			missionAttention: () => ({
				blockedTotal: 1,
				decisionsTotal: 1,
				blockedTasks: [
					{
						id: "task:t",
						kind: "blocked_task",
						projectId: "p",
						missionId: "m",
						taskId: "t",
						taskNumber: 3,
						title: "Blocked",
						detail: "Waiting for access",
						at: 300,
					},
				],
				pendingDecisions: [
					{
						id: "proposal",
						projectId: "p",
						missionId: "m",
						decisionId: "d",
						kind: "edit",
						text: "New rule",
						reason: "Requirements changed",
						authorSessionId: "lead",
						createdAt: 300,
					},
				],
			}),
			failingChecks: () => [
				{
					id: "check:1",
					kind: "failing_checks",
					projectId: "p",
					missionId: "m",
					sessionId: "pr",
					title: "PR",
					detail: "Tests failed",
					url: "https://github.com/example/repo/pull/1",
					headSha: "a".repeat(40),
					at: 400,
				},
			],
			nextWatches: () => ({ watches: [watch], total: 1 }),
		},
	};
}

test("shared snapshot reports running work, active progress, open blockers, decisions and saved next instructions", () => {
	const { sources } = fixture();
	const data = buildControlDashboard(sources, {}, 5000);
	assert.deepEqual(
		data.runningAgents.map((c) => c.id),
		["run", "starting", "job", "other"],
	);
	assert.equal(data.runningAgents[0]!.startedAt, 1000);
	assert.equal(data.runningAgents[0]!.elapsedMs, 4000);
	assert.equal(data.runningAgents[1]!.elapsedMs, 4900);
	assert.equal(data.activeMissions.length, 1);
	assert.equal(data.activeMissions[0]!.tasksDone, 2);
	assert.deepEqual(
		data.blockers.map((b) => b.kind),
		["failed_chat", "question", "failed_chat", "blocked_task", "failing_checks"],
	);
	assert.ok(!data.blockers.some((b) => b.sessionId === "run"), "a prior question does not block a resumed chat");
	assert.equal(data.pendingDecisions[0]!.reason, "Requirements changed");
	assert.deepEqual(data.next, { watches: [watch], total: 1, followUps: [], followUpsTotal: 0 });
	assert.equal(data.totals.chats, 8);
	assert.equal(data.truncated, false);
	const scoped = buildControlDashboard(sources, { missionId: "m" }, 5000);
	assert.ok(scoped.chats.every((c) => c.missionId === "m"));
	assert.ok(scoped.linear.every((i) => i.projectId === "p"));
	assert.ok(scoped.blockers.every((i) => i.missionId === "m"));
	assert.deepEqual(scoped.next, data.next, "next is explicitly global even for scoped reads");
	sources.failingChecks = undefined;
	assert.ok(
		!buildControlDashboard(sources).blockers.some((b) => b.kind === "failing_checks"),
		"legacy readiness is not exact-head evidence",
	);
	assert.equal(buildControlDashboard(sources, {}, 0).runningAgents[0]!.elapsedMs, 0);
});

test("all lists and Unicode payloads stay within row/byte bounds with pre-clipping totals", () => {
	const { sources, chats } = fixture();
	chats.splice(
		0,
		chats.length,
		...Array.from({ length: 10_000 }, (_, i) =>
			chat(`chat-${i}`, { state: "working", title: "😀".repeat(1000), model: "M".repeat(2000) }),
		),
	);
	sources.projects = () =>
		Array.from({ length: 250 }, (_, i) => ({ id: `p${i}`, name: "😀".repeat(100) })) as Project[];
	sources.missions = () =>
		Array.from({ length: 150 }, (_, i) => ({
			id: `m${i}`,
			projectId: "p",
			title: "😀".repeat(1000),
			status: "active",
			tasksDone: 1,
			tasksTotal: 200,
		})) as Mission[];
	sources.nextWatches = () => ({
		total: 10_000,
		watches: Array.from({ length: 100 }, (_, i) => ({ ...watch, id: `w${i}`, note: "N".repeat(4096) })),
	});
	const data = buildControlDashboard(sources);
	assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 24_000);
	assert.equal(data.totals.chats, 10_000);
	assert.equal(data.totals.runningAgents, 10_000);
	assert.equal(data.totals.activeMissions, 150);
	assert.equal(data.next.total, 10_000);
	assert.equal(data.truncated, true);
	for (const list of [
		data.chats,
		data.runningAgents,
		data.blockers,
		data.pendingDecisions,
		data.next.watches,
		data.pullRequests,
		data.linear,
	])
		assert.ok(list.length <= 100);
	assert.ok(data.missions.length <= 50 && data.activeMissions.length <= 50 && data.projects.length <= 200);
});

test("mission attention cache reads thin bounded rows, excludes resolved proposals and updates on changes", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const mission = store.create({
		projectId: "p",
		title: "M",
		tasks: [{ title: "Task", body: "Reason ".repeat(1000) }],
	});
	store.join("lead", mission.id);
	store.update(mission.id, { coordinatorSessionId: "lead" });
	store.updateTask(mission.id, "1", { status: "blocked" });
	const decision = store.addDecision(mission.id, "Rule");
	const proposal = store.proposeDecision(mission.id, decision.id, "Suggestion", undefined, "Reason", {
		sessionId: "lead",
	});
	for (const name of ["tasks", "detail", "proposals"] as const)
		t.mock.method(store, name, () => {
			throw new Error("Full materialization forbidden");
		});
	let cached = store.controlAttention(mission);
	assert.equal(cached.blockedTotal, 1);
	assert.equal(cached.blockedTasks[0]!.detail!.length, 512);
	assert.equal(cached.decisionsTotal, 1);
	assert.equal(cached.pendingDecisions[0]!.id, proposal.id);
	const stop = store.onChange(() => {
		cached = store.controlAttention(mission);
	});
	t.after(stop);
	store.resolveProposal(mission.id, proposal.id, false);
	assert.equal(cached.decisionsTotal, 0);
	assert.deepEqual(cached.pendingDecisions, []);
	// Bulk seed through the real writer, while retaining only bounded projection rows.
	for (let i = 0; i < 105; i++) store.addTask(mission.id, { title: `Blocked ${i}`, status: "blocked" });
	assert.equal(cached.blockedTotal, 106);
	assert.equal(cached.blockedTasks.length, 100);
});

test("mission-home grants retain host, epoch and acknowledged state without inferring failure from disconnection", (t) => {
	const { store, host, remote, grant, mission, task } = sharedFixture(t);
	const { sources } = fixture();
	sources.missions = () => [mission];
	let cache = store.controlSharedContext(host);
	sources.sharedContext = () => cache;
	const read = () => buildControlDashboard(sources, { missionId: mission.id }, 5000);
	let row = read().sharedTasks[0]!;
	assert.deepEqual(row.executionHost, remote);
	assert.equal(row.executionEpoch, 1);
	assert.equal(row.grantState, "reserved");
	assert.equal(row.running, undefined);
	assert.equal(row.consistency, "committed");
	assert.equal(row.taskId, task.id);
	grant.state = "accepted";
	store.updateSharedGrant(grant);
	store.sharingPut("remote-projection", grant.delegationId, {
		eligible: true,
		event: { delegationId: grant.delegationId, executionEpoch: 1, payload: { working: true } },
	});
	cache = store.controlSharedContext(host);
	row = read().sharedTasks[0]!;
	assert.equal(row.grantState, "accepted");
	assert.equal(row.running, true);
	// No newer facts arrive while disconnected. Old age alone cannot change accepted/running into failed.
	const disconnected = buildControlDashboard(sources, { missionId: mission.id }, 10 ** 12);
	assert.deepEqual(disconnected.sharedTasks, read().sharedTasks);
	assert.equal(
		disconnected.blockers.some((b) => b.kind === "failed_chat"),
		false,
	);
	assert.equal(store.sharedAllocation(task.id)?.executionEpoch, 1);
	grant.state = "cancel_requested";
	store.updateSharedGrant(grant);
	cache = store.controlSharedContext(host);
	assert.equal(read().sharedTasks[0]!.grantState, "cancel_requested");
	assert.equal(read().sharedTasks[0]!.running, true, "cancel is not a stopped acknowledgment");
	grant.state = "sealed";
	store.updateSharedGrant(grant);
	cache = store.controlSharedContext(host);
	assert.equal(read().sharedTasks[0]!.grantState, "sealed");
	assert.equal(read().sharedTasks[0]!.running, false);
	store.reserveSharedGrant({ ...grant, delegationId: "next-grant", executionEpoch: 2, state: "reserved" }, 1);
	store.sharingPut("remote-projection", "next-grant", {
		eligible: true,
		event: { delegationId: "next-grant", executionEpoch: 1, payload: { working: true } },
	});
	cache = store.controlSharedContext(host);
	assert.equal(read().sharedTasks[0]!.executionEpoch, 2);
	assert.equal(read().sharedTasks[0]!.running, undefined, "old epoch facts do not describe a new grant");
});

test("remote-home replicas separate committed tasks from provisional proposals, with mission-only age and scoped identity", (t) => {
	const { store, host, remote, remoteMission, remoteTask, binding, replica } = sharedFixture(t);
	const { sources } = fixture();
	store.sharingPut("freshness", binding.bindingId, { lastSyncedAt: 4999 }); // newer memory sync is not mission freshness
	sources.sharedContext = () => cache;
	let cache = store.controlSharedContext(host);
	const replicaGroup = cache.find((g) => g.replica)!;
	store.sharingPut("freshness", binding.bindingId, { lastSyncedAt: 5000 });
	assert.equal(
		store.controlSharedContext(host).find((g) => g.replica),
		replicaGroup,
		"memory-only invalidations reuse the replica projection",
	);
	for (const method of ["detail", "tasks", "sharingGet", "sharedGrants"] as const)
		t.mock.method(store, method, () => {
			throw new Error("No full hydration or tool-time store read");
		});
	const data = buildControlDashboard(sources, { missionId: remoteMission.id }, 5000);
	assert.equal(data.missions.length, 0, "replicas are not writable local missions");
	assert.equal(data.replicaMissions.length, 1);
	assert.deepEqual(data.replicaMissions[0]!.missionHome, remote);
	assert.equal(data.replicaMissions[0]!.projectId, "p", "filters use the enrolled execution project");
	assert.equal(data.replicaMissions[0]!.replicaAgeMs, 4000);
	assert.equal(data.replicaMissions[0]!.consistency, "committed");
	assert.equal(data.sharedTasks.length, 4);
	const committed = data.sharedTasks.find((r) => r.consistency === "committed")!;
	assert.equal(committed.taskId, remoteTask.id);
	assert.equal(committed.title, "Committed title");
	assert.equal(committed.status, "todo", "proposed completion is not committed completion");
	assert.equal(committed.replicaAgeMs, 4000);
	assert.deepEqual(
		data.sharedTasks
			.filter((r) => r.consistency === "provisional")
			.map((r) => r.proposalState)
			.sort(),
		["conflict", "pending", "rejected"],
	);
	assert.equal(data.blockers.length, 0);
	assert.equal(buildControlDashboard(sources, { projectId: "q" }).totals.sharedTasks, 0);
	assert.throws(
		() => buildControlDashboard(sources, { projectId: "q", missionId: remoteMission.id }),
		/another project/,
	);
	const later = buildControlDashboard(sources, { missionId: remoteMission.id }, 9000);
	assert.equal(later.replicaMissions[0]!.replicaAgeMs, 8000);
	assert.equal(later.replicaMissions[0]!.status, "active");
	assert.equal(later.blockers.length, 0, "disconnected replica age is not an execution failure");
	assert.equal(buildControlDashboard(sources, { missionId: remoteMission.id }, 0).replicaMissions[0]!.replicaAgeMs, 0);
	store.sharingPut(`proposal:${binding.bindingId}`, "new-task", {
		proposalId: "new-task",
		missionId: remoteMission.id,
		entityId: "uncommitted-entity",
		expectedRevision: 0,
		action: "task",
		args: { title: "Proposed new task" },
		origin: { host, sessionId: "local-chat" },
		state: "pending",
	});
	cache = store.controlSharedContext(host);
	const newTask = buildControlDashboard(sources, { missionId: remoteMission.id }).sharedTasks.find(
		(r) => r.proposalId === "new-task",
	)!;
	assert.equal(newTask.consistency, "provisional");
	assert.equal(newTask.taskId, undefined);
	assert.equal(newTask.taskNumber, undefined, "new proposals have no invented canonical number");
	// Identical raw mission/task IDs on another authority stay separate, including project filtering.
	const otherBinding = {
		...binding,
		bindingId: "second",
		missionHome: { ...remote, lineageId: "second-lineage" },
		executionProject: { host, projectId: "q" },
	};
	store.sharingPut("binding", otherBinding.bindingId, otherBinding);
	store.sharingPut("replica", otherBinding.bindingId, replica);
	cache = store.controlSharedContext(host);
	const both = buildControlDashboard(sources, { missionId: remoteMission.id });
	assert.equal(both.replicaMissions.length, 2);
	assert.equal(new Set(both.sharedTasks.map((r) => r.id)).size, both.sharedTasks.length);
	assert.equal(
		buildControlDashboard(sources, { projectId: "p", missionId: remoteMission.id }).replicaMissions.length,
		1,
	);
	store.sharingPut("binding", otherBinding.bindingId, { ...otherBinding, state: "revoked" });
	const { syncedAt: _, ...legacy } = replica;
	store.sharingPut("replica", binding.bindingId, legacy);
	cache = store.controlSharedContext(host);
	assert.equal(buildControlDashboard(sources, { missionId: remoteMission.id }).replicaMissions[0]!.replicaAgeMs, null);
	store.sharingPut("replica", binding.bindingId, { ...replica, complete: false });
	cache = store.controlSharedContext(host);
	const incomplete = buildControlDashboard(sources, { missionId: remoteMission.id });
	assert.equal(incomplete.replicaMissions[0]!.complete, false);
	assert.equal(incomplete.sharedTasks.length, 0, "incomplete replica tasks are not advertised as committed");
	store.sharingPut("binding", binding.bindingId, { ...binding, state: "revoked" });
	cache = store.controlSharedContext(host);
	assert.throws(() => buildControlDashboard(sources, { missionId: remoteMission.id }), /Unknown mission/);
});

test("shared-context projections stay thin and bounded before dashboard byte clipping", (t) => {
	const { store, host, binding, replica, remoteMission, remoteTask } = sharedFixture(t);
	const snapshot = replica.missions[remoteMission.id]!;
	snapshot.detail.tasks = Array.from({ length: 150 }, (_, i) => ({
		...remoteTask,
		id: `large-${i}`,
		title: "😀".repeat(1000),
		body: "x".repeat(1000),
	}));
	store.sharingPut("replica", binding.bindingId, replica);
	const projectionStarted = performance.now();
	const cache = store.controlSharedContext(host);
	t.diagnostic(`150-task replica thin projection: ${(performance.now() - projectionStarted).toFixed(2)} ms`);
	const group = cache.find((g) => g.replica)!;
	assert.equal(group.tasksTotal, 153);
	assert.equal(group.tasks.length, 100);
	assert.equal(JSON.stringify(group).includes('"body"'), false);
	const { sources } = fixture();
	sources.sharedContext = () => cache;
	const data = buildControlDashboard(sources, { missionId: remoteMission.id });
	assert.equal(data.totals.sharedTasks, 153);
	assert.equal(data.totals.replicaMissions, 1);
	assert.equal(data.truncated, true);
	assert.ok(data.sharedTasks.length <= 100);
	assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 24_000);
	const chats = Array.from({ length: 10_000 }, (_, i) => chat(`stream-${i}`, { state: "working", working: true }));
	sources.sessions = { list: () => chats };
	const samples: number[][] = [[], []];
	for (let i = 0; i < 6; i++) {
		chats[0]!.title += " streaming append";
		for (const variant of i % 2 ? [1, 0] : [0, 1]) {
			sources.sharedContext = variant ? () => cache : undefined;
			const start = performance.now();
			buildControlDashboard(sources);
			if (i) samples[variant]!.push(performance.now() - start);
		}
	}
	const median = (values: number[]) => values.sort((a, b) => a - b)[2]!.toFixed(2);
	t.diagnostic(
		`10,000 working-chat snapshot median: existing ${median(samples[0]!)} ms; shared-context ${median(samples[1]!)} ms (synthetic appends, 5 alternating samples)`,
	);
});

test("HTTP and pilot status agree on the identical fixture; bad params are 400 and reads never wake workers", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-dashboard-"));
	const projects = new ProjectStore(home),
		sessions = new SessionManager(home, projects),
		terminals = new TerminalManager();
	const { sources } = fixture();
	const shared = sharedFixture(t);
	const sharedCache = shared.store.controlSharedContext(shared.host);
	sources.sharedContext = () => sharedCache;
	t.mock.method(sessions, "list", sources.sessions.list);
	t.mock.method(projects, "list", sources.projects);
	const history = t.mock.method(sessions, "history", async () => {
		throw new Error("History forbidden");
	});
	const ensure = t.mock.method(sessions, "ensureControlChat", async () => {
		throw new Error("Creating control forbidden");
	});
	const service = new ControlPilot({ ...sources, sessions, isControl: (id) => id === "control" });
	sessions.setPilot(service);
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
	);
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/control-chat/dashboard`;
	t.mock.method(Date, "now", () => 5000);
	for (const args of [
		{},
		{ projectId: "p" },
		{ missionId: "m" },
		{ projectId: "p", missionId: "m" },
		{ missionId: shared.remoteMission.id },
	] as Record<string, string>[]) {
		const response = await fetch(`${base}?${new URLSearchParams(args)}`);
		assert.equal(response.status, 200);
		assert.deepEqual(
			await response.json(),
			JSON.parse(JSON.stringify(await service.call("control", "status", args))),
		);
	}
	for (const query of [
		"limit=0",
		"limit=101",
		"projectId=",
		"missionId=",
		"projectId=p&projectId=q",
		"missionId=m&missionId=m",
		"projectId=unknown",
		"missionId=unknown",
		"projectId=q&missionId=m",
		`projectId=${"x".repeat(129)}`,
		"projectId=%00",
	]) {
		assert.equal((await fetch(`${base}?${query}`)).status, 400, query);
	}
	assert.equal((await fetch(base, { headers: { origin: "https://example.com" } })).status, 403);
	assert.equal((await fetch(base, { method: "POST" })).status, 404);
	assert.equal((await fetch(`${base}/extra`)).status, 404);
	await assert.rejects(service.call("other", "status", {}), /Only the control/);
	await assert.rejects(service.call("control", "status", { limit: 0 }), /Unknown parameter/);
	assert.equal(history.mock.callCount(), 0);
	assert.equal(ensure.mock.callCount(), 0);
});

test("watch dashboard is change-driven, bounded, restored at startup and drops fired instructions", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-watch-cache-"));
	let watches = new WatchService(join(home, "watches.sqlite"));
	t.after(async () => {
		await watches.close();
		await rm(home, { recursive: true, force: true });
	});
	await watches.ready();
	assert.deepEqual(watches.dashboard(), {
		watches: [],
		total: 0,
		followUps: [],
		followUpsTotal: 0,
		authorizationNeeded: [],
		authorizationNeededTotal: 0,
	});
	for (let i = 0; i < 102; i++) await watches.add({ ...watch, target: { kind: "chat", id: `chat${i}` } });
	assert.equal(watches.dashboard().total, 102);
	assert.equal(watches.dashboard().watches.length, 100);
	await watches.close();
	watches = new WatchService(join(home, "watches.sqlite"));
	await watches.ready();
	assert.equal(watches.dashboard().total, 102);
	const rpc = t.mock.method(watches as unknown as { rpc: (...args: unknown[]) => unknown }, "rpc");
	for (let i = 0; i < 100; i++) watches.dashboard();
	assert.equal(rpc.mock.callCount(), 0, "cached reads do not contact the storage worker");
	await watches.observe([
		{
			source: "chat0",
			version: "1",
			event: "chat.settled",
			targets: [{ kind: "chat", id: "chat0" }],
			at: Date.now(),
			text: "Finished",
			outcome: "done",
		},
	]);
	assert.equal(watches.dashboard().total, 101);
	assert.ok(!watches.dashboard().watches.some((w) => w.target.id === "chat0"));
});

test("dashboard.changed coalesces session, watch and shared-context bursts without building a snapshot", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-dashboard-ws-"));
	const projects = new ProjectStore(home),
		sessions = new SessionManager(home, projects),
		terminals = new TerminalManager(),
		watches = new WatchService(":memory:");
	await watches.ready();
	const listeners = new Set<(chat: SessionSummary) => void>();
	const sharedListeners = new Set<() => void>();
	const { sources } = fixture();
	sessions.setPilot(
		new ControlPilot({
			...sources,
			sessions,
			isControl: () => true,
			onDashboardChange: (listener) => {
				sharedListeners.add(listener);
				return () => {
					sharedListeners.delete(listener);
				};
			},
		}),
	);
	t.mock.method(sessions, "onChange", (listener: (chat: SessionSummary) => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	});
	const dashboard = t.mock.method(sessions, "controlDashboard", () => {
		throw new Error("No rebuild on invalidation");
	});
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		watches,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`);
	t.after(async () => {
		ws.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
		await sessions.shutdown();
		await watches.close();
		await rm(home, { recursive: true, force: true });
	});
	await once(ws, "open");
	let count = 0;
	const invalidation = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Missing dashboard.changed")), 5000);
		ws.on("message", (raw) => {
			const message = JSON.parse(String(raw));
			if (message.type !== "dashboard.changed") return;
			assert.deepEqual(message, { type: "dashboard.changed" });
			count++;
			clearTimeout(timeout);
			resolve();
		});
	});
	for (let i = 0; i < 20; i++) for (const listener of listeners) listener(chat("run", { state: "working" }));
	assert.ok(sharedListeners.size > 0);
	for (let i = 0; i < 20; i++) for (const listener of sharedListeners) listener();
	await Promise.all(Array.from({ length: 10 }, () => watches.add(watch)));
	await invalidation;
	assert.equal(count, 1);
	assert.equal(dashboard.mock.callCount(), 0);
});
