import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation, SessionSummary, UserFeedbackPage } from "@pilot/protocol";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";
import { payloadHash } from "./operation-journal.ts";

test("feedback triage, fix, mission link and resolved marks are exact, saved steps on the original feedback", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const get = async (path: string) => {
		const r = await fetch(f.root + path, { headers });
		assert.equal(r.status, 200, path);
		return r.json();
	};
	const post = async (op: DurableOperation, lookup = false) => {
		const r = await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
			method: "POST",
			headers,
			body: JSON.stringify(op),
		});
		return r.json();
	};
	const operation = (kind: string, targetId: string, request: Record<string, unknown>, binding?: string) => {
		const payload = JSON.stringify(request);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.host, hostId: "local" },
			destination: f.host,
			kind,
			targetId,
			payload,
			payloadHash: payloadHash(payload),
			bindingId: binding ?? payloadHash(payload),
			bindingGeneration: 1,
		} as DurableOperation;
	};
	const feedback = async (text: string) => {
		const op = operation("user-feedback", randomUUID(), { purpose: "user-feedback", text, origin: null });
		const r = await post(op);
		assert.equal(r.state, "accepted", JSON.stringify(r));
		return op.targetId;
	};
	const older = await feedback("Plan page hides who works");
	const id = await feedback("The plan page does not say who is working on a task");
	const choice = async (mode: "ask" | "build") => {
		const { mode: _mode, ...c } = await get(`/api/projects/${f.project.id}/chat-profile?mode=${mode}`);
		return c as Record<string, string>;
	};
	const ask = await choice("ask");
	const step = (request: Record<string, unknown>, targetId: string = randomUUID()) =>
		operation(
			"feedback-work",
			targetId,
			{ purpose: "feedback-work", feedbackId: id, ...request },
			request.contextDigest as string | undefined,
		);
	const page = async (): Promise<UserFeedbackPage> => get("/api/feedback");

	// Exact fields only: no mode, message, cwd or another project.
	for (const extra of [{ mode: "build" }, { message: "do it" }, { cwd: "/" }, { projectPath: f.other.path }]) {
		const r = await post(step({ action: "triage", ...ask, ...extra }));
		assert.equal(r.state ?? "rejected", "rejected", JSON.stringify(r));
	}
	assert.equal(f.stats().sessions, 0);

	const triage = step({ action: "triage", ...ask });
	const ack = await post(triage);
	assert.equal(ack.state, "accepted", JSON.stringify(ack));
	assert.deepEqual(ack.result, {
		operationId: triage.operationId,
		recordedAt: ack.result.recordedAt,
		kind: "triage",
		sessionId: triage.targetId,
		projectId: f.project.id,
	});
	const meta = JSON.parse(await readFile(join(f.home, "sessions", triage.targetId, "meta.json"), "utf8"));
	assert.equal(meta.mode, "ask");
	assert.equal(meta.projectId, f.project.id);
	assert.match(meta.title, /^Triage: The plan page/);
	const message = meta.pending[0].content as string;
	assert.match(message, /You only read and propose/);
	assert.match(message, /ask_user/);
	assert(message.includes(older), "other feedback is data for duplicates");
	// A lost ACK is a lookup, never a second chat.
	assert.deepEqual(await post(triage, true), ack);
	assert.deepEqual(await post(triage), ack);
	assert.equal(f.stats().sessions, 1);
	// One running triage at a time.
	assert.equal((await post(step({ action: "triage", ...ask }))).state, "rejected");
	assert.equal(f.stats().sessions, 1);

	let shown = (await page()).items.find((i) => i.id === id)!;
	assert.equal(shown.work.length, 1);
	assert.equal(shown.work[0]!.chat?.state, "working");
	assert.equal(shown.work[0]!.proposal, undefined);

	// The triage finishes with a proposal in its own history.
	const real = f.sessions.get.bind(f.sessions);
	let answer = JSON.stringify({
		summary: "Show the assignee on each plan row.",
		duplicates: [older, "never-saved"],
		next: "fix",
		detail: "Add the assignee name to PlanRow and check it in Plan.test.tsx.",
		missionId: null,
		goal: null,
	});
	t.mock.method(f.sessions, "get", (sid: string) => {
		const s = real(sid);
		return sid === triage.targetId && s
			? ({ ...s, working: false, outcome: "done", outcomeAt: 7 } as SessionSummary)
			: s;
	});
	t.mock.method(f.sessions, "history", async () => ({
		entries: [
			{ id: "1", kind: "pi.user" },
			{ id: "2", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: answer }] }] },
		],
		more: false,
	}));
	const finished = (await page()).items.find((i) => i.id === id)!;
	const proposal = finished.work[0]!.proposal;
	assert(proposal && "value" in proposal, JSON.stringify(proposal));
	assert.deepEqual(proposal.value.duplicates, [older], "only saved feedback can be a duplicate");
	assert.equal(proposal.value.next, "fix");
	assert.equal(finished.work[0]!.chat?.state, "done");

	// Start fix names the exact proposal the user read.
	const build = await choice("build");
	const stale = await post(
		step({ action: "fix", ...build, triageSessionId: triage.targetId, proposalDigest: "0".repeat(64) }),
	);
	assert.equal(stale.state, "rejected");
	const fix = step({ action: "fix", ...build, triageSessionId: triage.targetId, proposalDigest: proposal.digest });
	const fixAck = await post(fix);
	assert.equal(fixAck.state, "accepted", JSON.stringify(fixAck));
	const fixMeta = JSON.parse(await readFile(join(f.home, "sessions", fix.targetId, "meta.json"), "utf8"));
	assert.equal(fixMeta.mode, "build");
	assert.match(fixMeta.pending[0].content, /Add the assignee name to PlanRow/);
	assert.equal(f.stats().sessions, 2);

	// Any proposal, here a new mission, can also be done as one chat, tied to no mission.
	answer = JSON.stringify({
		...JSON.parse(answer),
		next: "new-mission",
		goal: "Show who owns each plan row",
		detail: "A few steps across plans and Today.",
	});
	t.mock.method(f.sessions, "get", (sid: string) => {
		const s = real(sid);
		if (sid === fix.targetId && s) return { ...s, working: false, outcome: "done", outcomeAt: 9 } as SessionSummary;
		return sid === triage.targetId && s
			? ({ ...s, working: false, outcome: "done", outcomeAt: 10 } as SessionSummary)
			: s;
	});
	const planned = (await page()).items.find((i) => i.id === id)!.work[0]!.proposal!;
	assert("value" in planned, JSON.stringify(planned));
	const chat = step({ action: "fix", ...build, triageSessionId: triage.targetId, proposalDigest: planned.digest });
	const chatAck = await post(chat);
	assert.equal(chatAck.state, "accepted", JSON.stringify(chatAck));
	const chatMeta = JSON.parse(await readFile(join(f.home, "sessions", chat.targetId, "meta.json"), "utf8"));
	assert.match(chatMeta.pending[0].content, /as one chat, whatever the proposal suggested/);
	assert.equal(f.stats().sessions, 3);

	// Linking adds context to the mission; it starts nothing.
	const mission = f.store.create({ projectId: f.project.id, title: "Plan clarity", goal: "Clearer plans" });
	const link = step({ action: "link", missionId: mission.id }, mission.id);
	assert.equal((await post(link)).state, "accepted");
	assert.equal((await post(step({ action: "link", missionId: mission.id }, mission.id))).state, "rejected");
	assert.equal((await post(step({ action: "link", missionId: "missing" }, "missing"))).state, "rejected");
	assert(f.store.events(mission.id).some((e) => e.text.includes("context, not a request to start work")));
	assert.equal(f.stats().sessions, 3);

	// Only the user's mark resolves it; a mark repeats nothing.
	assert.equal((await post(step({ action: "reopen" }, id))).state, "rejected");
	assert.equal((await post(step({ action: "resolve" }, id))).state, "accepted");
	assert.equal((await post(step({ action: "resolve" }, id))).state, "rejected");
	assert.equal((await post(step({ action: "reopen" }, id))).state, "accepted");

	shown = (await page()).items.find((i) => i.id === id)!;
	assert.deepEqual(
		shown.work.map((w) => w.kind),
		["triage", "fix", "fix", "mission", "resolved", "reopened"],
	);
	const linked = shown.work[3]!;
	assert.deepEqual(linked.mission, { title: "Plan clarity", status: "active", tasksDone: 0, tasksTotal: 0 });
	assert.deepEqual((await page()).items.find((i) => i.id === older)!.work, []);
});

test("an answer to the triage's question goes to that chat once; a lost ACK is an exact input lookup, never a resend", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const get = async (path: string) => {
		const r = await fetch(f.root + path, { headers });
		assert.equal(r.status, 200, path);
		return r.json();
	};
	const post = async (op: DurableOperation, lookup = false) => {
		const r = await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
			method: "POST",
			headers,
			body: JSON.stringify(op),
		});
		return r.json();
	};
	const operation = (targetId: string, request: Record<string, unknown>, binding?: string) => {
		const payload = JSON.stringify(request);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.host, hostId: "local" },
			destination: f.host,
			kind: request.purpose,
			targetId,
			payload,
			payloadHash: payloadHash(payload),
			bindingId: binding ?? payloadHash(payload),
			bindingGeneration: 1,
		} as DurableOperation;
	};
	const saved = operation(randomUUID(), { purpose: "user-feedback", text: "Plans hide who works", origin: null });
	assert.equal((await post(saved)).state, "accepted");
	const id = saved.targetId;
	const { mode: _mode, ...ask } = await get(`/api/projects/${f.project.id}/chat-profile?mode=ask`);
	const step = (targetId: string, request: Record<string, unknown>) =>
		operation(
			targetId,
			{ purpose: "feedback-work", feedbackId: id, ...request },
			request.contextDigest as string | undefined,
		);
	const triage = step(randomUUID(), { action: "triage", ...ask });
	assert.equal((await post(triage)).state, "accepted");
	const chat = triage.targetId;
	const answer = (message: unknown, questionId: unknown = 42, target = chat, extra: Record<string, unknown> = {}) =>
		step(target, { action: "answer", questionId, message, ...extra });

	// Waiting on the user: the read shows the triage's exact pending question.
	const real = f.sessions.get.bind(f.sessions);
	let asking = true;
	t.mock.method(f.sessions, "get", (sid: string) => {
		const s = real(sid);
		return sid === chat && s && asking ? ({ ...s, working: true, outcome: "question" } as SessionSummary) : s;
	});
	let entry = 42;
	t.mock.method(f.sessions, "pendingQuestion", async (sid: string) =>
		sid === chat
			? {
					id: entry,
					data: {
						question: "Which page do you mean?",
						context: "Plans and missions both list tasks.",
						options: [
							{ label: "The plan page", suggested: true },
							{ label: "Mission overview", detail: "Tasks list" },
						],
					},
				}
			: null,
	);
	const shown = async () => ((await get("/api/feedback")) as UserFeedbackPage).items.find((i) => i.id === id)!;
	const first = (await shown()).work[0]!;
	assert.equal(first.chat?.state, "question");
	assert.deepEqual(first.question, {
		id: 42,
		question: "Which page do you mean?",
		context: "Plans and missions both list tasks.",
		options: [
			{ label: "The plan page", suggested: true },
			{ label: "Mission overview", detail: "Tasks list" },
		],
	});

	// Exact fields only, aimed at this feedback's current triage and its current question.
	for (const bad of [
		answer("   "),
		answer("x".repeat(8001)),
		answer("The plan page", 0),
		answer("The plan page", 41),
		answer("The plan page", 42, randomUUID()),
		answer("The plan page", 42, chat, { start: true }),
	])
		assert.equal((await post(bad)).state, "rejected", bad.payload);
	const meta = async () => JSON.parse(await readFile(join(f.home, "sessions", chat, "meta.json"), "utf8"));
	assert.equal((await meta()).pending.length, 1, "only the triage's opening message");

	// One answer: the same input admission as any reply to an agent question, fenced to the question.
	const sent = answer("The plan page\n\nThe one with the task rows.");
	const ack = await post(sent);
	assert.equal(ack.state, "accepted", JSON.stringify(ack));
	assert.deepEqual(ack.result, {
		operationId: sent.operationId,
		recordedAt: ack.result.recordedAt,
		kind: "answer",
		sessionId: chat,
		questionId: 42,
		text: "The plan page\n\nThe one with the task rows.",
	});
	const input = (await meta()).pending.find((p: { requestId: string }) => p.requestId === sent.operationId);
	assert.equal(input.content, "The plan page\n\nThe one with the task rows.");
	assert.equal(input.mode, "followUp");
	assert.equal(input.questionReplyId, 42);
	assert.deepEqual(await post(sent, true), ack);
	assert.deepEqual(await post(sent), ack);
	assert.equal((await meta()).pending.length, 2);
	// It clarifies only: no fix chat, link or mark.
	assert.equal(f.stats().sessions, 1);
	assert.deepEqual(
		(await shown()).work.map((w) => w.kind),
		["triage", "answer"],
	);

	// A chat that is not waiting takes no answer.
	asking = false;
	assert.equal((await post(answer("More detail"))).state, "rejected");
	asking = true;

	// The chat accepts the next answer but the ACK is lost: it stays Unknown, and only the exact
	// accepted-input lookup settles it. Nothing is sent again.
	entry = 43;
	const send = f.sessions.sendDurable.bind(f.sessions);
	let sends = 0;
	t.mock.method(f.sessions, "sendDurable", async (...args: Parameters<typeof send>) => {
		sends++;
		await send(...args);
		throw new Error("connection lost after admission");
	});
	let accepted = false;
	t.mock.method(f.sessions, "lookupNativeAttentionInput", async (_sid: string, operationId: string) => {
		return accepted && operationId === lost.operationId;
	});
	const lost = answer("Mission overview", 43);
	assert.equal((await post(lost)).state, "pending");
	assert.equal((await post(lost, true)).state, "pending");
	assert.equal((await post(lost)).state, "pending");
	accepted = true;
	const found = await post(lost, true);
	assert.equal(found.state, "accepted", JSON.stringify(found));
	assert.equal(found.result.kind, "answer");
	assert.equal(found.result.questionId, 43);
	assert.deepEqual(await post(lost, true), found);
	assert.equal(sends, 1, "never sent again");
	assert.equal(
		(await meta()).pending.filter((p: { requestId: string }) => p.requestId === lost.operationId).length,
		1,
	);
	assert.deepEqual(
		(await shown()).work.map((w) => w.kind),
		["triage", "answer", "answer"],
	);
});
