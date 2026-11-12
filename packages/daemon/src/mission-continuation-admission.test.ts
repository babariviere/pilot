import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	type AllowedContinuationPolicy,
	type ContinuationHost,
	type ContinuationPolicySource,
	type MissionContinuation,
	MissionContinuations,
} from "./mission-continuation.ts";
import { MissionStore } from "./missions.ts";

function fakePolicy(record: Readonly<MissionContinuation>): AllowedContinuationPolicy {
	return {
		version: 1,
		state: "allowed",
		dispatch: { authorizationId: "fake-dispatch", revision: 1 },
		model: {
			sourceId: "fake-model",
			revision: "1",
			model: record.request.model ?? "fake/model",
			thinking: record.request.thinking ?? "medium",
		},
		budget: { authorityId: "fake-budget", revision: 1 },
	};
}

function fixture(t: TestContext, store = new MissionStore(":memory:"), missionId?: string, bindPolicy = true) {
	const id =
		missionId ??
		store.create({
			projectId: "project",
			title: "Test",
			tasks: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
		}).id;
	if (!missionId) {
		store.join("lead", id);
		store.update(id, { coordinatorSessionId: "lead" });
	}
	let occupied = 0,
		fence = "authorized";
	const starts: MissionContinuation[] = [];
	const receipts = new Set<string>();
	const host: ContinuationHost = {
		assertTaskHolds: () => {},
		fence: () => fence,
		occupied: () => occupied,
		start: async (record, guard) => {
			guard();
			starts.push(record);
			store.join(record.targetId, id);
			store.claimStartTasks(id, record.taskIds, record.targetId);
			guard();
			receipts.add(record.operationId);
		},
		lookup: async (r) => receipts.has(r.operationId),
	};
	const runner = new MissionContinuations(store, host);
	const policy: ContinuationPolicySource = { current: fakePolicy, onChange: () => () => {} };
	if (bindPolicy) runner.setPolicySource(policy);
	t.after(async () => {
		await runner.stop();
		store.close();
	});
	return {
		store,
		id,
		runner,
		host,
		policy,
		starts,
		receipts,
		slots: (n: number) => {
			occupied = n;
			runner.schedule();
		},
		fence: (value: string) => {
			fence = value;
			runner.schedule();
		},
		enqueue: (task = "1", op = `start-${task}`) => runner.enqueue(id, "lead", op, [task], { model: "fake/model" }),
	};
}

test("idle reconciliation admits only explicitly requested work, deduplicates notifications and keeps completion separate", async (t) => {
	const f = fixture(t);
	f.runner.start();
	await f.runner.flush();
	assert.equal(f.starts.length, 0, "todo is not execution authority");
	const first = await f.enqueue();
	await f.runner.flush();
	assert.equal(f.store.controls.continuation(first.operationId)?.state, "started");
	assert.equal(f.store.resolveTask(f.id, "1").status, "in_progress");
	assert.equal(f.store.resolveTask(f.id, "2").status, "todo");
	for (let i = 0; i < 10; i++) f.runner.schedule();
	await f.runner.flush();
	const retry = await f.enqueue();
	assert.equal(retry.targetId, first.targetId);
	assert.equal(f.starts.length, 1);
	await assert.rejects(f.runner.enqueue(f.id, "lead", first.operationId, ["2"], {}), /identity reused/);
});

test("two occupied slots wait durably, then one release admits one slice in canonical order", async (t) => {
	const f = fixture(t);
	f.slots(2);
	await f.enqueue("2");
	await f.enqueue("1");
	f.runner.start();
	await f.runner.flush();
	assert.equal(f.starts.length, 0);
	assert.match(f.store.controls.continuation("start-1")!.reason, /worker slot/);
	const original = f.host.start;
	f.host.start = async (r, g) => {
		await original(r, g);
		f.slots(2);
	};
	f.slots(1);
	await f.runner.flush();
	assert.deepEqual(
		f.starts.map((r) => r.taskIds),
		[[f.store.resolveTask(f.id, "1").id]],
	);
	assert.equal(f.store.controls.continuation("start-2")!.state, "waiting");
});

test("partial delivery does not clear dependencies; canonical completion resumes the queued slice", async (t) => {
	const f = fixture(t);
	const first = f.store.resolveTask(f.id, "1");
	f.store.updateTask(f.id, "2", { dependsOn: [first.id] });
	await f.enqueue("2");
	f.runner.start();
	await f.runner.flush();
	assert.match(f.store.controls.continuation("start-2")!.reason, /depends on/);
	f.store.join("worker", f.id);
	f.store.claimTask(f.id, "1", "worker");
	f.store.recordMemberCompletion({
		id: "worker",
		missionId: f.id,
		title: "Published increment",
		state: "idle",
		outcome: "done",
		outcomeAt: Date.now(),
		createdAt: 0,
	} as never);
	await f.runner.flush();
	assert.equal(f.starts.length, 0);
	assert.equal(f.store.task(f.id, first.id).status, "in_progress");
	f.store.updateTask(f.id, first.id, { status: "done" }, { sessionId: "lead" });
	await f.runner.flush();
	assert.equal(f.starts.length, 1);
});

for (const change of ["scope", "owner", "coordinator", "stop", "authority", "blocked", "archive"] as const) {
	test(`${change} after selection prevents dispatch without reviving stopped work`, async (t) => {
		const f = fixture(t);
		await f.enqueue();
		if (change === "scope") f.store.updateTask(f.id, "1", { body: "Changed scope" });
		if (change === "owner") {
			f.store.join("other", f.id);
			f.store.claimTask(f.id, "1", "other");
		}
		if (change === "coordinator") {
			f.store.join("other", f.id);
			f.store.update(f.id, { coordinatorSessionId: "other" });
		}
		if (change === "stop") f.store.controls.stop(f.id);
		if (change === "authority") f.fence("revoked");
		if (change === "blocked") f.store.updateTask(f.id, "1", { status: "blocked" });
		if (change === "archive") f.store.update(f.id, { status: "archived" });
		f.runner.start();
		await f.runner.flush();
		assert.equal(f.starts.length, 0);
		assert.notEqual(f.store.controls.continuation("start-1")!.reason, "Awaiting fresh reconciliation");
	});
}

test("Stop between fresh selection and actual host dispatch vetoes the start; Unknown is never replayed", async (t) => {
	const f = fixture(t);
	await f.enqueue();
	let attempts = 0;
	f.host.start = async (_r, guard) => {
		attempts++;
		f.store.controls.stop(f.id);
		guard();
	};
	f.runner.start();
	await f.runner.flush();
	assert.equal(attempts, 1);
	assert.equal(f.store.controls.continuation("start-1")!.state, "unknown");
	for (let i = 0; i < 4; i++) {
		f.runner.schedule();
		await f.runner.flush();
	}
	await f.enqueue();
	assert.equal(attempts, 1);
});

test("user-pinned priorities cannot be reordered or skipped around a blocked earlier slice", async (t) => {
	const f = fixture(t);
	f.store.updateTask(f.id, "2", { order: -1 });
	assert.equal(f.store.controls.orderPinned(f.id), true);
	assert.throws(() => f.store.updateTask(f.id, "1", { order: -2 }, { sessionId: "lead" }), /pinned/);
	await f.enqueue("1");
	f.runner.start();
	await f.runner.flush();
	assert.equal(f.starts.length, 0);
	assert.match(f.store.controls.continuation("start-1")!.reason, /user-pinned/);
	f.store.updateTask(f.id, "2", { status: "done" }, { sessionId: "lead" });
	await f.runner.flush();
	assert.equal(f.starts.length, 1);
});

for (const change of ["slots", "revocation", "pause"] as const) {
	test(`${change} between selection and dispatch is synchronously fenced`, async (t) => {
		const f = fixture(t);
		await f.enqueue();
		f.host.start = async (_record, guard) => {
			if (change === "slots") f.slots(2);
			if (change === "revocation") f.fence("revoked");
			if (change === "pause") {
				const control = f.store.controls.current(f.id);
				f.store.controls.write(
					{
						version: 1,
						missionId: f.id,
						ownerFence: "test",
						state: "entered",
						members: [],
						command: {
							version: 1,
							action: "pause",
							operationId: "pause",
							projectId: "project",
							coordinatorSessionId: "lead",
							expectedRevision: control.revision,
							home: { daemonId: "test", lineageId: "test" },
						},
						control: {
							...control,
							revision: control.revision + 1,
							pauseGeneration: control.pauseGeneration + 1,
							held: true,
							state: "pausing",
						},
					},
					control.revision,
				);
			}
			guard();
			assert.fail("dispatch must be fenced");
		};
		f.runner.start();
		await f.runner.flush();
		assert.equal(f.starts.length, 0);
		assert.equal(f.store.controls.continuation("start-1")!.state, "unknown");
		await assert.rejects(f.enqueue("1", "replacement-id"), /uncertain start|held/);
	});
}

test("maintenance freeze keeps a durable wait and release is event-driven", async (t) => {
	const f = fixture(t);
	await f.enqueue();
	const release = f.runner.runtime.freezeAdmissions();
	f.runner.start();
	await f.runner.flush();
	assert.equal(f.starts.length, 0);
	assert.equal(f.store.controls.continuation("start-1")!.state, "waiting");
	release();
	await f.runner.flush();
	assert.equal(f.starts.length, 1);
});

test("crash/reopen restores waiting intents; entered starts reconcile by exact lookup only", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "continuation-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = join(home, "missions.sqlite");
	const store = new MissionStore(path);
	const id = store.create({ projectId: "project", title: "Test", tasks: [{ title: "One" }, { title: "Two" }] }).id;
	store.join("lead", id);
	store.update(id, { coordinatorSessionId: "lead" });
	const host: ContinuationHost = {
		assertTaskHolds: () => {},
		fence: () => "authorized",
		occupied: () => 2,
		start: async () => {
			throw new Error("must not start");
		},
		lookup: async () => false,
	};
	const first = new MissionContinuations(store, host);
	const queued = await first.enqueue(id, "lead", "waiting", ["1"], {});
	const entered = await first.enqueue(id, "lead", "entered", ["2"], {});
	store.controls.saveContinuation({ ...entered, state: "entered" });
	await store.durable();
	await first.stop();
	store.close();
	const reopened = new MissionStore(path);
	t.after(() => reopened.close());
	let starts = 0,
		lookups = 0;
	const runner = new MissionContinuations(reopened, {
		assertTaskHolds: () => {},
		fence: () => "authorized",
		occupied: () => 0,
		start: async (r, guard) => {
			guard();
			starts++;
			assert.equal(r.targetId, queued.targetId);
		},
		lookup: async (r) => {
			lookups++;
			assert.equal(r.targetId, entered.targetId);
			return false;
		},
	});
	runner.setPolicySource({ current: fakePolicy, onChange: () => () => {} });
	t.after(() => runner.stop());
	runner.start();
	await runner.flush();
	assert.equal(starts, 1);
	assert.equal(lookups, 1);
	assert.equal(reopened.controls.continuation("entered")!.state, "unknown");
	await runner.enqueue(id, "lead", "entered", ["2"], {});
	await runner.flush();
	assert.equal(starts, 1);
});

test("missing qualified current policy persists an explicit wait, never a permissive default", async (t) => {
	const f = fixture(t, undefined, undefined, false);
	await f.enqueue();
	f.runner.start();
	await f.runner.flush();
	assert.equal(f.starts.length, 0);
	assert.match(
		f.store.controls.continuation("start-1")!.reason,
		/no qualified current dispatch\/model\/budget source/,
	);
});

test("lost dispatch ACK stays Unknown until original-operation lookup finds exact admission", async (t) => {
	const f = fixture(t);
	let attempts = 0;
	f.host.start = async (record, guard) => {
		guard();
		attempts++;
		f.receipts.add(record.operationId);
		throw new Error("Lost ACK after exact admission");
	};
	const original = await f.enqueue();
	f.runner.start();
	await f.runner.flush();
	assert.equal(f.store.controls.continuation(original.operationId)!.state, "unknown");
	assert.equal((await f.enqueue()).targetId, original.targetId);
	assert.equal(attempts, 1);
	await f.runner.flush();
	assert.equal(f.store.controls.continuation(original.operationId)!.state, "started");
	assert.equal(attempts, 1, "exact lookup never re-enters dispatch");
});

test("saved initial input rechecks dependencies, capacity and current budget at actual dispatch", async (t) => {
	const f = fixture(t);
	const first = f.store.resolveTask(f.id, "1");
	f.store.updateTask(f.id, "2", { dependsOn: [first.id] });
	f.store.updateTask(f.id, "1", { status: "done" });
	const record = await f.enqueue("2");
	f.runner.start();
	await f.runner.flush();
	assert.equal(f.runner.inputAllowed(record.targetId, record.operationId), true);
	f.store.updateTask(f.id, "1", { status: "todo" });
	assert.equal(f.runner.inputAllowed(record.targetId, record.operationId), false);
	assert.match(f.store.controls.continuation(record.operationId)!.reason, /unfinished work/);
	f.store.updateTask(f.id, "1", { status: "done" });
	f.slots(2);
	assert.equal(f.runner.inputAllowed(record.targetId, record.operationId), false);
	f.slots(0);
	f.policy.current = () => ({ version: 1, state: "unavailable", gate: "budget", reason: "Budget is unknown" });
	assert.equal(f.runner.inputAllowed(record.targetId, record.operationId), false);
	assert.match(f.store.controls.continuation(record.operationId)!.reason, /budget policy unavailable/);
});

test("budget policy events clear a real blocker; same-state replacement before dispatch is fenced", async (t) => {
	const f = fixture(t, undefined, undefined, false);
	let changed = () => {};
	let available = false,
		revision = 1;
	f.runner.setPolicySource({
		current: (record) =>
			available
				? { ...fakePolicy(record), budget: { authorityId: "fake-budget", revision } }
				: { version: 1, state: "unavailable", gate: "budget", reason: "Exact budget authority unavailable" },
		onChange: (listener) => {
			changed = listener;
			return () => {};
		},
	});
	await f.enqueue();
	f.runner.start();
	await f.runner.flush();
	assert.equal(f.starts.length, 0);
	assert.match(f.store.controls.continuation("start-1")!.reason, /budget policy unavailable/);
	f.host.start = async (_record, guard) => {
		revision++;
		guard();
		assert.fail("stale authority cannot dispatch");
	};
	available = true;
	changed();
	await f.runner.flush();
	assert.equal(f.starts.length, 0);
	assert.equal(f.store.controls.continuation("start-1")!.state, "unknown");
});
