/** The user's questions about interview questions: a read-only chat answers each; the planner is left alone. Chats are faked. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { interviewDigest } from "./mission-interview-contract.ts";
import { publishedPlanningFixture as fixture } from "./published-planning.fixture.ts";

test("a question about a question gets a read-only chat's answer, and never reaches the planner", async (t) => {
	const f = await fixture(t, { published: false });
	const q = f.store.interviews.latest(f.missionId)!.questions[0]!;
	const chats = new Map<string, Partial<SessionSummary>>();
	const spawned: { title: string; mode?: string; role?: string; message: string }[] = [];
	t.mock.method(
		f.sessions,
		"spawn",
		async (
			request: { title: string; mode?: string; message: string },
			_c: boolean,
			_t: unknown,
			admission: { role: string },
		) => {
			const id = `ask-${spawned.length + 1}`;
			spawned.push({ title: request.title, mode: request.mode, role: admission.role, message: request.message });
			f.store.join(id, f.missionId, { sessionId: f.owner }, "explorer");
			chats.set(id, { id, state: "working", working: true });
			return { id } as SessionSummary;
		},
	);
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) =>
		chats.has(id) ? ({ ...chats.get(id) } as SessionSummary) : get(id),
	);
	t.mock.method(f.sessions, "lastAssistantReply", async () => "It means the app you see today.");
	f.workers.startResearch();

	const stale = f.operation(
		f.missionId,
		{ purpose: "plan-question-ask", questionId: q.id, text: "What?" },
		"b".repeat(64),
	);
	assert.equal((await f.execute(stale)).state, "rejected", "a changed question refuses the ask");
	const op = f.operation(
		f.missionId,
		{ purpose: "plan-question-ask", questionId: q.id, text: "What does native mean here?" },
		interviewDigest(q),
	);
	assert.equal((await f.execute(op)).state, "accepted");
	await f.workers.settleResearch();
	assert.equal(spawned.length, 1);
	assert.deepEqual([spawned[0]!.mode, spawned[0]!.role], ["ask", "explorer"]);
	assert.match(spawned[0]!.message, /The user asks: What does native mean here\?/);
	assert.match(
		spawned[0]!.message,
		new RegExp(`The planning question: ${q.prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
	);
	const asking = (await f.native.read(f.project.id, f.missionId)).questionAsks as { state: string; text: string }[];
	assert.deepEqual(
		asking.map((a) => [a.state, a.text]),
		[["asking", "What does native mean here?"]],
	);

	chats.set("ask-1", { id: "ask-1", state: "idle", working: false, outcome: "done" });
	f.workers.scheduleResearch(f.missionId);
	await f.workers.settleResearch();
	const read = (await f.native.read(f.project.id, f.missionId)).questionAsks as { state: string; answer: string }[];
	assert.deepEqual(
		read.map((a) => [a.state, a.answer]),
		[["answered", "It means the app you see today."]],
	);
	assert.equal(f.inputs.length, 0, "the planner hears nothing");
	assert.equal((await f.execute(op)).state, "accepted", "the same ask is not asked twice");
	assert.equal(spawned.length, 1);
});
