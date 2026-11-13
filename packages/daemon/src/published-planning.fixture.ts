/** Canonical SQLite/journal and trusted admission, with every worker/provider effect replaced. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { PLANNING_PROFILE, type PlanningInput } from "@pilot/kernel";
import { interviewDigest } from "./mission-interview-contract.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";
import { NativeMissionPlanning } from "./native-mission-planning.ts";
import { PlanningWorkers } from "./planning-workers.ts";

export async function publishedPlanningFixture(t: TestContext, options = { native: false }) {
	const f = await nativePlanningFixture(options);
	t.after(() => f.close());
	await f.closePlanning();
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 0,
		destination: "Importer",
		sources: [],
		questions: [],
		fog: [],
	} as { purpose: string });
	await f.plan({
		purpose: "plan-propose",
		expectedRevision: 1,
		spec: {
			problem: "Import",
			solution: "Read exact bytes",
			stories: [{ id: "one", text: "Read" }],
			implementation: ["Keep parser"],
			testing: ["Corrupt archive"],
			exclusions: ["No deployment"],
		},
		slices: [
			{
				id: "one",
				title: "Importer",
				outcome: "Read archive",
				acceptance: ["Exact bytes"],
				storyIds: ["one"],
				dependsOn: [],
				owners: ["sol-backend"],
			},
		],
	} as { purpose: string });
	await f.plan({ purpose: "plan-review", expectedRevision: 2 } as { purpose: string });
	const iv = f.store.interviews.latest(f.missionId)!;
	const { MissionInterviews } = await import("./mission-interviews.ts");
	const interviews = new MissionInterviews({
		store: f.store,
		journal: f.journal,
		confirmations: f.confirmations(),
		authorize: () => "fixture",
	});
	const save = f.operation(f.missionId, {
		purpose: "interview-save",
		expected: { fence: iv.fence, revision: iv.revision },
		answers: iv.questions.map((q) => ({
			questionId: q.id,
			questionDigest: interviewDigest(q),
			selectedOption: q.options.find((o) => o.id === "approve")!,
			text: "",
		})),
	} as { purpose: string });
	assert.equal((await f.journal.execute(save, (o, e) => interviews.admit(o, e.firstEntry))).state, "accepted");
	const latest = f.store.interviews.latest(f.missionId)!;
	const submit = f.operation(f.missionId, {
		purpose: "interview-submit",
		expected: { fence: latest.fence, revision: latest.revision },
	} as { purpose: string });
	assert.equal((await f.journal.execute(submit, (o, e) => interviews.admit(o, e.firstEntry))).state, "accepted");
	await f.plan({ purpose: "plan-publish", expectedRevision: 3 });
	const binding = {
		version: 1 as const,
		profile: PLANNING_PROFILE,
		home: f.home,
		host: f.journal.destination,
		projectId: f.project.id,
		missionId: f.missionId,
		ownerSessionId: f.owner,
		enrollmentId: latest.fence.enrollmentId,
		creationOperationId: "fixture-create",
	};
	f.store.planningWorkers.create(() => ({
		version: 1,
		binding,
		creation: submit,
		goal: "Import",
		configurationDigest: "fixture",
		revision: 1,
		phase: "active",
		hold: null,
		pendingHold: null,
		continuation: null,
	}));
	t.mock.method(f.sessions, "assertPlanningOpen", () => {});
	t.mock.method(f.sessions, "planningIdentity", () => ({ inputGeneration: 0, permission: { level: "investigate" } }));
	t.mock.method(f.sessions, "selectTaskModel", async () => ({ model: "fake/no-send", thinking: "off" }));
	const inputs: PlanningInput[] = [];
	const receipts = new Set<string>();
	const admission = t.mock.method(f.sessions, "admitPlanning", async (input: PlanningInput, guard: () => void) => {
		guard();
		inputs.push(input);
		receipts.add(input.operation.operationId);
		return { admissionId: input.operation.operationId };
	});
	const lookup = t.mock.method(f.sessions, "lookupPlanning", async (input: PlanningInput) =>
		receipts.has(input.operation.operationId) ? { admissionId: input.operation.operationId } : undefined,
	);
	const workers = new PlanningWorkers({
		home: f.home,
		store: f.store,
		journal: f.journal,
		projects: f.projects,
		sessions: f.sessions,
		confirmations: f.confirmations(),
	});
	t.after(() => workers.close());
	const native = new NativeMissionPlanning({
		store: f.store,
		journal: f.journal,
		projects: f.projects,
		sessions: f.sessions,
		confirmations: f.confirmations(),
		workers,
	});
	const revisit = async () => {
		const read = await native.read(f.project.id, f.missionId);
		assert.equal(read.revisit?.available, true, JSON.stringify(read.revisit));
		return f.operation(
			f.missionId,
			{ purpose: "plan-revisit", source: read.revisit!.source } as { purpose: string },
			read.revisit!.contextDigest,
		);
	};
	const execute = (op: ReturnType<typeof f.operation>) =>
		f.journal.execute(op, (o, e) => native.admit(o, e.firstEntry));
	return Object.assign(f, { native, workers, binding, inputs, admission, lookup, revisit, execute, submit, receipts });
}
