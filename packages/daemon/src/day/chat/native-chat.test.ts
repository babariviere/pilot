import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { CONTINUE_TEXT } from "./native-chat.ts";
import { nativeIntakeFixture } from "../intake/native-intake.fixture.ts";
import { payloadHash } from "../../transport/operations/operation-journal.ts";

test("ordinary Build handoff refusal is a settled native rejection, not a pending operation", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const sessionId = randomUUID();
	f.sessions["metas"].set(sessionId, {
		id: sessionId,
		cwd: f.project.path,
		projectId: f.project.id,
		title: "Ordinary Build",
		mode: "build",
		model: "fake/model",
		outcome: "failed",
		createdAt: 1,
		updatedAt: 20,
	});
	const payload = JSON.stringify({
		purpose: "chat-handoff",
		sessionId,
		message: "Keep scope",
		updatedAt: 20,
		inputGeneration: 0,
	});
	const op: DurableOperation = {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: { ...f.host, hostId: "local" },
		destination: f.host,
		kind: "chat-handoff",
		targetId: sessionId,
		payload,
		payloadHash: payloadHash(payload),
		bindingId: "0".repeat(64),
		bindingGeneration: 1,
	};
	const post = async (lookup = false) =>
		(
			await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-pilot-github-capability": f.capability },
				body: JSON.stringify(op),
			})
		).json();
	const refused = await post();
	assert.equal(refused.state, "rejected", JSON.stringify(refused));
	assert.match(refused.reason, /no saved feedback fix admission/);
	assert.deepEqual(await post(true), refused);
	assert.deepEqual(await post(), refused);
	assert.equal(f.sessions.get(sessionId)?.continuedTo, undefined);
});

test("native fix handoff requires exact authority and resolves lost replies without another handoff", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const sourceId = randomUUID(),
		successor = randomUUID();
	let starts = 0,
		lookups = 0;
	t.mock.method(
		f.sessions,
		"handoffFix",
		async (id: string, operationId: string, note: string, updatedAt: number, inputGeneration: number) => {
			starts++;
			assert.equal(id, sourceId);
			assert.equal(note, "Keep the evidence links");
			assert.equal(updatedAt, 20);
			assert.equal(inputGeneration, 3);
			assert.equal(operationId, op.operationId);
			throw new Error("Lost ACK after ownership commit");
		},
	);
	t.mock.method(f.sessions, "lookupFixHandoff", async (id: string, operationId: string) => {
		lookups++;
		assert.equal(id, sourceId);
		assert.equal(operationId, op.operationId);
		return { id: successor } as NonNullable<ReturnType<typeof f.sessions.get>>;
	});
	const payload = JSON.stringify({
		purpose: "chat-handoff",
		sessionId: sourceId,
		message: "Keep the evidence links",
		updatedAt: 20,
		inputGeneration: 3,
	});
	const op: DurableOperation = {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: { ...f.host, hostId: "local" },
		destination: f.host,
		kind: "chat-handoff",
		targetId: sourceId,
		payload,
		payloadHash: payloadHash(payload),
		bindingId: "0".repeat(64),
		bindingGeneration: 1,
	};
	const post = async (lookup: boolean, capability = f.capability) =>
		fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pilot-github-capability": capability },
			body: JSON.stringify(op),
		});
	assert.notEqual((await post(false, "denied")).status, 200);
	assert.equal(starts, 0);
	await post(false);
	assert.equal(starts, 1);
	const checked = await (await post(true)).json();
	assert.equal(checked.state, "accepted", JSON.stringify(checked));
	assert.deepEqual(checked.result, { sourceSessionId: sourceId, sessionId: successor, operationId: op.operationId });
	assert.equal(lookups, 1);
	assert.deepEqual(await (await post(false)).json(), checked);
	assert.equal(starts, 1);
});

test("native project inventory/select are passive; exact standalone creation and lookup keep project, mode and words", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const get = async (path: string) => {
		const r = await fetch(f.root + path, { headers });
		assert.equal(r.status, 200);
		return r.json();
	};
	const post = async (op: DurableOperation, lookup = false, token = f.capability) => {
		const r = await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
			method: "POST",
			headers: { ...headers, "x-pilot-github-capability": token },
			body: JSON.stringify(op),
		});
		return { status: r.status, body: await r.json() };
	};
	const inventory = await get("/api/native-projects");
	assert.equal(inventory.complete, true);
	assert.equal(inventory.projects.length, 2);
	const a = await get(`/api/projects/${f.project.id}/chat-profile?mode=ask`);
	const b = await get(`/api/projects/${f.other.id}/chat-profile?mode=build`);
	assert.equal(f.stats().sessions, 0);
	const operation = (selection: typeof a, message = "  exact\nwords 🐦  "): DurableOperation => {
		const draftId = randomUUID(),
			payload = JSON.stringify({ ...selection, purpose: "native-chat-create", draftId, message });
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.host, hostId: "local" },
			destination: f.host,
			kind: "native-chat-create",
			targetId: draftId,
			payload,
			payloadHash: payloadHash(payload),
			bindingId: selection.contextDigest,
			bindingGeneration: 1,
		};
	};
	const denied = await post(operation(a), false, "denied");
	assert.notEqual(denied.status, 200);
	assert.equal(f.stats().sessions, 0);
	for (const extra of [
		{ missionId: "not-a-chat" },
		{ cwd: "/another/root" },
		{ model: "fake/other" },
		{ mode: "unrestricted" },
		{ projectPath: f.other.path },
	]) {
		const refused = await post(operation({ ...a, ...extra }));
		assert(refused.status === 400 || refused.body.state === "rejected", JSON.stringify(refused));
	}
	assert.equal(f.stats().sessions, 0, "no extra grant, cwd override or mission fallback");
	const opA = operation(a),
		ack = (await post(opA)).body;
	assert.equal(ack.state, "accepted", JSON.stringify(ack));
	const meta = JSON.parse(await readFile(join(f.home, "sessions", opA.targetId, "meta.json"), "utf8"));
	assert.equal(meta.projectId, f.project.id);
	assert.equal(meta.mode, "ask");
	assert.equal(meta.pending[0].content, "  exact\nwords 🐦  ");
	assert.equal(meta.createOperationId, opA.operationId);
	assert.deepEqual((await post(opA, true)).body, ack);
	assert.deepEqual((await post(opA)).body, ack);
	assert.equal(f.stats().sessions, 1);
	// Selection from another project is a separate explicit act, never a fallback.
	await f.projects.update(f.other.id, { name: "Changed" });
	const stale = (await post(operation(b))).body;
	assert.equal(stale.state, "rejected");
	assert.equal(f.stats().sessions, 1);
	const current = await get(`/api/projects/${f.other.id}/chat-profile?mode=build`);
	const opB = operation(current);
	assert.equal((await post(opB)).body.state, "accepted");
	const metaB = JSON.parse(await readFile(join(f.home, "sessions", opB.targetId, "meta.json"), "utf8"));
	assert.equal(metaB.projectId, f.other.id);
	assert.equal(metaB.mode, "build");
	await f.projects.remove(f.other.id);
	assert.equal((await post(operation(current))).body.state, "rejected");
	assert.equal((await post(opB, true)).body.state, "accepted", "historical lookup does not retarget deleted project");
	assert.equal(f.stats().sessions, 2);
	assert.equal(f.stats().external, 0);
});

test("project/model changes during passive selection cannot grant later creation", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	f.sessions.selectTaskModel = async () => {
		await f.projects.update(f.project.id, { name: "Changed during catalog I/O" });
		return { model: "fake/model", thinking: "high" };
	};
	const r = await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=build`, {
		headers: { "x-pilot-github-capability": f.capability },
	});
	assert.notEqual(r.status, 200);
	await r.arrayBuffer();
	assert.equal(f.stats().sessions, 0);
});

test("entered creation with missing outer receipt never re-enters session admission", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const selected = await (
		await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=build`, { headers })
	).json();
	const draftId = randomUUID(),
		payload = JSON.stringify({ ...selected, purpose: "native-chat-create", draftId, message: "Do this once" });
	const op: DurableOperation = {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: { ...f.host, hostId: "local" },
		destination: f.host,
		kind: "native-chat-create",
		targetId: draftId,
		payload,
		payloadHash: payloadHash(payload),
		bindingId: selected.contextDigest,
		bindingGeneration: 1,
	};
	const spawn = f.sessions.spawnDurable.bind(f.sessions);
	let entered = 0;
	f.sessions.spawnDurable = async (...args) => {
		entered++;
		await spawn(...args);
		throw new Error("Lost admission acknowledgement");
	};
	for (const suffix of ["", "/receipt", "", "/receipt"]) {
		const r = await fetch(`${f.root}/api/operations${suffix}`, { method: "POST", headers, body: JSON.stringify(op) });
		assert.equal((await r.json()).state, "pending");
	}
	assert.equal(entered, 1);
	assert.equal(f.stats().sessions, 1);
});

test("Continue sends its fixed words once, only to a stopped chat, and a lost reply is a lookup", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const post = async (op: DurableOperation, lookup = false) =>
		(
			await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
				method: "POST",
				headers,
				body: JSON.stringify(op),
			})
		).json();
	const envelope = (kind: string, targetId: string, request: Record<string, unknown>, bindingId: string) => {
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
			bindingId,
			bindingGeneration: 1,
		} as DurableOperation;
	};
	const selection = await (
		await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=build`, { headers })
	).json();
	const draftId = randomUUID();
	const created = await post(
		envelope(
			"native-chat-create",
			draftId,
			{ ...selection, purpose: "native-chat-create", draftId, message: "Fix the parser" },
			selection.contextDigest,
		),
	);
	assert.equal(created.state, "accepted", JSON.stringify(created));
	const sessionId = created.result.sessionId as string;
	const go = (extra: Record<string, unknown> = {}, target = sessionId) =>
		envelope("chat-continue", target, { purpose: "chat-continue", sessionId: target, ...extra }, "0".repeat(64));
	const queued = () => f.sessions.get(sessionId) as unknown as { outcome?: string };
	// Not stopped: refused, nothing sent.
	assert.equal((await post(go())).state, "rejected");
	// Exact fields only: the window cannot choose words.
	// The fixture runs no worker: make the chat look stopped, as a user Stop leaves it.
	const meta = (
		f.sessions as unknown as { metas: Map<string, { outcome?: string; pending?: unknown[]; working?: boolean }> }
	).metas.get(sessionId)!;
	Object.assign(meta, { outcome: "stopped", pending: [], working: false, initializing: undefined });
	assert.equal(queued().outcome, "stopped");
	assert.equal((await post(go({ message: "rm -rf" }))).state ?? "rejected", "rejected");
	const op = go();
	const receipt = await post(op);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.deepEqual(receipt.result, { sessionId, operationId: op.operationId });
	assert.deepEqual(await post(op, true), receipt);
	assert.deepEqual(await post(op), receipt);
	const saved = JSON.parse(await readFile(join(f.home, "sessions", sessionId, "meta.json"), "utf8"));
	const sent = (saved.pending as { content: string }[]).filter((p) => p.content === CONTINUE_TEXT);
	assert.equal(sent.length, 1, "Continue is sent once");
});
test("Continue also takes a User Stop hold and a safe failed run; Dismiss takes a failure out of Needs you", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const post = async (op: DurableOperation) =>
		(await fetch(`${f.root}/api/operations`, { method: "POST", headers, body: JSON.stringify(op) })).json();
	const envelope = (kind: string, targetId: string, request: Record<string, unknown>, bindingId: string) => {
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
			bindingId,
			bindingGeneration: 1,
		} as DurableOperation;
	};
	const selection = await (
		await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=build`, { headers })
	).json();
	const create = async () => {
		const draftId = randomUUID();
		const created = await post(
			envelope(
				"native-chat-create",
				draftId,
				{ ...selection, purpose: "native-chat-create", draftId, message: "Fix the parser" },
				selection.contextDigest,
			),
		);
		assert.equal(created.state, "accepted", JSON.stringify(created));
		return created.result.sessionId as string;
	};
	const op = (kind: string, target: string) =>
		envelope(kind, target, { purpose: kind, sessionId: target }, "0".repeat(64));
	type Meta = { outcome?: string; outcomeAt?: number; pending?: unknown[]; missionUserStopGeneration?: number };
	const metas = (f.sessions as unknown as { metas: Map<string, Meta> }).metas;
	const idle = (id: string, fields: Meta) =>
		Object.assign(metas.get(id)!, { pending: [], working: false, initializing: undefined, ...fields });
	const sent = async (id: string) =>
		(
			JSON.parse(await readFile(join(f.home, "sessions", id, "meta.json"), "utf8")).pending as { content: string }[]
		).filter((p) => p.content === CONTINUE_TEXT).length;

	// A mission chat the user stopped has no outcome, only the User Stop hold. Continue still shows and works.
	const held = await create();
	idle(held, { outcome: undefined, missionUserStopGeneration: 1 });
	assert.equal(f.sessions.get(held)?.canContinue, true);
	const go = await post(op("chat-continue", held));
	assert.equal(go.state, "accepted", JSON.stringify(go));
	assert.equal(await sent(held), 1);
	assert.equal(metas.get(held)!.missionUserStopGeneration, undefined, "the user's Continue clears the hold");

	// A failed run with no tool in flight takes one retry.
	const failed = await create();
	idle(failed, { outcome: "failed", outcomeAt: Date.now() });
	assert.equal(f.sessions.get(failed)?.canContinue, true);
	// Dismiss first: it sends nothing and takes the failure out of Needs you.
	const dismissed = await post(op("chat-dismiss", failed));
	assert.equal(dismissed.state, "accepted", JSON.stringify(dismissed));
	assert.equal(f.sessions.get(failed)?.failureDismissed, true);
	assert.equal(await sent(failed), 0);
	assert.equal((await post(op("chat-continue", failed))).state, "accepted");
	assert.equal(await sent(failed), 1);

	// A finished chat takes neither.
	const done = await create();
	idle(done, { outcome: "done", outcomeAt: Date.now() });
	assert.equal(f.sessions.get(done)?.canContinue, undefined);
	assert.equal((await post(op("chat-continue", done))).state, "rejected");
	assert.equal((await post(op("chat-dismiss", done))).state, "rejected");
	assert.equal(await sent(done), 0);
});

test("Reply sends the user's own words once, to an eligible existing chat", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const post = async (op: DurableOperation, lookup = false) =>
		(
			await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
				method: "POST",
				headers,
				body: JSON.stringify(op),
			})
		).json();
	const envelope = (kind: string, targetId: string, request: Record<string, unknown>, bindingId: string) => {
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
			bindingId,
			bindingGeneration: 1,
		} as DurableOperation;
	};
	const selection = await (
		await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=build`, { headers })
	).json();
	const draftId = randomUUID();
	const created = await post(
		envelope(
			"native-chat-create",
			draftId,
			{ ...selection, purpose: "native-chat-create", draftId, message: "Fix the parser" },
			selection.contextDigest,
		),
	);
	assert.equal(created.state, "accepted", JSON.stringify(created));
	const sessionId = created.result.sessionId as string;
	const reply = (message: unknown, extra: Record<string, unknown> = {}) =>
		envelope("chat-reply", sessionId, { purpose: "chat-reply", sessionId, message, ...extra }, "0".repeat(64));
	const metas = (f.sessions as unknown as { metas: Map<string, Record<string, unknown>> }).metas;
	Object.assign(metas.get(sessionId)!, { outcome: "done", pending: [], working: false, initializing: undefined });
	const sent = async () =>
		(
			JSON.parse(await readFile(join(f.home, "sessions", sessionId, "meta.json"), "utf8")).pending as {
				content: string;
			}[]
		).filter((p) => p.content === "Postgres, please.").length;
	// Structured questions use their own answer path.
	metas.get(sessionId)!.outcome = "question";
	assert.equal(f.sessions.get(sessionId)?.canReply, undefined);
	assert.equal((await post(reply("Postgres, please."))).state, "rejected");
	metas.get(sessionId)!.outcome = "stopped";
	assert.equal(f.sessions.get(sessionId)?.canReply, true);
	for (const bad of [reply(""), reply(42), reply("x".repeat(12_001)), reply("ok", { note: "x" })])
		assert.equal((await post(bad)).state ?? "rejected", "rejected");
	const op = reply("Postgres, please.");
	const receipt = await post(op);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.deepEqual(await post(op, true), receipt);
	assert.deepEqual(await post(op), receipt);
	assert.equal(await sent(), 1, "Reply is sent once");
});
