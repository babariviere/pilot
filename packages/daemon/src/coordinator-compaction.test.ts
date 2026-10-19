import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import {
	COORDINATOR_COMPACT_IDLE_MS,
	COORDINATOR_COMPACT_INSTRUCTIONS,
	CoordinatorCompaction,
	coordinatorCompactionThreshold,
} from "./coordinator-compaction.ts";
import { MissionStore } from "./missions.ts";

class FakeSessions {
	readonly summaries = new Map<string, SessionSummary>();
	readonly compactions: Array<[string, string | undefined]> = [];
	private readonly listeners = new Set<(session: SessionSummary) => void>();
	sendable = true;
	failCompaction = false;

	list(): SessionSummary[] {
		return [...this.summaries.values()];
	}
	get(id: string): SessionSummary | undefined {
		return this.summaries.get(id);
	}
	onChange(listener: (session: SessionSummary) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	canSendNotice(): boolean {
		return this.sendable;
	}
	async compact(id: string, instructions?: string): Promise<void> {
		this.compactions.push([id, instructions]);
		if (this.failCompaction) throw new Error("offline");
	}
	update(id: string, change: Partial<SessionSummary>): void {
		const next = { ...this.summaries.get(id)!, ...change };
		this.summaries.set(id, next);
		for (const listener of this.listeners) listener(next);
	}
}

function lead(missionId: string, tokens: number, change: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "lead",
		title: "Lead",
		mode: "build",
		cwd: "/tmp",
		sessionPath: "/tmp",
		state: "idle",
		createdAt: 0,
		updatedAt: 0,
		missionId,
		activeMissionCoordinator: true,
		usage: { context: { tokens, contextWindow: 200_000 } },
		...change,
	};
}

function setup(t: TestContext, tokens = 90_000) {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const store = new MissionStore(":memory:");
	const mission = store.create({ projectId: "project", title: "Test" });
	store.join("lead", mission.id);
	store.update(mission.id, { coordinatorSessionId: "lead" });
	const sessions = new FakeSessions();
	sessions.summaries.set("lead", lead(mission.id, tokens));
	const compaction = new CoordinatorCompaction(store, sessions as never);
	compaction.start();
	return { store, sessions, compaction, missionId: mission.id };
}

test("the threshold is a share of the window, capped in absolute tokens", () => {
	assert.equal(coordinatorCompactionThreshold(100_000), 40_000);
	assert.equal(coordinatorCompactionThreshold(1_000_000), 100_000);
});

test("an idle coordinator above the threshold compacts once, after the cache lifetime", async (t) => {
	const { store, sessions, compaction } = setup(t);
	try {
		await compaction.compactDue(Date.now() + COORDINATOR_COMPACT_IDLE_MS - 1);
		assert.deepEqual(sessions.compactions, [], "the prompt cache may still be warm");
		await compaction.compactDue(Date.now() + COORDINATOR_COMPACT_IDLE_MS);
		assert.deepEqual(sessions.compactions, [["lead", COORDINATOR_COMPACT_INSTRUCTIONS]]);
		await compaction.compactDue(Date.now() + 2 * COORDINATOR_COMPACT_IDLE_MS);
		assert.equal(sessions.compactions.length, 1, "one compaction per idle stretch");

		// A new run settles, so its idle stretch starts at its outcome.
		t.mock.timers.setTime(Date.now() + 2 * COORDINATOR_COMPACT_IDLE_MS);
		sessions.update("lead", { state: "working" });
		sessions.update("lead", { state: "idle", outcomeAt: Date.now() });
		await compaction.compactDue(Date.now() + COORDINATOR_COMPACT_IDLE_MS - 1);
		assert.equal(sessions.compactions.length, 1, "the new run's prompt cache may still be warm");
		await compaction.compactDue(Date.now() + COORDINATOR_COMPACT_IDLE_MS);
		assert.equal(sessions.compactions.length, 2, "a new idle stretch may compact again");
	} finally {
		await compaction.stop();
		store.close();
	}
});

test("small contexts, unknown usage, other roles and busy or archived chats are left alone", async (t) => {
	const { store, sessions, compaction, missionId } = setup(t, 70_000);
	const later = () => Date.now() + COORDINATOR_COMPACT_IDLE_MS;
	try {
		await compaction.compactDue(later());
		sessions.update("lead", { usage: {} });
		await compaction.compactDue(later());
		sessions.update("lead", { usage: { context: { tokens: 90_000, contextWindow: 200_000 } } });
		sessions.sendable = false;
		await compaction.compactDue(later());
		assert.deepEqual(sessions.compactions, [], "below threshold, without usage, or not safely idle");

		sessions.sendable = true;
		sessions.update("lead", { activeMissionCoordinator: undefined });
		await compaction.compactDue(later());
		sessions.update("lead", { activeMissionCoordinator: true, archivedAt: 1 });
		await compaction.compactDue(later());
		sessions.update("lead", { archivedAt: undefined, state: "parked" });
		await compaction.compactDue(later());
		assert.deepEqual(sessions.compactions, [], "not coordinator, archived or parked");

		sessions.update("lead", { state: "idle" });
		store.addComment(missionId, { text: "question for the lead" });
		await compaction.compactDue(later());
		assert.deepEqual(sessions.compactions, [], "a pending wake-up is delivered first");
	} finally {
		await compaction.stop();
		store.close();
	}
});

test("a failed compaction is not retried in the same idle stretch", async (t) => {
	const { store, sessions, compaction } = setup(t);
	t.mock.method(console, "warn", () => {});
	try {
		sessions.failCompaction = true;
		await compaction.compactDue(Date.now() + COORDINATOR_COMPACT_IDLE_MS);
		await compaction.compactDue(Date.now() + 2 * COORDINATOR_COMPACT_IDLE_MS);
		assert.equal(sessions.compactions.length, 1);
	} finally {
		await compaction.stop();
		store.close();
	}
});

test("compaction's own working state does not start a new idle stretch, so a failed one is not retried", async (t) => {
	const { store, sessions, compaction } = setup(t);
	sessions.update("lead", { outcomeAt: Date.now() });
	const later = Date.now() + COORDINATOR_COMPACT_IDLE_MS;
	try {
		await compaction.compactDue(later);
		assert.equal(sessions.compactions.length, 1);
		// pilotd shows a background compaction as work, without an outcome, then idle again with the same outcome.
		// A failed compaction leaves the context as large as before.
		for (let attempt = 0; attempt < 3; attempt++) {
			sessions.update("lead", { state: "working", outcomeAt: undefined });
			sessions.update("lead", { state: "idle", outcomeAt: Date.now() });
			await compaction.compactDue(later + attempt);
		}
		assert.equal(sessions.compactions.length, 1, "no retry until another run settles");

		// Losing the coordinator role forgets the attempt.
		sessions.update("lead", { activeMissionCoordinator: undefined });
		sessions.update("lead", { activeMissionCoordinator: true });
		await compaction.compactDue(later);
		assert.equal(sessions.compactions.length, 2);
	} finally {
		await compaction.stop();
		store.close();
	}
});

test("the idle timer compacts without polling once the deadline passes", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
	const store = new MissionStore(":memory:");
	const mission = store.create({ projectId: "project", title: "Test" });
	store.join("lead", mission.id);
	store.update(mission.id, { coordinatorSessionId: "lead" });
	const sessions = new FakeSessions();
	sessions.summaries.set("lead", lead(mission.id, 90_000));
	const compaction = new CoordinatorCompaction(store, sessions as never);
	try {
		compaction.start();
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		t.mock.timers.tick(COORDINATOR_COMPACT_IDLE_MS - 1);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		assert.equal(sessions.compactions.length, 0);
		t.mock.timers.tick(1);
		for (let index = 0; index < 5; index++) await new Promise<void>((resolve) => queueMicrotask(resolve));
		assert.equal(sessions.compactions.length, 1);
	} finally {
		await compaction.stop();
		store.close();
	}
});
