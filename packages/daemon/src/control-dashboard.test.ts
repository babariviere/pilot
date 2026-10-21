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
import { createPilotTool } from "../../kernel/src/pilot-tool.ts";
import {
	buildControlDashboard,
	type ControlDashboardSources,
	type ControlSharedMissionGroup,
} from "./control-dashboard.ts";
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
const localHost: OperationHost = { hostId: "daemon", daemonId: "local", lineageId: "local-lineage" };
const replicaHost: OperationHost = { hostId: "daemon", daemonId: "remote", lineageId: "remote-lineage" };
function replicaGroup(
	bindingId: string,
	patch: Partial<NonNullable<ControlSharedMissionGroup["replica"]>> = {},
): ControlSharedMissionGroup {
	const replica: NonNullable<ControlSharedMissionGroup["replica"]> = {
		id: `replica:${bindingId}:m`,
		bindingId,
		projectId: "p",
		missionId: "m",
		missionHome: replicaHost,
		title: "Mission",
		status: "active",
		complete: true,
		sequence: 1,
		consistency: "committed",
		replicaAgeMs: null,
		...patch,
	};
	return { projectId: replica.projectId, missionId: replica.missionId, replica, tasks: [], tasksTotal: 0 };
}
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
			controlStart: { authorizationId: "approved-start", budgetUsd: 2.5 },
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
			host: localHost,
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
	assert.equal(data.runningAgents[0]!.model, "test/model");
	assert.deepEqual(data.runningAgents[0]!.controlStart, { authorizationId: "approved-start", budgetUsd: 2.5 });
	assert.deepEqual(data.chats[0]!.controlStart, data.runningAgents[0]!.controlStart);
	assert.equal(data.chats[1]!.controlStart, undefined);
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

test("logical missions collapse canonical, replica and task observations without merging different homes", () => {
	const { sources } = fixture();
	sources.missions = () =>
		[
			{
				id: "m",
				projectId: "p",
				title: "Mission",
				status: "archived",
				tasksDone: 2,
				tasksTotal: 3,
				coordinatorSessionId: "lead",
			},
		] as Mission[];
	const copy = replicaGroup("copy", {
		missionHome: { ...localHost, hostId: "alias" },
		sequence: 100,
		title: "Stale replica",
		status: "active",
		replicaSyncedAt: 4999,
	});
	copy.tasks.push({
		id: "task",
		bindingId: "copy",
		projectId: "p",
		missionId: "m",
		missionHome: localHost,
		source: "replica",
		consistency: "provisional",
		status: "done",
		title: "Not a mission title",
	});
	sources.sharedContext = () => [
		copy,
		replicaGroup("other"),
		replicaGroup("alias", { missionHome: { ...replicaHost, hostId: "alias" } }),
		replicaGroup("lineage", { missionHome: { ...replicaHost, lineageId: "other-lineage" } }),
	];
	const data = buildControlDashboard(sources, {}, 5000);
	assert.equal(data.totals.logicalMissions, 3);
	assert.equal(data.logicalMissions!.length, 3);
	const [canonical, other, lineage] = data.logicalMissions!;
	assert.equal(canonical!.id, JSON.stringify([localHost.daemonId, localHost.lineageId, "m"]));
	assert.deepEqual(canonical!.mission, { home: localHost, missionId: "m" });
	assert.equal(canonical!.title, "Mission");
	assert.equal(canonical!.status, "archived", "canonical committed state beats even a later replica sequence");
	assert.equal(canonical!.tasksDone, 2);
	assert.equal(canonical!.tasksTotal, 3);
	assert.deepEqual(canonical!.coordinator, { host: localHost, sessionId: "lead" });
	assert.deepEqual(
		canonical!.provenance.map((p) => p.kind),
		["canonical", "replica"],
	);
	assert.ok(
		canonical!.provenance.every((p) => p.sourceHost === localHost),
		"provenance identifies the verified observer, not execution/home guesses",
	);
	assert.equal(other!.title, "Mission");
	assert.equal(other!.provenance.length, 2);
	assert.notEqual(other!.id, lineage!.id);
	assert.equal(other!.tasksTotal, undefined, "replica task counts are not mission progress");
	assert.equal(other!.coordinator, undefined, "observer/executor is not a fallback coordinator");
	assert.equal(data.missions.length, 1);
	assert.equal(data.replicaMissions.length, 4, "compatibility arrays stay intact");
	assert.deepEqual(
		buildControlDashboard(sources, { projectId: "q" }, 5000).logicalMissions,
		data.logicalMissions,
		"resource filters do not partition the logical mission registry",
	);
	assert.deepEqual(buildControlDashboard(sources, { missionId: "m" }, 5000).logicalMissions, data.logicalMissions);
});

test("logical replica precedence uses complete contiguous sequences, not time or observation order", () => {
	const { sources } = fixture();
	sources.missions = () => [];
	const groups = [
		replicaGroup("old", { sequence: 2, title: "Old", replicaSyncedAt: 4999 }),
		replicaGroup("latest", { sequence: 5, title: "Latest", status: "done", replicaSyncedAt: 1000 }),
		replicaGroup("incomplete", {
			sequence: 100,
			title: "Unusable",
			status: "active",
			complete: false,
			replicaSyncedAt: 5000,
		}),
	];
	sources.sharedContext = () => groups;
	let result = buildControlDashboard(sources, {}, 5000).logicalMissions![0]!;
	assert.equal(result.title, "Latest");
	assert.equal(result.status, "done");
	assert.equal(result.tasksDone, undefined);
	assert.equal(result.tasksTotal, undefined);
	assert.equal(result.provenance.find((p) => p.bindingId === "latest")!.replicaAgeMs, 4000);
	groups.reverse();
	result = buildControlDashboard(sources, {}, 5000).logicalMissions![0]!;
	assert.equal(result.title, "Latest");
	assert.equal(result.status, "done");
	groups.push(replicaGroup("conflict", { sequence: 5, title: "Conflicting", status: "active" }));
	result = buildControlDashboard(sources, {}, 5000).logicalMissions![0]!;
	assert.equal(result.title, undefined, "equal-sequence conflict cannot invent a winning definition");
	assert.equal(result.status, undefined);
	assert.equal(result.provenance.filter((p) => p.sequence === 5).length, 2);
	groups.push(replicaGroup("resolved", { sequence: 6, title: "Resolved", status: "archived" }));
	result = buildControlDashboard(sources, {}, 5000).logicalMissions![0]!;
	assert.equal(result.title, "Resolved");
	assert.equal(result.status, "archived");
});

test("incomplete and task-only mission evidence does not invent definitions, progress or age", () => {
	const { sources } = fixture();
	sources.missions = () => [];
	const incomplete = replicaGroup("incomplete", { complete: false, title: "Untrusted partial title" });
	const taskOnly: ControlSharedMissionGroup = {
		projectId: "p",
		missionId: "task-only",
		tasksTotal: 1000,
		tasks: [
			{
				id: "proposal",
				bindingId: "legacy",
				projectId: "p",
				missionId: "task-only",
				missionHome: replicaHost,
				source: "replica",
				consistency: "provisional",
				status: "done",
				title: "Task title",
				replicaAgeMs: 0,
			},
		],
	};
	const homeTask: ControlSharedMissionGroup = {
		projectId: "p",
		missionId: "home-task",
		tasksTotal: 1,
		tasks: [
			{
				id: "grant",
				bindingId: "grant-binding",
				projectId: "p",
				missionId: "home-task",
				missionHome: localHost,
				source: "mission-home",
				consistency: "committed",
				executionHost: replicaHost,
			},
		],
	};
	sources.sharedContext = () => [incomplete, taskOnly, homeTask];
	const data = buildControlDashboard(sources);
	assert.equal(data.totals.logicalMissions, 3);
	for (const mission of data.logicalMissions!) {
		assert.equal(mission.title, undefined);
		assert.equal(mission.status, undefined);
		assert.equal(mission.tasksDone, undefined);
		assert.equal(mission.tasksTotal, undefined);
		assert.equal(mission.coordinator, undefined);
		assert.ok(mission.provenance.every((p) => p.replicaAgeMs === undefined));
	}
	assert.equal(data.logicalMissions![2]!.provenance[0]!.kind, "canonical");
	assert.deepEqual(data.logicalMissions![2]!.mission.home, localHost);
	// Old in-process consumers without a verified producer retain the legacy wire form, never a guessed home.
	sources.host = undefined;
	assert.equal(buildControlDashboard(sources).logicalMissions, undefined);
});

test("logical mission merging precedes row/provenance clipping and counts identities once", () => {
	const { sources } = fixture();
	sources.missions = () => [];
	const groups = Array.from({ length: 16 }, (_, i) => replicaGroup(`binding-${i}`, { sequence: i }));
	sources.sharedContext = () => groups;
	let data = buildControlDashboard(sources);
	assert.equal(data.truncated, false);
	assert.equal(data.logicalMissions![0]!.provenance.length, 16);
	groups.push(replicaGroup("binding-16", { sequence: 16, title: "After provenance cap" }));
	data = buildControlDashboard(sources);
	assert.equal(data.truncated, true);
	assert.equal(data.logicalMissions![0]!.provenance.length, 16);
	assert.equal(data.logicalMissions![0]!.title, "After provenance cap");
	assert.ok(
		data.logicalMissions![0]!.provenance.some((p) => p.sequence === 16),
		"winning definition evidence survives clipping",
	);
	groups.splice(
		0,
		groups.length,
		...Array.from({ length: 70 }, (_, i) => replicaGroup(`b-${i}`, { missionId: `m${i}` })),
	);
	groups.push(replicaGroup("last", { missionId: "m0", sequence: 100, title: "😀".repeat(1000) }));
	data = buildControlDashboard(sources);
	assert.equal(data.totals.logicalMissions, 70);
	assert.ok(data.logicalMissions!.length <= 50);
	assert.equal(data.logicalMissions![0]!.title, "😀".repeat(80));
	assert.equal(
		data.logicalMissions![0]!.provenance.length,
		2,
		"observations past the compatibility row cap still merge",
	);
	assert.equal(data.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 24_000);
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
			sources.host = variant ? host : undefined;
			const start = performance.now();
			buildControlDashboard(sources);
			if (i) samples[variant]!.push(performance.now() - start);
		}
	}
	const median = (values: number[]) => values.sort((a, b) => a - b)[2]!.toFixed(2);
	t.diagnostic(
		`10,000 working-chat snapshot median: legacy projection ${median(samples[0]!)} ms; logical projection ${median(samples[1]!)} ms (same cached shared inputs, synthetic appends, 5 alternating samples)`,
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
	const tool = createPilotTool(async (action, args) => (await service.call("control", action, args)) as never);
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
		const http = await response.json();
		assert.deepEqual(http, JSON.parse(JSON.stringify(await service.call("control", "status", args))));
		const result = await tool.execute("status", { action: "status", ...args }, undefined, undefined, {} as never);
		assert.deepEqual(JSON.parse(JSON.stringify(result.details)), http);
		const text = JSON.parse((result.content[0] as { text: string }).text);
		assert.deepEqual(text.logicalMissions, http.logicalMissions);
		assert.equal(text.totals.logicalMissions, http.totals.logicalMissions);
		for (const key of ["missions", "activeMissions", "replicaMissions"]) {
			assert.equal(
				text[key],
				undefined,
				"pilot status text lists logical missions only, not compatibility collections",
			);
			assert.equal(text.totals[key], undefined);
		}
		assert.ok(Buffer.byteLength(JSON.stringify(http)) <= 24_000);
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
	assert.equal((await fetch(base, { method: "POST" })).status, 409);
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
