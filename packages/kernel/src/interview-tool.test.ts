import assert from "node:assert/strict";
import { test } from "node:test";
import type { InterviewQuestion } from "@pilot/protocol";
import { createInterviewTool, createMissionInterviewPort, type NativeInterviewPort } from "./interview-tool.ts";
import { createMissionPlanTool, type NativePlanningPort } from "./mission-plan-tool.ts";

const questions: InterviewQuestion[] = [
	{
		id: "outcome",
		section: "outcome",
		prompt: "Which outcome?",
		options: [{ id: "one", meaning: "One result" }],
		recommendedOptionId: "one",
		context: "Exact background\n ",
	},
];
const fence = {
	missionId: "mission",
	ownerSessionId: "owner",
	enrollmentId: "enrollment",
	questionSetRevision: 2,
	answerRevision: 3,
};
const interview = {
	fence,
	revision: 4,
	questions,
	answers: [{ questionId: "outcome", questionDigest: "digest", selectedOption: null, text: " draft\n " }],
	submission: null,
};
const planning = (overrides: Partial<NativePlanningPort> = {}): NativePlanningPort => ({
	read: async () => ({ plan: null, interview }),
	knowledge: async () => ({}),
	receipt: async () => ({ state: "pending" }),
	write: async () => ({}),
	...overrides,
});

test("shared interview forwards opaque tokens, call identity, abort and exact saved state", async () => {
	const signal = new AbortController().signal;
	const calls: unknown[] = [];
	const port: NativeInterviewPort = {
		read: async (received) => {
			assert.equal(received, signal);
			return { ...interview, expected: "opaque-not-json" };
		},
		questions: async (...args) => {
			calls.push(args);
			return { status: "awaiting-answers" };
		},
		receipt: async (...args) => {
			calls.push(args);
			return { state: "pending" };
		},
	};
	const tool = createInterviewTool(port);
	assert.equal(tool.executionMode, "sequential");
	const read = await tool.execute("read", { action: "read" }, signal, undefined, {} as never);
	assert.deepEqual(JSON.parse((read.content[0] as { text: string }).text), {
		...interview,
		expected: "opaque-not-json",
	});
	for (const expected of ["opaque-not-json", null]) {
		const request = { expected, questions };
		const result = await tool.execute("call", { action: "questions", request }, signal, undefined, {} as never);
		assert.match(JSON.stringify(result), /awaiting-answers/);
		assert.deepEqual(calls.at(-1), ["call", request, signal]);
	}
	await tool.execute("check", { action: "check", operationId: "retained" }, signal, undefined, {} as never);
	assert.deepEqual(calls.at(-1), ["retained", signal]);
	for (const action of ["answer", "save", "submit", "ask_user"])
		await assert.rejects(
			tool.execute("never", { action } as never, signal, undefined, {} as never),
			/Unsupported interview action/,
		);
	assert.equal(calls.length, 3);
});

test("shared interview rejects invalid rounds before invoking the host port", async () => {
	let writes = 0;
	const tool = createInterviewTool({
		read: async () => ({}),
		receipt: async () => ({}),
		questions: async () => {
			writes++;
			return {};
		},
	});
	const question = questions[0]!;
	for (const invalid of [
		[],
		Array.from({ length: 41 }, (_, index) => ({ ...question, id: `q${index}` })),
		[question, question],
		[{ ...question, context: "é".repeat(751) }],
		[{ ...question, recommendedOptionId: "missing" }],
		[{ ...question, options: Array.from({ length: 9 }, (_, index) => ({ id: `o${index}`, meaning: "Option" })) }],
		Array.from({ length: 40 }, (_, index) => ({ ...question, id: `q${index}`, prompt: "x".repeat(2000) })),
	])
		await assert.rejects(
			tool.execute(
				"never",
				{ action: "questions", request: { expected: null, questions: invalid } },
				undefined,
				undefined,
				{} as never,
			),
		);
	assert.equal(writes, 0);
});

test("mission adapter reads worker top-level interview and decodes exact expected fence", async () => {
	const signal = new AbortController().signal;
	const calls: unknown[] = [];
	const port = createMissionInterviewPort(
		planning({
			read: async (revision, received) => {
				assert.equal(revision, undefined);
				assert.equal(received, signal);
				return { interview, plan: {}, settled: [] };
			},
			questions: async (...args) => {
				calls.push(args);
				return { receipt: { state: "accepted" }, status: "awaiting-answers" };
			},
			receipt: async (...args) => {
				calls.push(args);
				return { state: "pending" };
			},
		}),
	);
	const expected = JSON.stringify({ fence, revision: 4 });
	assert.deepEqual(await port.read(signal), { expected, questions, answers: interview.answers, submission: null });
	await port.questions("once", { expected, questions, kind: "revisit" }, signal);
	assert.deepEqual(calls, [
		[
			"once",
			{ purpose: "interview-questions", expected: { fence, revision: 4 }, questions, kind: "revisit" },
			signal,
		],
	]);
	await port.receipt("retained", signal);
	assert.deepEqual(calls.at(-1), ["retained", signal]);
	for (const token of [null, "not-json", "null", "{}", '{"fence":{},"revision":4}'])
		assert.throws(() => port.questions("never", { expected: token, questions }), /Read|Invalid/);
	assert.equal(calls.length, 2);
	await assert.rejects(createMissionInterviewPort(planning({ read: async () => ({}) })).read(), /unavailable/);
	assert.throws(
		() => createMissionInterviewPort(planning()).questions("never", { expected, questions }),
		/binding unavailable/,
	);
});

test("mission compatibility and shared interview use the same question schema", () => {
	const shared = JSON.stringify(createInterviewTool(createMissionInterviewPort(planning())).parameters);
	const mission = JSON.stringify(createMissionPlanTool(planning()).parameters);
	assert.match(shared, /recommendedOptionId/);
	assert.match(shared, /additionalProperties/);
	assert.doesNotMatch(shared, /interview-save|interview-submit|questionDigest/);
	const sharedSchema = JSON.parse(shared).anyOf.find(
		(schema: { properties: { action: { const: string } } }) => schema.properties.action.const === "questions",
	);
	const missionSchema = JSON.parse(mission).anyOf.find(
		(schema: { properties: { action: { const: string } } }) => schema.properties.action.const === "questions",
	);
	assert.deepEqual(
		sharedSchema.properties.request.properties.questions,
		missionSchema.properties.request.properties.questions,
	);
});
