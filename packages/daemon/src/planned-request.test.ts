import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import type { TrackedItem, TrackedItemPatch } from "@pilot/protocol";
import { planningWorkerFixture } from "./planning-workers.fixture.ts";
import { publishedPlanningFixture } from "./published-planning.fixture.ts";

/** One request in New, with the claim and link rules Start work uses. Records every change. */
function fakeTracking(projectId: string) {
	const item = {
		id: "issue-1",
		projectId,
		kind: "linear",
		externalId: "uuid-1",
		title: "ENG-12 Export chats",
		url: "https://linear.app/acme/issue/ENG-12/export-chats",
		status: "Todo",
		revision: 3,
		triageState: "new",
		metadata: {},
		dismissed: false,
		createdAt: 1,
		updatedAt: 1,
	} as TrackedItem;
	const patches: TrackedItemPatch[] = [];
	const tracking = {
		items: {
			require: async (id: string) => {
				if (id !== item.id) throw new Error("Tracked item not found");
				return structuredClone(item);
			},
			intakeWrite: async (_p: string, _id: string, revision: number, _s: unknown, operationId?: string) => {
				if (revision !== item.revision || item.startOperationId)
					throw new Error("Intake changed; refresh before acting");
				item.startOperationId = operationId!;
				return structuredClone(item);
			},
		},
		patch: async (_id: string, patch: TrackedItemPatch) => {
			patches.push(patch);
			if (patch.missionId) {
				item.missionId = patch.missionId;
				item.missionIds = [...(item.missionIds ?? []), patch.missionId];
			}
			if (patch.sessionId) {
				item.sessionId = patch.sessionId;
				item.sessionIds = [...(item.sessionIds ?? []), patch.sessionId];
			}
			return structuredClone(item);
		},
		onChange: () => () => {},
	};
	return { item, patches, tracking };
}

async function planned(t: TestContext) {
	const f = await planningWorkerFixture(t, { tracking: fakeTracking });
	const fake = f.tracking as ReturnType<typeof fakeTracking>;
	const plan = (request: unknown) => {
		const payload = { ...JSON.parse(f.enrollment.payload), ownerSessionId: randomUUID(), request };
		return f.operation(randomUUID(), payload, payload.configurationDigest);
	};
	return { f, fake, plan };
}

test("a mission planned from a request takes it out of New and links it, changing nothing in Linear", {
	timeout: 60000,
}, async (t) => {
	const { f, fake, plan } = await planned(t);
	const enrolled = await f.post(plan({ itemId: fake.item.id, revision: fake.item.revision }));
	assert.equal(enrolled.state, "accepted", JSON.stringify(enrolled) + f.logs());
	const missionId = enrolled.result.missionId as string;
	assert.equal(fake.item.missionId, missionId, "the request leaves New and points at its mission");
	assert.ok(fake.item.startOperationId, "the claim stops a second Start work");
	assert.deepEqual(fake.patches, [{ missionId }], "no start: Linear is not changed yet");
	const link = f.store.detail(missionId).resources.find((r) => r.url === fake.item.url);
	assert.equal(link?.relationship, "reference", "the mission links the issue as a reference");
	assert.notEqual(link?.linearRole, "managed");
	assert.deepEqual(f.store.planningWorkers.get(missionId)?.request, {
		itemId: fake.item.id,
		revision: fake.item.revision,
	});
});

test("planning from a request that changed or started is refused with nothing created", {
	timeout: 60000,
}, async (t) => {
	const { f, fake, plan } = await planned(t);
	const before = f.store.list(f.project.id).length;
	const stale = await f.post(plan({ itemId: fake.item.id, revision: fake.item.revision - 1 }));
	assert.equal(stale.state, "rejected");
	assert.match(stale.reason, /changed or already started/);
	fake.item.missionId = "other";
	const taken = await f.post(plan({ itemId: fake.item.id, revision: fake.item.revision }));
	assert.equal(taken.state, "rejected");
	const bad = await f.post(plan({ itemId: fake.item.id }));
	assert.equal(bad.state, "rejected");
	assert.equal(f.store.list(f.project.id).length, before);
	assert.deepEqual(fake.patches, []);
	assert.equal(f.specs.length, 0);
});

test("the first task started marks the request started once", async (t) => {
	const f = await publishedPlanningFixture(t, { twoSlices: true, tracking: fakeTracking });
	const fake = f.tracking as ReturnType<typeof fakeTracking>;
	const state = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, state.revision, (s) => {
		s.request = { itemId: fake.item.id, revision: fake.item.revision };
	});
	fake.item.missionIds = [f.missionId];
	const [first, second] = f.store.plans
		.get(f.missionId)!
		.publication!.tasks.map((p) => f.store.task(f.missionId, p.taskId));
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0, permission: { level: "build" } }));
	t.mock.method(f.sessions, "lookupPublishedTask", async () => false);
	t.mock.method(
		f.sessions,
		"admitPublishedTask",
		async (
			_r: unknown,
			identity: { sessionId: string; operationId: string; taskId: string },
			guard: (c: boolean) => void,
		) => {
			guard(false);
			f.store.join(identity.sessionId, f.missionId);
			f.store.claimTask(f.missionId, identity.taskId, identity.sessionId);
			guard(true);
			return { admissionId: identity.operationId, sessionId: identity.sessionId };
		},
	);
	f.store.join("worker-1", f.missionId);
	f.store.claimTask(f.missionId, first!.id, "worker-1");
	const now = f.store.planningWorkers.get(f.missionId)!;
	f.store.planningWorkers.change(f.missionId, now.revision, (s) => {
		s.start = { operation: f.submit, sessionId: "worker-1", taskId: first!.id, admitted: true };
	});
	f.store.updateTask(f.missionId, first!.id, { status: "done" });
	f.workers.startResearch();
	await f.workers.settleResearch();
	assert.equal(f.store.task(f.missionId, second!.id).status, "in_progress");
	const started = fake.patches.filter((p) => p.start);
	assert.equal(started.length, 1);
	assert.equal(started[0]!.sessionId, f.store.task(f.missionId, second!.id).sessionId);
});
