/** Unstick's repair agent: one read-only Diagnostics chat that reads the planner's chat and proposes one fix. Chats are faked. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { parseMissionFix } from "./planning-workers.ts";
import { publishedPlanningFixture as fixture } from "../publication/published-planning.fixture.ts";

const block = (v: unknown) => `I read the refusal.\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
const note = {
	fix: "planner-note",
	cause: "The map is full: Pilot refused a save with 42 questions.",
	note: "Merge open research questions a and b, then save again.",
	certainty: "high",
	evidence: ["plan-map refused: Invalid planning list"],
};

test("a repair reply gives one fix from the closed list, or nothing", () => {
	assert.deepEqual(parseMissionFix(block(note)), note);
	assert.deepEqual(
		parseMissionFix(`${block({ ...note, fix: "none", note: undefined })}\n${block(note)}`),
		note,
		"the last block wins",
	);
	for (const bad of [
		{ ...note, fix: "delete-map" },
		{ ...note, fix: "continue" },
		{ ...note, note: "" },
		{ ...note, evidence: [] },
		{ ...note, cause: "x".repeat(601) },
		{ ...note, extra: 1 },
	])
		assert.equal(parseMissionFix(block(bad)), null, JSON.stringify(bad).slice(0, 60));
	assert.equal(parseMissionFix("No block here."), null);
});

test("Have an agent look starts one Diagnostics chat on the planner, and its fix shows in the read", async (t) => {
	const f = await fixture(t, { published: false });
	const chats = new Map<string, Partial<SessionSummary>>();
	const spawned: Record<string, unknown>[] = [];
	t.mock.method(f.sessions, "diagnosticTargetFor", (sessionId: string) => ({
		host: { hostId: "local", daemonId: "d", lineageId: "l" },
		sessionId,
		chatUrl: `pilot://chat/${sessionId}`,
	}));
	t.mock.method(f.sessions, "spawn", async (request: Record<string, unknown>) => {
		const id = `repair-${spawned.length + 1}`;
		spawned.push(request);
		chats.set(id, { id, state: "working", working: true });
		return { id } as SessionSummary;
	});
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) =>
		chats.has(id) ? ({ ...chats.get(id) } as SessionSummary) : get(id),
	);
	t.mock.method(f.sessions, "lastAssistantReply", async () => block(note));
	f.workers.startReconciling();

	const view = (await f.native.read(f.project.id, f.missionId)).repair as {
		available: boolean;
		contextDigest: string;
	};
	assert.equal(view.available, true, "an idle planner on an open plan is stuck");
	const stale = f.operation(f.missionId, { purpose: "plan-repair-start" }, "b".repeat(64));
	assert.equal((await f.execute(stale)).state, "rejected", "a changed mission refuses the start");
	const op = f.operation(f.missionId, { purpose: "plan-repair-start" }, view.contextDigest);
	assert.equal((await f.execute(op)).state, "accepted");
	await f.workers.settleReconciling();
	assert.equal(spawned.length, 1);
	const chat = spawned[0]!;
	assert.deepEqual(
		[chat.role, chat.mode, chat.diagnosticHistoryAccess, chat.missionId],
		["diagnostics", "ask", true, undefined],
	);
	assert.equal((chat.diagnosticTarget as { sessionId: string }).sessionId, f.binding.ownerSessionId);
	assert.match(String(chat.message), new RegExp(`missionId ${f.missionId}`));
	const again = f.operation(f.missionId, { purpose: "plan-repair-start" }, view.contextDigest);
	assert.equal((await f.execute(again)).state, "rejected", "one repair chat per mission at a time");
	let read = (await f.native.read(f.project.id, f.missionId)).repair as Record<string, unknown>;
	assert.deepEqual([read.state, read.chatId, read.available], ["looking", "repair-1", false]);

	chats.set("repair-1", { id: "repair-1", state: "idle", working: false, outcome: "done" });
	f.workers.scheduleReconcile(f.missionId);
	await f.workers.settleReconciling();
	read = (await f.native.read(f.project.id, f.missionId)).repair as Record<string, unknown>;
	assert.deepEqual([read.state, read.current, read.available], ["proposed", true, true]);
	assert.deepEqual(read.proposal, note);
	assert.equal(f.inputs.length, 0, "the planner hears nothing until the user applies the fix");
});

test("a repair reply with no usable fix fails plainly", async (t) => {
	const f = await fixture(t, { published: false });
	t.mock.method(f.sessions, "diagnosticTargetFor", (sessionId: string) => ({
		host: { hostId: "local", daemonId: "d", lineageId: "l" },
		sessionId,
		chatUrl: `pilot://chat/${sessionId}`,
	}));
	let done = false;
	t.mock.method(f.sessions, "spawn", async () => ({ id: "repair-1" }) as SessionSummary);
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) =>
		id === "repair-1"
			? ({
					id,
					state: done ? "idle" : "working",
					working: !done,
					outcome: done ? "done" : undefined,
				} as SessionSummary)
			: get(id),
	);
	t.mock.method(f.sessions, "lastAssistantReply", async () => "I think it is fine.");
	f.workers.startReconciling();
	const view = (await f.native.read(f.project.id, f.missionId)).repair as { contextDigest: string };
	assert.equal(
		(await f.execute(f.operation(f.missionId, { purpose: "plan-repair-start" }, view.contextDigest))).state,
		"accepted",
	);
	await f.workers.settleReconciling();
	done = true;
	f.workers.scheduleReconcile(f.missionId);
	await f.workers.settleReconciling();
	const read = (await f.native.read(f.project.id, f.missionId)).repair as Record<string, unknown>;
	assert.equal(read.state, "failed");
	assert.match(String(read.reason), /no fix Pilot can use/);
});
