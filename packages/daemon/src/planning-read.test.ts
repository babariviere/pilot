/** The planner's read lists settled questions as one short entry each; the saved map keeps them in full. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactView } from "./planning-workers.ts";
import { publishedPlanningFixture as fixture } from "./published-planning.fixture.ts";

test("the planner reads open questions in full and settled ones under settled", async (t) => {
	const f = await fixture(t, { published: false });
	const saved = f.store.plans.get(f.missionId)!;
	const q = {
		id: "done",
		title: "Done",
		question: "Long text",
		kind: "human" as const,
		options: [],
		recommendedOptionId: null,
		dependsOn: [],
		sources: [],
		claimedBy: null,
		resolution: null,
	};
	const settled = { ...q, resolution: { kind: "interview" as const, id: "i", digest: "d" } };
	const reply = await f.workers.call(f.binding, { action: "read" });
	assert.ok("settled" in (reply.value as object), "the planner's read is compact");
	const value = compactView({ plan: { ...saved, questions: [settled, { ...q, id: "open" }] } }) as unknown as {
		plan: { questions: { id: string }[] };
		settled: unknown[];
	};
	assert.deepEqual(
		value.plan.questions.map((x) => x.id),
		["open"],
	);
	assert.deepEqual(value.settled, [
		{ id: q.id, title: q.title, kind: q.kind, dependsOn: q.dependsOn, resolution: settled.resolution },
	]);
});
