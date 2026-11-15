import assert from "node:assert/strict";
import { test } from "node:test";
import type { MissionInterview, MissionPlan } from "@pilot/protocol";
import { planMap } from "./mission-plan-map.ts";

const submitted = (set: number, operationId: string) =>
	({
		submission: { operationId, digest: `d-${operationId}`, fence: { questionSetRevision: set } },
	}) as unknown as MissionInterview;

test("an interview label counts answered rounds, not question sets with an empty bootstrap", () => {
	const plan = {
		questions: [
			{
				id: "safety",
				title: "Safety",
				question: "Which?",
				kind: "human",
				options: [],
				recommendedOptionId: null,
				dependsOn: [],
				sources: [],
				claimedBy: null,
				resolution: { kind: "interview", id: "op-3", digest: "d-op-3" },
			},
		],
		fog: [],
		round: null,
	} as unknown as MissionPlan;
	const map = planMap({
		plan,
		destination: "",
		decisions: [],
		knowledge: [],
		// Set 1 was the enrollment's empty bootstrap: the user answered sets 2 and 3.
		history: [{ interview: submitted(2, "op-2") }, { interview: submitted(3, "op-3") }],
		frontier: [],
		evidence: () => "missing",
		task: () => undefined,
	});
	assert.equal(map.items[0]!.settledBy?.label, "Interview round 2");
	assert.equal(map.items[0]!.settledBy?.state, "current");
});

test("a claimed question says when its research chat finished and the findings wait for the planner", () => {
	const question = (id: string) => ({
		id,
		title: id,
		question: "?",
		kind: "research",
		options: [],
		recommendedOptionId: null,
		dependsOn: [],
		sources: [],
		claimedBy: `chat-${id}`,
		resolution: null,
	});
	const plan = { questions: [question("done"), question("busy")], fog: [], round: null } as unknown as MissionPlan;
	const map = planMap({
		plan,
		destination: "",
		decisions: [],
		knowledge: [],
		history: [],
		frontier: [],
		evidence: () => "missing",
		task: () => undefined,
		findingsWaiting: (q) => q.id === "done",
	});
	assert.deepEqual(
		map.items.map((i) => [i.id, i.state, i.findingsWaiting ?? false]),
		[
			["done", "claimed", true],
			["busy", "claimed", false],
		],
	);
});
