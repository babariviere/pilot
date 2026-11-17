import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { CONTINUE_TEXT } from "./native-chat.ts";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";
import { payloadHash } from "./operation-journal.ts";

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
