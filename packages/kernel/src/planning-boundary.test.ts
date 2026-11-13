import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { admitWithHeld, holdOnStop } from "./held-inputs.ts";
import { HeldInputsDoc } from "./held-inputs-doc.ts";
import { admitPlanningInput, holdPlanning, PlanningWorkerDoc } from "./planning-boundary.ts";
import {
	PLANNING_PROFILE,
	type PlanningInput,
	type PlanningRound,
	type PlanningWorkerBinding,
	planningJSON,
} from "./planning-worker.ts";

async function fixture(t: TestContext) {
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
	t.after(() => harness.close(context));
	t.mock.method(harness, "resume", () => {});
	const conversation = await harness.root(context);
	const binding: PlanningWorkerBinding = {
		version: 1,
		profile: PLANNING_PROFILE,
		home: "/fixture",
		host: { hostId: "daemon", daemonId: "daemon", lineageId: "lineage" },
		projectId: "project",
		missionId: "mission",
		enrollmentId: "enrollment",
		ownerSessionId: "owner",
		creationOperationId: "create",
	};
	const hold: PlanningRound = {
		operationId: "round",
		contextDigest: "context",
		fence: {
			missionId: "mission",
			ownerSessionId: "owner",
			enrollmentId: "enrollment",
			questionSetRevision: 2,
			answerRevision: 0,
		},
		revision: 2,
	};
	const input: PlanningInput = {
		binding,
		hold,
		operation: {
			schemaVersion: 1,
			operationId: "continue",
			producerId: "enrollment",
			sequence: 1,
			origin: binding.host,
			destination: binding.host,
			targetId: "mission",
			kind: "interview-continue",
			payload: "exact",
			payloadHash: "hash",
		},
		content: "Only exact submitted answers, not build approval",
	};
	await holdPlanning(conversation, binding, hold, context);
	return { storage, harness, conversation, binding, hold, input };
}

test("Revisit never releases a planning hold even without an exposed round", async (t) => {
	const f = await fixture(t);
	await f.conversation.commit(async (tx) => {
		(await tx.doc(PlanningWorkerDoc, f.conversation.id)).hold = null;
	}, context);
	const input = {
		...f.input,
		hold: null,
		operation: { ...f.input.operation, operationId: "revisit", kind: "plan-revisit" },
	};
	await assert.rejects(
		admitPlanningInput(f.harness, f.conversation, input, async () => {}, context),
		/held or busy/,
	);
	assert.equal((await f.harness.snapshot(HeldInputsDoc, f.conversation.id, context))?.planning, true);
	assert.deepEqual((await f.harness.snapshot(PlanningWorkerDoc, f.conversation.id, context))?.receipts, {});
});

test("unheld Revisit admits one exact planning input, without granting or releasing Stop", async (t) => {
	const f = await fixture(t);
	await f.conversation.commit(async (tx) => {
		(await tx.doc(PlanningWorkerDoc, f.conversation.id)).hold = null;
		(await tx.doc(HeldInputsDoc, f.conversation.id)).planning = false;
	}, context);
	const input = {
		...f.input,
		hold: null,
		operation: { ...f.input.operation, operationId: "revisit", kind: "plan-revisit" },
	};
	await admitPlanningInput(f.harness, f.conversation, input, async () => {}, context);
	await admitPlanningInput(
		f.harness,
		f.conversation,
		input,
		async () => {
			throw new Error("Must not reenter");
		},
		context,
	);
	assert.deepEqual(Object.keys((await f.harness.snapshot(PlanningWorkerDoc, f.conversation.id, context))!.receipts), [
		"revisit",
	]);
	assert.equal((await f.harness.snapshot(HeldInputsDoc, f.conversation.id, context))?.stopped, false);
});

test("planning hold is durable and independent from Stop and ordinary input", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.harness.snapshot(PlanningWorkerDoc, f.conversation.id, context))?.hold, planningJSON(f.hold));
	await assert.rejects(
		admitWithHeld(
			f.harness,
			f.conversation.id,
			{ requestId: "user", content: "resume", mode: "followUp" },
			context,
			false,
			true,
		),
		/exact planning continuation/,
	);
	await holdOnStop(f.harness, f.conversation.id, (id) => f.storage.submission(id, context), context);
	assert.equal((await f.harness.snapshot(HeldInputsDoc, f.conversation.id, context))?.planning, true);
	await assert.rejects(
		admitPlanningInput(f.harness, f.conversation, f.input, async () => {}, context),
		/held or busy/,
	);
	assert.equal((await f.harness.snapshot(PlanningWorkerDoc, f.conversation.id, context))?.hold, planningJSON(f.hold));
});

test("exact planning continuation clears only its own hold and dedupes atomically", async (t) => {
	const f = await fixture(t);
	let guards = 0;
	await admitPlanningInput(
		f.harness,
		f.conversation,
		f.input,
		async () => {
			guards++;
		},
		context,
	);
	assert.equal(guards, 1);
	assert.equal((await f.harness.snapshot(PlanningWorkerDoc, f.conversation.id, context))?.hold, null);
	assert.equal((await f.harness.snapshot(HeldInputsDoc, f.conversation.id, context))?.planning, false);
	assert.equal((await f.harness.snapshot(LiveDoc, f.conversation.id, context))?.run?.inputs.length, 1);
	await admitPlanningInput(
		f.harness,
		f.conversation,
		f.input,
		async () => {
			assert.fail("No new admission guard on exact receipt");
		},
		context,
	);
	await assert.rejects(
		admitPlanningInput(f.harness, f.conversation, { ...f.input, content: "changed" }, async () => {}, context),
		/identity changed/,
	);
	assert.equal(
		(await f.conversation.entries({}, 100, undefined, context)).items.filter((e) => e.kind === "pilot.planning-input")
			.length,
		1,
	);
});

test("changed round and final asynchronous admission denial roll back every native effect", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		admitPlanningInput(
			f.harness,
			f.conversation,
			{ ...f.input, hold: { ...f.hold, revision: 3 } },
			async () => {},
			context,
		),
		/Exact planning hold/,
	);
	await assert.rejects(
		admitPlanningInput(
			f.harness,
			f.conversation,
			f.input,
			async () => {
				throw new Error("Owner changed after preparation");
			},
			context,
		),
		/Owner changed/,
	);
	assert.equal(await f.storage.submissionByRequest(f.conversation.id, "continue", context), undefined);
	assert.equal((await f.harness.snapshot(PlanningWorkerDoc, f.conversation.id, context))?.hold, planningJSON(f.hold));
	assert.equal((await f.harness.snapshot(LiveDoc, f.conversation.id, context))?.run, undefined);
});
