import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { DurableOperation, SessionSummary, UserFeedbackPage } from "@pilot/protocol";
import { createAskTools } from "../../kernel/src/ask-tools.ts";
import { Funding } from "./funding.ts";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";
import { payloadHash } from "./operation-journal.ts";
import { UserFeedbackWorkService } from "./user-feedback-work.ts";

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
	const contextMission = f.store.create({ projectId: f.project.id, title: "Context", goal: "Context" });
	const feedback = async (
		text: string,
		attachments?: import("@pilot/protocol").StagedAttachmentRef[],
		origin: unknown = null,
	) => {
		const op = operation("user-feedback", randomUUID(), {
			purpose: "user-feedback",
			text,
			origin,
			...(attachments ? { attachments } : {}),
		});
		const r = await post(op);
		assert.equal(r.state, "accepted", JSON.stringify(r));
		return op.targetId;
	};
	const older = await feedback("Plan page hides who works", undefined, {
		kind: "mission",
		missionId: contextMission.id,
	});
	const unrelated = f.store.create({ projectId: f.other.id, title: "Foreign", goal: "Foreign" });
	const foreign = await feedback("Secret foreign feedback", undefined, { kind: "mission", missionId: unrelated.id });
	const general = await feedback("Unscoped feedback is not chosen-project context");
	// A recognizable image, not a one-pixel placeholder. Check the actual
	// read tool's image payload, not just the path handed to triage.
	const png = await readFile(new URL("../../../apps/day/macos/Resources/LegacyApp/HomeSky.png", import.meta.url));
	const image = { uploadId: randomUUID(), sha256: createHash("sha256").update(png).digest("hex"), bytes: png.length };
	const uploaded = await fetch(`${f.root}/api/attachments/${image.uploadId}`, {
		method: "PUT",
		headers: {
			...headers,
			"x-pilot-attachment": Buffer.from(
				JSON.stringify({ ...image, origin: { ...f.host, hostId: "local" } }),
			).toString("base64"),
		},
		body: png,
	});
	assert.equal(uploaded.status, 201);
	await uploaded.arrayBuffer();
	const explicitHome = await mkdtemp(join(tmpdir(), "feedback-read-"));
	t.after(() => rm(explicitHome, { recursive: true, force: true }));
	const namedPath = join(explicitHome, "notes.txt");
	await writeFile(namedPath, "Explicit user-selected source");
	const id = await feedback(`The plan page does not say who is working on a task. Read ${namedPath}`, [image]);
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
	const imagePath = join(f.home, "attachments", `${image.uploadId}.png`);
	assert.deepEqual(meta.ask.feedbackImages, [imagePath]);
	assert.deepEqual(await readFile(imagePath), png);
	assert.equal(meta.ask.feedbackSources.length, 1);
	assert.equal(meta.ask.feedbackSources[0].path, namedPath);
	assert.equal(meta.ask.feedbackSources[0].kind, "file");
	const persisted = f.sessions["metas"].get(triage.targetId)!;
	const originalSources = persisted.ask!.feedbackSources;
	for (const bad of [
		[{ path: "/", kind: "directory", dev: 1, ino: 1 }],
		[{ path: namedPath, kind: "file", dev: -1, ino: 1 }],
		[{ path: namedPath, kind: "file", dev: 1, ino: 1, extra: true }],
	]) {
		persisted.ask!.feedbackSources = bad as NonNullable<typeof originalSources>;
		assert.throws(() => f.sessions["validateMode"](persisted), /Invalid feedback source context/);
	}
	persisted.ask!.feedbackSources = originalSources;
	const reader = (await createAskTools(meta.ask)).find((tool) => tool.name === "read")!;
	const named = await reader.execute("named-feedback-source", { path: namedPath }, undefined, undefined, {
		cwd: meta.cwd,
	} as ExtensionToolContext);
	assert(named.content.some((block) => block.type === "text" && block.text.includes("Explicit user-selected source")));
	const viewed = await reader.execute("feedback-image", { path: imagePath }, undefined, undefined, {
		cwd: meta.cwd,
	} as ExtensionToolContext);
	assert(
		viewed.content.some((block) => block.type === "image"),
		"the triage's actual read tool renders its screenshot",
	);
	const rendered = viewed.content.find((block) => block.type === "image");
	assert.equal(rendered?.mimeType, "image/png");
	assert.deepEqual(Buffer.from(rendered!.data, "base64"), png);
	assert.equal(meta.projectId, f.project.id);
	assert.match(meta.title, /^Triage: The plan page/);
	const message = meta.pending[0].content as string;
	assert.match(message, /You only read and propose/);
	assert.match(message, /ask_user/);
	assert(message.includes(older), "chosen-project feedback is data for duplicates");
	assert(!message.includes(foreign));
	assert(!message.includes(general));
	await mkdir(join(f.home, "source", "nested"), { recursive: true });
	await writeFile(join(f.home, "source", "nested", "sample.ts"), "export const scoped = true;");
	const source = await reader.execute("project-source", { path: "source/nested/sample.ts" }, undefined, undefined, {
		cwd: meta.cwd,
	} as ExtensionToolContext);
	assert(source.content.some((block) => block.type === "text" && block.text.includes("scoped = true")));
	await assert.rejects(
		reader.execute("foreign-source", { path: join(f.home, "..", "unrelated.ts") }, undefined, undefined, {
			cwd: meta.cwd,
		} as ExtensionToolContext),
	);
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
		duplicates: [older, foreign, general, "never-saved"],
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

	// A finished saved investigation cannot silently start again.
	assert.equal((await post(step({ action: "triage", ...ask }))).state, "rejected");
	assert.equal(f.stats().sessions, 1);

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

	t.mock.method(f.sessions, "get", (sid: string) => {
		const s = real(sid);
		if (sid === fix.targetId && s) return { ...s, working: false, outcome: "done", outcomeAt: 9 } as SessionSummary;
		return sid === triage.targetId && s
			? ({ ...s, working: false, outcome: "done", outcomeAt: 7 } as SessionSummary)
			: s;
	});
	// A second window uses a different transport operation. The exact proposal stays used after the fix ends.
	const duplicate = step({
		action: "fix",
		...build,
		triageSessionId: triage.targetId,
		proposalDigest: proposal.digest,
	});
	assert.equal((await post(duplicate)).state, "rejected");
	assert.equal(f.stats().sessions, 2);

	// Any proposal, here a new mission, can also be done as one chat, tied to no mission.
	answer = JSON.stringify({
		...JSON.parse(answer),
		next: "new-mission",
		goal: "Show who owns each plan row",
		detail: "A few steps across plans and Today.",
	});
	let successorWorking = true;
	const successorId = randomUUID();
	t.mock.method(f.sessions, "get", (sid: string) => {
		const s = real(sid);
		if (sid === successorId)
			return {
				...real(fix.targetId)!,
				id: successorId,
				continuationOf: fix.targetId,
				working: successorWorking,
				...(successorWorking ? {} : { outcome: "done" as const, outcomeAt: 10 }),
			};
		if (sid === fix.targetId && s)
			return {
				...s,
				working: false,
				outcome: "stopped",
				outcomeAt: 9,
				continuedTo: successorId,
			} as SessionSummary;
		return sid === triage.targetId && s
			? ({ ...s, working: false, outcome: "done", outcomeAt: 10 } as SessionSummary)
			: s;
	});
	const planned = (await page()).items.find((i) => i.id === id)!.work[0]!.proposal!;
	assert("value" in planned, JSON.stringify(planned));
	const another = step({ action: "fix", ...build, triageSessionId: triage.targetId, proposalDigest: planned.digest });
	assert.equal((await post(another)).state, "rejected", "the successor is still writing this feedback's fix");
	assert.equal(
		(await page()).items.find((i) => i.id === id)!.work.find((w) => w.kind === "fix")!.chat?.currentSessionId,
		successorId,
	);
	successorWorking = false;
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
	const linkedFor = (kind: string, target: string, projectId = f.project.id) =>
		get(
			`/api/feedback?limit=1&resultKind=${kind}&resultId=${target}&projectId=${projectId}`,
		) as Promise<UserFeedbackPage>;
	assert.deepEqual(
		(await linkedFor("mission", mission.id)).items.map((item) => item.id),
		[id],
	);
	assert.deepEqual(
		(await linkedFor("chat", chat.targetId)).items.map((item) => item.id),
		[id],
	);
	assert.deepEqual((await linkedFor("chat", triage.targetId)).items, [], "a suggestion is not a fix result");
	assert.deepEqual(
		(await linkedFor("chat", successorId)).items.map((item) => item.id),
		[id],
	);
	assert.deepEqual(
		(await linkedFor("mission", mission.id, f.other.id)).items,
		[],
		"a different project exposes no link",
	);

	// Only the user's mark resolves it; a mark repeats nothing.
	assert.equal((await post(step({ action: "reopen" }, id))).state, "rejected");
	assert.equal((await post(step({ action: "resolve" }, id))).state, "accepted");
	assert.equal((await linkedFor("mission", mission.id)).items[0]!.work.at(-1)?.kind, "resolved");
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

test("feedback work honors limits-off and only configured quick-fix defaults", async (t) => {
	const f = await nativeIntakeFixture(),
		funding = new Funding(join(f.home, "funding.sqlite"));
	f.sessions.funding = funding;
	t.after(async () => {
		await funding.close();
		await f.close();
	});
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const post = async (op: DurableOperation) =>
		(await fetch(`${f.root}/api/operations`, { method: "POST", headers, body: JSON.stringify(op) })).json();
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
	const saved = operation(randomUUID(), { purpose: "user-feedback", text: "Export as image", origin: null });
	assert.equal((await post(saved)).state, "accepted");
	const profile = await (
		await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=ask`, { headers })
	).json();
	const { mode: _m, allowanceMicros: _a, fundingRequired: _f, ...ask } = profile;
	const triage = () =>
		operation(
			randomUUID(),
			{ purpose: "feedback-work", feedbackId: saved.targetId, action: "triage", ...ask },
			ask.contextDigest,
		);
	const configure = async (quickFixDefaultMicros: number | null) =>
		funding.configure(f.project.id, (await funding.read(f.project.id)).revision, {
			dailyMicros: null,
			missionDefaultMicros: null,
			quickFixDefaultMicros,
		});
	const work = async () =>
		((await (await fetch(`${f.root}/api/feedback`, { headers })).json()) as UserFeedbackPage).items.find(
			(i) => i.id === saved.targetId,
		)!.work;

	await configure(null);
	await funding.setEnabled((await funding.read()).revision, false);
	const op = triage(),
		receipt = await post(op);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal(f.stats().sessions, 1);
	assert.equal(f.sessions.fundingRequired(op.targetId), false);
	assert.equal(f.sessions.fundingOwner(op.targetId).kind, "background");
	assert.equal((await funding.read()).accounts.length, 0);
	assert.equal((await work()).length, 1);
	const get = f.sessions.get.bind(f.sessions);
	t.mock.method(f.sessions, "get", (id: string) => {
		const chat = get(id);
		return chat ? ({ ...chat, working: false, outcome: "done", outcomeAt: 10 } as SessionSummary) : chat;
	});
	t.mock.method(f.sessions, "history", async () => ({
		entries: [
			{
				id: "1",
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [
							{
								type: "text",
								text: JSON.stringify({
									summary: "A small fix",
									duplicates: [],
									next: "fix",
									detail: "Fix and test one file",
									missionId: null,
									goal: null,
								}),
							},
						],
					},
				],
			},
		],
		more: false,
	}));
	const proposal = (await work())[0]!.proposal!;
	assert("value" in proposal);
	const fix = (profile: Record<string, unknown>, setupDigest?: string) =>
		operation(
			randomUUID(),
			{
				purpose: "feedback-work",
				feedbackId: saved.targetId,
				action: "fix",
				...profile,
				...(setupDigest ? { fixSetupDigest: setupDigest } : {}),
				triageSessionId: op.targetId,
				proposalDigest: proposal.digest,
			},
			ask.contextDigest,
		);
	const build = async () => {
		const { mode: _mode, ...profile } = await (
			await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=build`, { headers })
		).json();
		return profile;
	};
	const unmetered = fix(await build(), (await work())[0]!.fixSetup!.digest);
	assert.equal((await funding.read()).accounts.length, 0);
	await funding.setEnabled((await funding.read()).revision, true);
	assert.equal(
		(await post(unmetered)).state,
		"rejected",
		"a displayed unmetered fix cannot start once limits turn on",
	);
	assert.equal(
		(await post(fix(await build(), (await work())[0]!.fixSetup!.digest))).state,
		"rejected",
		"enabled limits never guess a missing allowance",
	);
	assert.equal((await work()).length, 1);
	await configure(3_000_000);
	const shownSetup = (await work())[0]!.fixSetup!;
	assert.equal(shownSetup.allowanceMicros, 3_000_000);
	assert.equal(
		(await post(fix({ ...(await build()), allowanceMicros: 4_000_000 }, shownSetup.digest))).state,
		"rejected",
		"the shown default cannot be silently increased",
	);
	const configured = fix(await build(), shownSetup.digest);
	const unavailable = t.mock.method(funding, "open", async () => {
		throw new Error("Funding disk is unavailable before chat entry");
	});
	assert.equal((await post(configured)).state, "rejected", "a pre-entry failure does not hold the fix");
	assert.equal((await work()).length, 1, "the unentered slot is released");
	unavailable.mock.restore();
	const retry = fix(await build(), shownSetup.digest);
	const save = f.sessions["save"].bind(f.sessions);
	const interrupted = t.mock.method(f.sessions, "save" as never, (...args: Parameters<typeof save>) => {
		if (args[0].id === retry.targetId) throw new Error("Interrupted before launch");
		return save(...args);
	});
	assert.equal((await post(retry)).state, "rejected", "a fully rolled-back admission never started a writer");
	assert.equal((await work()).length, 1);
	assert.equal(f.sessions.get(retry.targetId), undefined);
	interrupted.mock.restore();
	const launched = fix(await build(), shownSetup.digest);
	assert.equal((await post(launched)).state, "accepted");
	assert.equal(f.sessions.fundingRequired(launched.targetId), true);
	assert.equal(
		(await funding.read()).accounts.find((account) => account.id === launched.targetId)?.limitMicros,
		3_000_000,
	);
});

test("remove deletes the feedback, its steps and its unread images, never its chats", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const post = async (op: DurableOperation) =>
		(await fetch(`${f.root}/api/operations`, { method: "POST", headers, body: JSON.stringify(op) })).json();
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
	const png = await readFile(new URL("../../../apps/day/macos/Resources/LegacyApp/HomeSky.png", import.meta.url));
	const image = { uploadId: randomUUID(), sha256: createHash("sha256").update(png).digest("hex"), bytes: png.length };
	const uploaded = await fetch(`${f.root}/api/attachments/${image.uploadId}`, {
		method: "PUT",
		headers: {
			...headers,
			"x-pilot-attachment": Buffer.from(
				JSON.stringify({ ...image, origin: { ...f.host, hostId: "local" } }),
			).toString("base64"),
		},
		body: png,
	});
	assert.equal(uploaded.status, 201);
	await uploaded.arrayBuffer();
	const save = async (text: string, attachments?: unknown[]) => {
		const op = operation(randomUUID(), {
			purpose: "user-feedback",
			text,
			origin: null,
			...(attachments ? { attachments } : {}),
		});
		assert.equal((await post(op)).state, "accepted");
		return op.targetId;
	};
	const ids = async () =>
		((await (await fetch(`${f.root}/api/feedback`, { headers })).json()) as UserFeedbackPage).items.map((i) => i.id);
	const remove = (feedbackId: string) =>
		post(operation(feedbackId, { purpose: "feedback-work", action: "remove", feedbackId }));

	// Never triaged: its image goes with it.
	const plain = await save("Old screenshot", [image]);
	const imagePath = join(f.home, "attachments", `${image.uploadId}.png`);
	await readFile(imagePath);
	// Exact fields only.
	assert.equal(
		(await post(operation(plain, { purpose: "feedback-work", action: "remove", feedbackId: plain, text: "x" })))
			.state ?? "rejected",
		"rejected",
	);
	const removed = await remove(plain);
	assert.equal(removed.state, "accepted", JSON.stringify(removed));
	assert.equal(removed.result.kind, "removed");
	assert(!(await ids()).includes(plain));
	await assert.rejects(readFile(imagePath), /ENOENT/);
	assert.equal((await remove(plain)).state, "rejected");

	// Triaged: the chat stays an ordinary chat.
	const triaged = await save("Triaged item");
	const { mode: _m, ...ask } = await (
		await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=ask`, { headers })
	).json();
	const triage = operation(
		randomUUID(),
		{ purpose: "feedback-work", feedbackId: triaged, action: "triage", ...ask },
		ask.contextDigest,
	);
	assert.equal((await post(triage)).state, "accepted");
	assert.equal((await remove(triaged)).state, "accepted");
	assert(!(await ids()).includes(triaged));
	assert.equal(f.stats().sessions, 1);
	await readFile(join(f.home, "sessions", triage.targetId, "meta.json"));
});

test("feedback triage shares daily background funding; unusable output and exact corrections survive lost ACKs", async (t) => {
	const f = await nativeIntakeFixture();
	const funding = new Funding(join(f.home, "feedback-funding.sqlite"));
	f.sessions.funding = funding;
	t.after(async () => {
		await funding.close();
		await f.close();
	});
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const post = async (op: DurableOperation, lookup = false) => {
		const response = await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
			method: "POST",
			headers,
			body: JSON.stringify(op),
		});
		return response.json();
	};
	const operation = (targetId: string, request: Record<string, unknown>): DurableOperation => {
		const payload = JSON.stringify(request);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.host, hostId: "local" },
			destination: f.host,
			kind: request.purpose as string,
			targetId,
			payload,
			payloadHash: payloadHash(payload),
			bindingId: (request.contextDigest as string) ?? payloadHash(payload),
			bindingGeneration: 1,
		};
	};
	const saved = operation(randomUUID(), { purpose: "user-feedback", text: "Investigate the project", origin: null });
	assert.equal((await post(saved)).state, "accepted");
	const response = await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=ask`, { headers });
	const { mode: _mode, ...choice } = await response.json();
	assert.equal(choice.fundingRequired, true);
	const step = (target: string, request: Record<string, unknown>) =>
		operation(target, { purpose: "feedback-work", feedbackId: saved.targetId, ...request });
	for (const allowanceMicros of [-1, 1.5]) {
		const rejected = await post(step(randomUUID(), { action: "triage", ...choice, allowanceMicros }));
		assert.equal(rejected.state, "rejected", JSON.stringify(rejected));
	}
	assert.equal(f.store.feedback.work(saved.targetId).length, 0, "invalid choices cannot consume the investigation");
	assert.equal((await funding.read()).accounts.length, 0);
	const triage = step(randomUUID(), { action: "triage", ...choice });
	assert.equal((await post(triage)).state, "accepted");
	assert.equal((await funding.read()).accounts.length, 0, "automatic triage opens no quick-fix allowance");
	assert.deepEqual(f.sessions.fundingOwner(triage.targetId), {
		kind: "background",
		id: "daily",
		projectId: f.project.id,
	});
	assert.equal(f.sessions.fundingRequired(triage.targetId), true);
	const meta = JSON.parse(await readFile(join(f.home, "sessions", triage.targetId, "meta.json"), "utf8"));
	assert.equal(meta.fundingBackground, true, "daily ownership is persisted, not inferred from title or model input");
	const viewBefore = await funding.read();
	await funding.configure(undefined, viewBefore.revision, {
		missionDefaultMicros: null,
		quickFixDefaultMicros: null,
		dailyMicros: 300,
	});
	const quote = {
		provider: "fake",
		model: "model",
		inputTokens: 100,
		outputTokens: 10,
		rate: { input: 1_000_000, output: 2_000_000, cacheRead: 100_000, cacheWrite: 2_000_000 },
	};
	await funding.reserve(f.sessions.fundingOwner(triage.targetId), randomUUID(), quote, "feedback-triage");
	await assert.rejects(
		funding.reserve(
			{ kind: "background", id: "daily", projectId: f.project.id },
			randomUUID(),
			quote,
			"another-background-job",
		),
		/cannot fund/,
	);
	assert.equal((await funding.read()).background.uncertainMicros, 220);
	assert.equal(f.stats().sessions, 1);

	const real = f.sessions.get.bind(f.sessions);
	let outcomeAt = 20;
	let raw = `The useful explanation was not JSON. ${"details ".repeat(1200)}`;
	t.mock.method(f.sessions, "get", (sid: string) => {
		const chat = real(sid);
		return sid === triage.targetId && chat
			? ({ ...chat, working: false, outcome: "done", outcomeAt } as SessionSummary)
			: chat;
	});
	t.mock.method(f.sessions, "history", async () => ({
		entries: [
			{ id: "1", kind: "pi.user" },
			{ id: "2", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: raw }] }] },
		],
		more: false,
	}));
	const view = async () => {
		const response = await fetch(`${f.root}/api/feedback`, { headers });
		return ((await response.json()) as UserFeedbackPage).items.find((i) => i.id === saved.targetId)!;
	};
	const proposal = (await view()).work[0]!.proposal!;
	assert("problem" in proposal);
	assert.equal(proposal.raw, undefined, "overlong explanations stay in history, not inline pages or cache");
	assert.equal(proposal.digest, payloadHash(raw));
	const correction = (digest = proposal.digest, target = triage.targetId) =>
		step(target, {
			action: "correct",
			proposalDigest: digest,
			message: "Please check the nested source file and return the proposal JSON.",
		});
	assert.equal((await post(correction("0".repeat(64)))).state, "rejected");
	assert.equal((await post(correction(proposal.digest, randomUUID()))).state, "rejected");
	const sent = correction();
	const ack = await post(sent);
	assert.equal(ack.state, "accepted", JSON.stringify(ack));
	assert.equal(ack.result.kind, "correction");
	assert.equal(f.sessions.fundingOwner(triage.targetId).kind, "background", "correction keeps daily ownership");
	assert.equal(ack.result.proposalDigest, proposal.digest);
	assert.deepEqual(await post(sent, true), ack);
	assert.deepEqual(await post(sent), ack);
	assert.equal((await post(correction())).state, "rejected", "one correction for this exact output");
	assert.equal(f.stats().sessions, 1, "correction never creates a chat or fix");

	outcomeAt++;
	raw = "A second unusable explanation";
	const next = (await view()).work[0]!.proposal!;
	assert("problem" in next);
	assert.equal(next.raw, raw, "short unusable explanations remain verbatim");
	const lost = correction(next.digest);
	const send = f.sessions.sendDurable.bind(f.sessions);
	let sends = 0;
	t.mock.method(f.sessions, "sendDurable", async (...args: Parameters<typeof send>) => {
		sends++;
		await send(...args);
		throw new Error("lost ACK after input admission");
	});
	let accepted = false;
	t.mock.method(
		f.sessions,
		"lookupNativeAttentionInput",
		async (_sid: string, operationId: string) => accepted && operationId === lost.operationId,
	);
	assert.equal((await post(lost)).state, "pending");
	assert.equal((await post(lost, true)).state, "pending");
	assert.equal((await post(lost)).state, "pending");
	accepted = true;
	const recovered = await post(lost, true);
	assert.equal(recovered.state, "accepted", JSON.stringify(recovered));
	assert.equal(recovered.result.kind, "correction");
	assert.equal(sends, 1);
	assert.deepEqual(
		(await view()).work.map((w) => w.kind),
		["triage", "correction", "correction"],
	);
	const restarted = new UserFeedbackWorkService({
		store: f.store,
		sessions: f.sessions,
		chats: {
			prepare: async () => {
				throw new Error("No available model");
			},
			defaultAllowance: async () => ({}),
			qualify: async () => {
				throw new Error("passive read");
			},
			spawn: async () => {
				throw new Error("passive read");
			},
		},
	});
	const reloaded = await restarted.view(saved.targetId);
	assert.deepEqual(
		reloaded,
		(await view()).work,
		"raw output and corrections reconstruct without in-memory service state",
	);
	outcomeAt++;
	raw = JSON.stringify({
		summary: "A small fix",
		duplicates: [],
		next: "fix",
		detail: "Change one file and test it",
		missionId: null,
		goal: null,
	});
	const usable = (await view()).work[0]!.proposal!;
	assert("value" in usable);
	const buildResponse = await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=build`, { headers });
	const { mode: _buildMode, ...buildChoice } = await buildResponse.json();
	const build = { action: "fix", ...buildChoice, triageSessionId: triage.targetId, proposalDigest: usable.digest };
	assert.equal((await post(step(randomUUID(), build))).state, "rejected", "Build still needs its explicit allowance");
	assert.equal(f.store.feedback.work(saved.targetId).length, 3);
	const fix = step(randomUUID(), { ...build, allowanceMicros: 500 });
	assert.equal((await post(fix)).state, "accepted");
	assert.deepEqual(f.sessions.fundingOwner(fix.targetId), {
		kind: "quick_fix",
		id: fix.targetId,
		projectId: f.project.id,
	});
	assert.equal((await funding.read()).accounts.find((a) => a.id === fix.targetId)?.limitMicros, 500);
	// A syntactically valid recommendation can still be wrong. Correction never approves its fix.
	t.mock.method(f.sessions, "sendDurable", async (...args: Parameters<typeof send>) => send(...args));
	assert.equal(
		(await post(correction(proposal.digest))).state,
		"rejected",
		"old explanation digest cannot correct a newer proposal",
	);
	const validCorrection = correction(usable.digest);
	const corrected = await post(validCorrection);
	assert.equal(corrected.state, "accepted", JSON.stringify(corrected));
	assert.equal(corrected.result.kind, "correction");
	assert.equal(corrected.result.proposalDigest, usable.digest);
	assert.deepEqual(await post(validCorrection, true), corrected);
	assert.equal(
		(await post(correction(usable.digest))).state,
		"rejected",
		"the same finished recommendation is corrected once",
	);
	assert.equal(f.stats().sessions, 2, "valid recommendation correction starts no extra chat");
});

test("a prototype proposal starts one read-only prototype chat; its question shows mockups, and the choice becomes the fix", async (t) => {
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
	const operation = (targetId: string, request: Record<string, unknown>) => {
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
			bindingId: (request.contextDigest as string | undefined) ?? payloadHash(payload),
			bindingGeneration: 1,
		} as DurableOperation;
	};
	const saved = operation(randomUUID(), { purpose: "user-feedback", text: "Plan rows feel crowded", origin: null });
	assert.equal((await post(saved)).state, "accepted");
	const id = saved.targetId;
	const choice = async (mode: "ask" | "build") => {
		const { mode: _mode, ...c } = await get(`/api/projects/${f.project.id}/chat-profile?mode=${mode}`);
		return c as Record<string, string>;
	};
	const step = (targetId: string, request: Record<string, unknown>) =>
		operation(targetId, { purpose: "feedback-work", feedbackId: id, ...request });
	const triage = step(randomUUID(), { action: "triage", ...(await choice("ask")) });
	assert.equal((await post(triage)).state, "accepted");

	// Chats as the test sets them: state, last answer and pending question per chat.
	const real = f.sessions.get.bind(f.sessions);
	const state = new Map<string, Partial<SessionSummary>>();
	const answers = new Map<string, string>();
	const questions = new Map<string, { id: number; data: Record<string, unknown> }>();
	t.mock.method(f.sessions, "get", (sid: string) => {
		const s = real(sid);
		return s && state.has(sid) ? ({ ...s, ...state.get(sid) } as SessionSummary) : s;
	});
	t.mock.method(f.sessions, "history", async (sid: string) => ({
		entries: [
			{ id: "1", kind: "pi.user" },
			{
				id: "2",
				kind: "pi.assistant",
				model: [{ role: "assistant", content: [{ type: "text", text: answers.get(sid) ?? "" }] }],
			},
		],
		more: false,
	}));
	t.mock.method(f.sessions, "pendingQuestion", async (sid: string) => questions.get(sid) ?? null);
	const shown = async () => ((await get("/api/feedback")) as UserFeedbackPage).items.find((i) => i.id === id)!;
	const done = (sid: string, outcomeAt: number) => state.set(sid, { working: false, outcome: "done", outcomeAt });
	const asking = (sid: string) => state.set(sid, { working: true, outcome: "question" });
	const proposal = {
		summary: "Plan rows are hard to scan.",
		duplicates: [],
		next: "prototype",
		detail: "How each plan row shows its owner and state.",
		missionId: null,
		goal: null,
	};

	// The triage proposes a prototype: it needs two or three directions.
	done(triage.targetId, 1);
	answers.set(triage.targetId, JSON.stringify({ ...proposal, directions: ["Inline chips"] }));
	const few = (await shown()).work[0]!.proposal!;
	assert("problem" in few && /2 to 3 directions/.test(few.problem), JSON.stringify(few));
	done(triage.targetId, 2);
	answers.set(triage.targetId, JSON.stringify({ ...proposal, directions: ["Inline chips", "A side column"] }));
	const proposed = (await shown()).work[0]!.proposal!;
	assert("value" in proposed, JSON.stringify(proposed));
	assert.equal(proposed.value.next, "prototype");
	assert.deepEqual(proposed.value.directions, ["Inline chips", "A side column"]);

	// Start prototype names the exact proposal. A lost reply stays Unknown: Check only, never a second chat.
	const ask = await choice("ask");
	const start = (proposalDigest: string) =>
		step(randomUUID(), { action: "prototype", ...ask, triageSessionId: triage.targetId, proposalDigest });
	assert.equal((await post(start("0".repeat(64)))).state, "rejected");
	const spawn = f.sessions.spawnDurable.bind(f.sessions);
	const lostSpawn = t.mock.method(f.sessions, "spawnDurable", async (...args: Parameters<typeof spawn>) => {
		await spawn(...args);
		throw new Error("connection lost after admission");
	});
	const prototype = start(proposed.digest);
	assert.equal((await post(prototype)).state, "pending");
	assert.equal((await post(prototype, true)).state, "pending");
	assert.equal((await post(prototype)).state, "pending");
	lostSpawn.mock.restore();
	assert.equal(f.stats().sessions, 2, "one triage and one prototype chat");
	assert.equal((await post(start(proposed.digest))).state, "rejected", "a prototype is still running");
	assert.equal(f.stats().sessions, 2);
	const meta = JSON.parse(await readFile(join(f.home, "sessions", prototype.targetId, "meta.json"), "utf8"));
	assert.equal(meta.mode, "ask", "a prototype writes no code");
	assert.match(meta.title, /^Prototype: /);
	const opening = meta.pending[0].content as string;
	assert.match(opening, /1\. Inline chips\n2\. A side column/);
	assert.match(opening, /ask_user/);
	assert.match(opening, /"mockup"/);

	// Its question shows on the item with the mockups it attached; unknown IDs are left out.
	asking(prototype.targetId);
	const mockups = [
		{ id: "m-chips", title: "Inline chips", kind: "nsh", revision: 2, updatedAt: 1 },
		{ id: "m-column", title: "Side column", kind: "nsh", revision: 1, updatedAt: 2 },
	];
	t.mock.method(f.sessions, "artifacts", async (sid: string) => (sid === prototype.targetId ? mockups : []));
	questions.set(prototype.targetId, {
		id: 7,
		data: {
			question: "Which one should Pilot build?",
			options: [{ label: "Inline chips" }, { label: "Side column" }],
			artifacts: ["m-chips", "m-column", "gone"],
		},
	});
	const waiting = (await shown()).work.find((w) => w.kind === "prototype")!;
	assert.equal(waiting.chat?.state, "question");
	assert.deepEqual(waiting.question?.artifacts, [
		{ sessionId: prototype.targetId, artifactId: "m-chips", title: "Inline chips", kind: "nsh", revision: 2 },
		{ sessionId: prototype.targetId, artifactId: "m-column", title: "Side column", kind: "nsh", revision: 1 },
	]);
	const pick = step(prototype.targetId, {
		action: "answer",
		questionId: 7,
		message: "Inline chips\n\nKeep the owner first.",
	});
	const picked = await post(pick);
	assert.equal(picked.state, "accepted", JSON.stringify(picked));
	assert.equal(picked.result.sessionId, prototype.targetId);
	assert.equal(f.stats().sessions, 2, "an answer starts no fix");

	// The prototype ends with the user's choice as a fix that names one of its own mockups.
	questions.delete(prototype.targetId);
	done(prototype.targetId, 3);
	const fixProposal = {
		summary: "Inline owner chips on plan rows.",
		duplicates: [],
		next: "fix",
		detail: "Add owner and state chips to PlanRow, as in the chosen mockup.",
		missionId: null,
		goal: null,
	};
	answers.set(prototype.targetId, JSON.stringify({ ...fixProposal, mockup: "gone" }));
	const unnamed = (await shown()).work.find((w) => w.kind === "prototype")!.proposal!;
	assert("problem" in unnamed, "only a mockup this prototype made");
	done(prototype.targetId, 4);
	answers.set(prototype.targetId, JSON.stringify({ ...fixProposal, mockup: "m-chips" }));
	const chosen = (await shown()).work.find((w) => w.kind === "prototype")!.proposal!;
	assert("value" in chosen, JSON.stringify(chosen));
	assert.deepEqual(chosen.value.mockup, {
		sessionId: prototype.targetId,
		artifactId: "m-chips",
		title: "Inline chips",
		kind: "nsh",
		revision: 2,
	});

	// Start fix builds exactly that mockup; its message names it and carries the user's words.
	t.mock.method(f.sessions, "artifact", async (sid: string, artifactId: string, revision: number) => {
		assert.deepEqual([sid, artifactId, revision], [prototype.targetId, "m-chips", 2]);
		return { source: "export default () => <Text>Owner chips</Text>;" };
	});
	const fix = step(randomUUID(), {
		action: "fix",
		...(await choice("build")),
		triageSessionId: prototype.targetId,
		proposalDigest: chosen.digest,
	});
	const fixed = await post(fix);
	assert.equal(fixed.state, "accepted", JSON.stringify(fixed));
	const fixMeta = JSON.parse(await readFile(join(f.home, "sessions", fix.targetId, "meta.json"), "utf8"));
	assert.equal(fixMeta.mode, "build");
	const message = fixMeta.pending[0].content as string;
	assert.match(message, /Build exactly the mockup they chose/);
	assert.match(message, /The chosen mockup: "Inline chips" \(artifact m-chips, revision 2/);
	assert.match(message, /Owner chips/);
	assert.match(message, /Keep the owner first/);
	assert.match(message, /ask the user with ask_user; never propose another chat/);

	// The fix's own question shows on the item and takes the user's answer.
	asking(fix.targetId);
	questions.set(fix.targetId, { id: 9, data: { question: "Chips above or beside the title?", options: [] } });
	const fixing = (await shown()).work.find((w) => w.kind === "fix")!;
	assert.equal(fixing.question?.question, "Chips above or beside the title?");
	const reply = await post(step(fix.targetId, { action: "answer", questionId: 9, message: "Beside" }));
	assert.equal(reply.state, "accepted", JSON.stringify(reply));
	assert.deepEqual(
		(await shown()).work.map((w) => w.kind),
		["triage", "prototype", "answer", "fix", "answer"],
	);
	assert.equal(f.stats().sessions, 3);
});

/** A screen agent chat that wrote a feedback draft, as the triage service reads it. */
function screenChat() {
	type Part = { type: string; text?: string };
	const user = (text: string) => ({ kind: "pi.user", model: [{ role: "user", content: text }] });
	const assistant = (...content: Part[]) => ({ kind: "pi.assistant", model: [{ role: "assistant", content }] });
	const said = (text: string) => assistant({ type: "text", text });
	const tool = () => assistant({ type: "toolCall" });
	const draft = [
		user("Help me with this card"),
		said("Here is what I see."),
		user("Write feedback…"),
		said('{"text":"The card hides its chat."}'),
	];
	const chat = { entries: [] as Record<string, unknown>[], role: "screen" };
	const service = new UserFeedbackWorkService({
		store: { feedback: { get: () => undefined, work: () => [] } },
		sessions: {
			get: () => ({
				role: chat.role,
				working: false,
				outcome: "done",
				outcomeAt: chat.entries.length,
				projectId: "p",
			}),
			history: async (_id: string, before: number, limit: number) => {
				const older = chat.entries.map((e, n) => ({ ...e, id: n + 1 })).filter((e) => e.id < before);
				return { entries: older.slice(-limit), more: older.length > limit };
			},
		},
	} as never);
	return { chat, service, user, said, tool, draft };
}

test("a screen agent chat's triage proposal survives later chat in that chat", async () => {
	const { chat, service, user, said, tool, draft } = screenChat();
	const proposal = JSON.stringify({
		summary: "Name the chat and mission on the Decide card.",
		duplicates: [],
		next: "fix",
		detail: "Label the mission and chat on the card; check it in the card test.",
		missionId: null,
		goal: null,
	});
	const triaged = [...draft, user("The user sent feedback from this conversation. …"), tool(), said(proposal)];
	// Over one history page of later chat, ending in prose.
	const later = [
		user("What does Link to this mission do?"),
		...Array.from({ length: 40 }, tool).flatMap((a) => [a, { kind: "pi.tool-result" }]),
		said("It saves the link only."),
	];
	chat.entries = [...triaged, ...later];
	const read = await service.proposal("s");
	assert(read && "value" in read, JSON.stringify(read));
	assert.equal(read.value.summary, "Name the chat and mission on the Decide card.");
	// Other chats keep reading their current turn only.
	chat.role = "ask";
	chat.entries = [...triaged, ...later, user("again"), said("Still prose.")];
	const ask = await service.proposal("s");
	assert(ask && "problem" in ask);
	assert.equal(ask.problem, "The triage's last answer is not a proposal");
});

test("a screen agent chat's feedback draft is never read as its triage proposal", async () => {
	const { chat, service, draft } = screenChat();
	// Pilot sent the triage, but its turn has not started: the chat's last answer is still the draft.
	chat.entries = draft;
	assert.equal(await service.proposal("s"), undefined);
});
