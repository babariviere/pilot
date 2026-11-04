// biome-ignore-all lint/complexity/useLiteralKeys: Offline session lifecycle seams.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentFlow } from "@pilot/protocol";
import type { SessionManager } from "./sessions.ts";
import { fixture } from "./testing/session-workspace.ts";

const definition: AgentFlow = {
	id: "fix-review",
	name: "Fix and review",
	enabled: true,
	nodes: [
		{ id: "worker", mode: "build", prompt: "Fix and verify", edges: { done: "reviewer" } },
		{
			id: "reviewer",
			mode: "ask",
			prompt: "Review changes",
			edges: { approved: "end", changes_requested: "worker" },
		},
	],
	loop: { from: "reviewer", to: "worker", maxRounds: 2 },
};

async function drain(sessions: SessionManager) {
	for (let i = 0; i < 12; i++) {
		await Promise.all([
			...sessions["starting"].values(),
			...sessions["runFinishing"].values(),
			...sessions["flowTasks"].values(),
			...[...sessions["postRunTasks"].values()].map((t) => t.done),
		]);
		await Promise.all(sessions["saving"].values());
		if (
			!sessions["flowTasks"].size &&
			!sessions["starting"].size &&
			!sessions["runFinishing"].size &&
			!sessions["postRunTasks"].size
		)
			return;
	}
	assert.fail("flow did not settle");
}

for (const final of ["approved", "changes_requested"])
	test(`worker/reviewer loop ends on ${final}, reuses worker, and respects its limit`, async (t) => {
		const f = await fixture(t, { automationsEnabled: () => true });
		await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [], flows: [definition] });
		const request = { requestId: randomUUID(), expectedRevision: 1, flowId: definition.id, message: "Fix bug" };
		const root = await f.sessions.startFlow(f.project.id, request);
		const results = new Map<string, string>();
		t.mock.method(
			f.sessions as unknown as { flowResult(id: string): Promise<string | undefined> },
			"flowResult",
			async (id: string) => results.get(id),
		);
		await drain(f.sessions);
		assert.equal(f.sessions.get(root.id)?.workspace, "clone");
		assert.equal((await f.stored(root.id)).flow?.request.message, "Fix bug");
		assert.equal((await f.sessions.startFlow(f.project.id, request)).id, root.id);
		await assert.rejects(f.sessions.startFlow(f.project.id, { ...request, message: "different" }), /another request/);
		let completedAt = Date.now();
		const finish = async (id: string, outcome: string) => {
			results.set(id, JSON.stringify({ outcome, summary: `${outcome}: evidence` }));
			const meta = f.sessions["metas"].get(id)!;
			const worker = f.sessions["workers"].get(id)!;
			worker.state = "idle";
			meta.working = false;
			meta.outcome = "done";
			meta.outcomeAt = ++completedAt;
			await f.sessions["save"](meta, undefined, undefined, true);
			f.sessions["emit"](meta);
			await drain(f.sessions);
		};
		await finish(root.id, "done");
		const firstReviewer = f.sessions.get(root.id)!.flow!.sessionId;
		assert.notEqual(firstReviewer, root.id);
		assert.equal(f.sessions.get(firstReviewer)?.mode, "ask");
		assert.equal(f.sessions.get(firstReviewer)?.cwd, f.sessions.get(root.id)?.cwd);
		assert.equal(f.sessions.get(firstReviewer)?.flow?.rootSessionId, root.id);
		await finish(firstReviewer, "changes_requested");
		assert.equal(f.sessions.get(root.id)?.flow?.round, 2);
		assert.equal(f.sessions.get(root.id)?.flow?.sessionId, root.id);
		const workerInputs = () => f.workers[0]!.requests.filter((c) => c.type === "input");
		assert.equal(workerInputs().length, 2);
		await finish(root.id, "done");
		const secondReviewer = f.sessions.get(root.id)!.flow!.sessionId;
		assert.notEqual(secondReviewer, firstReviewer);
		await finish(secondReviewer, final);
		assert.equal(f.sessions.get(root.id)?.flow?.state, final === "approved" ? "completed" : "failed");
		assert.match(f.sessions.get(root.id)?.flow?.reason ?? "", final === "approved" ? /no merge/ : /limit/);
		assert.equal(workerInputs().length, 2);
		assert.equal((await f.stored(root.id)).flow?.visits.length, 4);
		await f.assertSourceUnchanged();
	});

test("Settings and update pauses hold advancement; questions wait; Stop cancels before admission", async (t) => {
	let enabled = true;
	const f = await fixture(t, { automationsEnabled: () => enabled });
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [], flows: [definition] });
	const request = { requestId: randomUUID(), expectedRevision: 1, flowId: definition.id, message: "Fix bug" };
	const root = await f.sessions.startFlow(f.project.id, request);
	await drain(f.sessions);
	const meta = f.sessions["metas"].get(root.id)!;
	const worker = f.sessions["workers"].get(root.id)!;
	t.mock.method(
		f.sessions as unknown as { flowResult(id: string): Promise<string> },
		"flowResult",
		async () => '{"outcome":"done","summary":"fixed"}',
	);
	worker.state = "idle";
	meta.working = false;
	meta.outcome = "question";
	meta.outcomeAt = 100;
	f.sessions["emit"](meta);
	await drain(f.sessions);
	assert.equal(f.sessions.get(root.id)?.flow?.state, "waiting");
	enabled = false;
	meta.outcome = "done";
	meta.outcomeAt = 101;
	f.sessions["emit"](meta);
	await drain(f.sessions);
	assert.equal(f.sessions.list().length, 1);
	enabled = true;
	const thaw = f.sessions.freezeAdmissions();
	f.sessions.resumeFlows();
	await drain(f.sessions);
	assert.equal(f.sessions.list().length, 1);
	thaw();
	await f.sessions.stop(root.id);
	f.sessions.resumeFlows();
	await drain(f.sessions);
	assert.equal(f.sessions.get(root.id)?.flow?.state, "cancelled");
	assert.equal(f.sessions.list().length, 1);
	assert.equal((await f.stored(root.id)).flow?.progress.state, "cancelled");
});

test("hook-only edits preserve flows and native starts reject stale/disabled configuration", async (t) => {
	let enabled = false;
	const f = await fixture(t, { automationsEnabled: () => enabled });
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [], flows: [definition] });
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 1, items: [] });
	assert.deepEqual(f.projects.get(f.project.id)?.automations?.flows, [definition]);
	const request = { requestId: randomUUID(), expectedRevision: 2, flowId: definition.id, message: "Fix bug" };
	await assert.rejects(f.sessions.startFlow(f.project.id, request), /disabled/);
	enabled = true;
	await assert.rejects(f.sessions.startFlow(f.project.id, { ...request, expectedRevision: 1 }), /changed/);
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 2,
		items: [],
		flows: [{ ...definition, enabled: false }],
	});
	await assert.rejects(f.sessions.startFlow(f.project.id, { ...request, expectedRevision: 3 }), /disabled/);
	assert.equal(f.sessions.list().length, 0);
});

test("restart and sleep/update/settings pauses recover the same reserved reviewer without replay", async (t) => {
	let enabled = true;
	const f = await fixture(t, { automationsEnabled: () => enabled });
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [], flows: [definition] });
	const request = { requestId: randomUUID(), expectedRevision: 1, flowId: definition.id, message: "Fix bug" };
	const root = await f.sessions.startFlow(f.project.id, request);
	await drain(f.sessions);
	const meta = f.sessions["metas"].get(root.id)!;
	f.sessions["workers"].get(root.id)!.state = "idle";
	meta.working = false;
	meta.outcome = "done";
	meta.outcomeAt = Date.now();
	meta.automation!.boundary!.finished = {
		triggerId: `run.finished:${meta.outcomeAt}`,
		outcome: "done",
		changedFiles: [],
		openTodos: 0,
	};
	enabled = false;
	await f.sessions["save"](meta, undefined, undefined, true);
	await f.sessions.shutdown();
	const restarted = await f.manager();
	await drain(restarted);
	assert.equal(restarted.list().length, 1);
	t.mock.method(
		restarted as unknown as { flowResult(id: string): Promise<string> },
		"flowResult",
		async () => '{"outcome":"done","summary":"fixed"}',
	);
	enabled = true;
	restarted["metas"].get(root.id)!.sleepPaused = true;
	restarted.resumeFlows();
	await drain(restarted);
	assert.equal(restarted.list().length, 1);
	delete restarted["metas"].get(root.id)!.sleepPaused;
	const thaw = restarted.freezeAdmissions();
	restarted.resumeFlows();
	await drain(restarted);
	assert.equal(restarted.list().length, 1);
	thaw();
	restarted.resumeFlows();
	await drain(restarted);
	const reviewer = restarted.get(root.id)!.flow!.sessionId;
	assert.notEqual(reviewer, root.id);
	assert.equal(restarted.list().length, 2);
	await restarted.stop(reviewer);
	assert.equal(restarted.get(root.id)?.flow?.state, "cancelled");
	assert.equal(
		(await restarted.startFlow(f.project.id, request)).id,
		root.id,
		"lost start ACK reuses the original run even after completion",
	);
	assert.equal(restarted.list().length, 2);
});

test("missing final assistant results stop instead of assuming approval", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [], flows: [definition] });
	const request = { requestId: randomUUID(), expectedRevision: 1, flowId: definition.id, message: "Fix bug" };
	const root = await f.sessions.startFlow(f.project.id, request);
	await drain(f.sessions);
	const meta = f.sessions["metas"].get(root.id)!;
	const worker = f.sessions["workers"].get(root.id)!;
	t.mock.method(f.sessions, "history", async () => ({ entries: [], more: false }));
	worker.state = "idle";
	meta.working = false;
	meta.outcome = "done";
	meta.outcomeAt = Date.now();
	f.sessions["emit"](meta);
	await drain(f.sessions);
	assert.equal(f.sessions.get(root.id)?.flow?.state, "failed");
	assert.match(f.sessions.get(root.id)?.flow?.reason ?? "", /missing/);
	assert.equal(f.sessions.list().length, 1);
	await f.assertSourceUnchanged();
});

test("restart recovers both sides of reviewer creation using the exact reserved chat and input IDs", async (t) => {
	let enabled = true;
	const f = await fixture(t, { automationsEnabled: () => enabled });
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [], flows: [definition] });
	const request = { requestId: randomUUID(), expectedRevision: 1, flowId: definition.id, message: "Fix bug" };
	const root = await f.sessions.startFlow(f.project.id, request);
	await drain(f.sessions);
	const meta = f.sessions["metas"].get(root.id)!;
	f.sessions["workers"].get(root.id)!.state = "idle";
	meta.working = false;
	meta.outcome = "done";
	meta.outcomeAt = Date.now();
	const reviewerId = randomUUID();
	meta.flow!.visits[0]!.outcome = "done";
	meta.flow!.visits[0]!.summary = "Verified changes";
	meta.flow!.visits.push({
		node: 1,
		round: 1,
		sessionId: reviewerId,
		inputId: `automation:flow:${root.id}:1:1`,
		after: -1,
		admitted: false,
	});
	Object.assign(meta.flow!.progress, { sessionId: reviewerId, nodeId: "reviewer" });
	enabled = false;
	await f.sessions["save"](meta, undefined, undefined, true);
	await f.sessions.shutdown();
	const beforeCreate = await f.manager();
	enabled = true;
	beforeCreate.resumeFlows();
	await drain(beforeCreate);
	assert.equal(beforeCreate.get(root.id)?.flow?.sessionId, reviewerId);
	assert.equal(beforeCreate.list().length, 2);
	assert.equal(beforeCreate["metas"].get(reviewerId)?.createOperationId, `automation:flow:${root.id}:1:1`);
	// The reviewer committed, but the root's acknowledgement marker did not, as after a crash/lost ACK.
	enabled = false;
	beforeCreate["metas"].get(root.id)!.flow!.visits.at(-1)!.admitted = false;
	await beforeCreate["save"](beforeCreate["metas"].get(root.id)!, undefined, undefined, true);
	await beforeCreate.shutdown();
	const afterCreate = await f.manager();
	enabled = true;
	afterCreate.resumeFlows();
	await drain(afterCreate);
	assert.equal(afterCreate.list().length, 2, "no duplicate reviewer after lost create ACK");
	assert.equal(afterCreate.get(root.id)?.flow?.sessionId, reviewerId);
	assert.equal((await f.stored(root.id)).flow?.visits.at(-1)?.admitted, true);
	const workerInputs = f.workers
		.flatMap((w) => w.requests)
		.filter((c) => c.type === "input" && c.requestId === `automation:flow:${root.id}:1:0`);
	assert.equal(workerInputs.length, 1, "root input was not replayed by flow recovery");
	const abortingWorker = afterCreate["workers"].get(reviewerId)!;
	const save = afterCreate["save"].bind(afterCreate);
	let failed = false;
	t.mock.method(afterCreate as unknown as { save: typeof save }, "save", (...args: Parameters<typeof save>) => {
		if (!failed && args[0].id === root.id && args[0].flow?.progress.state === "cancelled") {
			failed = true;
			return Promise.reject(new Error("injected durable cancellation failure"));
		}
		return save(...args);
	});
	await assert.rejects(afterCreate.stop(reviewerId), /cancellation failure/);
	assert.ok(
		f.workers.find((w) => w === abortingWorker)?.requests.some((c) => c.type === "abort"),
		"Stop still reached the live kernel",
	);
	assert.equal(afterCreate.get(root.id)?.flow?.state, "cancelled");
	afterCreate.resumeFlows();
	await drain(afterCreate);
	assert.equal(afterCreate.list().length, 2);
});

test("current-turn result reads never reuse an assistant approval before the latest input", async (t) => {
	const f = await fixture(t);
	const chat = await f.spawn();
	const approved = {
		id: "1",
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "text", text: '{"outcome":"approved","summary":"old"}' }] }],
	};
	const input = { id: "2", kind: "pi.user" };
	t.mock.method(
		f.sessions,
		"history",
		async () =>
			({ entries: [approved, input], more: true }) as unknown as Awaited<ReturnType<typeof f.sessions.history>>,
	);
	assert.equal(await f.sessions["flowResult"](chat.id), undefined);
});

test("worker completion waits for background jobs and failed post-run checks stop before review", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		flows: [definition],
		items: [
			{
				id: "check",
				name: "Regression check",
				enabled: true,
				on: ["run.finished"],
				when: { filesChanged: true },
				action: { type: "shell", run: { shell: "exit 1" }, onFailure: "report" },
			},
		],
	});
	const root = await f.sessions.startFlow(f.project.id, {
		requestId: randomUUID(),
		expectedRevision: 1,
		flowId: definition.id,
		message: "Fix bug",
	});
	await drain(f.sessions);
	const meta = f.sessions["metas"].get(root.id)!;
	const worker = f.sessions["workers"].get(root.id)!;
	await writeFile(join(meta.cwd, "tracked.txt"), "changed by worker\n");
	worker.runningJobs = [{ id: "job", name: "background", state: "running", outputPath: "/unused", startedAt: 1 }];
	worker.state = "idle";
	meta.working = false;
	meta.outcome = "done";
	meta.outcomeAt = Date.now();
	f.sessions["emit"](meta);
	await drain(f.sessions);
	assert.equal(f.sessions.list().length, 1);
	assert.equal(meta.automation?.boundary?.finished, undefined);
	worker.runningJobs = [];
	f.sessions["emit"](meta);
	await drain(f.sessions);
	assert.equal(f.sessions.list().length, 1);
	assert.equal(f.sessions.get(root.id)?.flow?.state, "failed");
	assert.equal(f.sessions.get(root.id)?.automationRuns?.at(-1)?.state, "failed");
	assert.match(f.sessions.get(root.id)?.flow?.reason ?? "", /Regression check/);
});
