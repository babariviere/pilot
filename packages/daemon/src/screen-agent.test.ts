import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { DurableOperation, ScreenRequest } from "@pilot/protocol";
import { WebSocket } from "ws";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";
import { payloadHash } from "./operation-journal.ts";
import { NO_WINDOW, SCREEN_DEADLINES } from "./screen-broker.ts";
import type { SessionWorker } from "./sessions.ts";

async function setup(t: import("node:test").TestContext) {
	const f = await nativeIntakeFixture();
	// Stand-in workers leave before shutdown, which would stop them as real ones.
	const fakes = new Set<string>();
	t.after(async () => {
		for (const id of fakes) (f.sessions["workers"] as Map<string, SessionWorker>).delete(id);
		await f.close();
	});
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
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
	const post = async (op: DurableOperation, lookup = false) =>
		(
			await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
				method: "POST",
				headers,
				body: JSON.stringify(op),
			})
		).json();
	const profile = async (mode: string) =>
		(await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=${mode}`, { headers })).json();
	const create = async (mode: "ask" | "screen", message = "What is this button?") => {
		const selection = await profile(mode);
		assert.equal(selection.mode, mode);
		const draftId = randomUUID();
		const receipt = await post(
			operation(
				"native-chat-create",
				draftId,
				{ ...selection, purpose: "native-chat-create", draftId, message },
				selection.contextDigest,
			),
		);
		assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
		return receipt.result.sessionId as string;
	};
	const call = (method: string, path: string, body?: unknown) =>
		fetch(`${f.root}${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { ...f, fakes, headers, operation, post, create, call };
}

/** A stand-in worker for the chat: it sends packets as the kernel would and keeps what pilotd answers. */
function worker(f: Awaited<ReturnType<typeof setup>>, sessionId: string) {
	const received: KernelCommand[] = [];
	const fake = { send: (command: KernelCommand) => received.push(command) } as unknown as SessionWorker;
	const workers = f.sessions["workers"] as Map<string, SessionWorker>;
	workers.set(sessionId, fake);
	f.fakes.add(sessionId);
	const meta = f.sessions["metas"].get(sessionId)!;
	const packet = (p: KernelPacket) => f.sessions["onPacket"](meta, fake, p);
	const result = async (callId: string) => {
		for (let i = 0; i < 400; i++) {
			const found = received.find((c) => c.type === "screen.result" && c.callId === callId);
			if (found) return found as Extract<KernelCommand, { type: "screen.result" }>;
			await new Promise((r) => setTimeout(r, 10));
		}
		assert.fail(`no screen.result for ${callId}`);
	};
	return { packet, result };
}

test("a screen chat asks its bound window and gets the answer, a picture, a refusal or a deadline", async (t) => {
	const f = await setup(t);
	const screen = await f.create("screen");
	const ask = await f.create("ask");
	const meta = JSON.parse(await readFile(join(f.home, "sessions", screen, "meta.json"), "utf8"));
	assert.equal(meta.role, "screen");
	assert.equal(meta.mode, "ask");
	assert.equal(meta.projectId, f.project.id);

	// Binding: native authority, an existing screen chat, exact fields.
	const unauthorized = await fetch(`${f.root}/api/screen/bindings`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ windowId: "w1", sessionId: screen }),
	});
	assert.notEqual(unauthorized.status, 204);
	assert.equal((await f.call("PUT", "/api/screen/bindings", { windowId: "w1", sessionId: "missing" })).status, 404);
	assert.equal((await f.call("PUT", "/api/screen/bindings", { windowId: "w1", sessionId: ask })).status, 409);
	assert.equal((await f.call("PUT", "/api/screen/bindings", { windowId: "w1" })).status, 400);
	const w = worker(f, screen);

	// No window yet: the tool fails at once with the sentence the agent reads.
	w.packet({ type: "screen.call", callId: "none", operation: { op: "snapshot" } });
	assert.equal((await w.result("none")).error, NO_WINDOW);

	assert.equal((await f.call("PUT", "/api/screen/bindings", { windowId: "w1", sessionId: screen })).status, 204);
	const ws = new WebSocket(`${f.root.replace("http", "ws")}/api/ws`);
	const notices: unknown[] = [];
	ws.on("message", (raw) => {
		const message = JSON.parse(String(raw));
		if (message.type === "screen.requested") notices.push(message);
	});
	await once(ws, "open");
	const waiting = async (windowId: string): Promise<ScreenRequest[]> => {
		const r = await f.call("GET", `/api/screen/requests?windowId=${windowId}`);
		assert.equal(r.status, 200);
		return (await r.json()).requests;
	};
	const answer = (id: string, windowId: string, body: unknown) =>
		f.call("POST", `/api/screen/requests/${id}?windowId=${windowId}`, body);

	// Snapshot: request → notice → GET → POST answer → the tool's value.
	w.packet({ type: "screen.call", callId: "snap", operation: { op: "snapshot" } });
	let [request] = await waiting("w1");
	assert.deepEqual(request!.operation, { op: "snapshot" });
	assert.equal(request!.sessionId, screen);
	assert.ok(request!.deadline > Date.now() && request!.deadline <= Date.now() + SCREEN_DEADLINES.snapshot);
	assert.deepEqual(await waiting("w2"), []);
	assert.equal((await answer(request!.id, "w2", { ok: true, value: {} })).status, 409);
	assert.equal((await answer(randomUUID(), "w1", { ok: true, value: {} })).status, 404);
	assert.equal((await answer(request!.id, "w1", { ok: "yes" })).status, 400);
	const entries = [{ ref: "c1", component: "button", label: "New", actions: ["press"] }];
	assert.equal((await answer(request!.id, "w1", { ok: true, value: { entries } })).status, 204);
	assert.deepEqual((await w.result("snap")).result, { entries });
	assert.equal((await answer(request!.id, "w1", { ok: true, value: {} })).status, 404, "answered once");
	for (let i = 0; i < 100 && !notices.length; i++) await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(notices[0], { type: "screen.requested", windowId: "w1" });
	// The server waits for open sockets on close.
	ws.close();
	await once(ws, "close");

	// A refused act becomes a tool error with the window's sentence.
	w.packet({
		type: "screen.call",
		callId: "act",
		operation: { op: "act", steps: [{ ref: "Send", action: "press" }] },
	});
	[request] = await waiting("w1");
	await answer(request!.id, "w1", { ok: false, error: "Needs a person: Send sends the message." });
	assert.equal((await w.result("act")).error, "Needs a person: Send sends the message.");

	// Screenshot: the window uploads the PNG; the kernel gets it as base64.
	const png = await readFile(new URL("../../../apps/macos/Resources/LegacyApp/HomeSky.png", import.meta.url));
	const ref = { uploadId: randomUUID(), sha256: createHash("sha256").update(png).digest("hex"), bytes: png.length };
	const uploaded = await fetch(`${f.root}/api/attachments/${ref.uploadId}`, {
		method: "PUT",
		headers: {
			...f.headers,
			"x-pilot-attachment": Buffer.from(JSON.stringify({ ...ref, origin: { ...f.host, hostId: "local" } })).toString(
				"base64",
			),
		},
		body: png,
	});
	assert.equal(uploaded.status, 201);
	w.packet({ type: "screen.call", callId: "shot", operation: { op: "screenshot" } });
	[request] = await waiting("w1");
	const picture = { attachment: ref, width: 800, height: 600, mimeType: "image/png" };
	await answer(request!.id, "w1", { ok: true, value: picture });
	assert.deepEqual((await w.result("shot")).result, { picture, data: png.toString("base64") });

	// A kernel abort cancels the waiting request.
	w.packet({ type: "screen.call", callId: "abort", operation: { op: "query", text: "New" } });
	assert.equal((await waiting("w1")).length, 1);
	w.packet({ type: "diagnostics.context.cancel", callId: "abort" });
	await w.result("abort");
	assert.deepEqual(await waiting("w1"), []);

	// Deadline: the window never answers.
	const deadline = SCREEN_DEADLINES.query;
	SCREEN_DEADLINES.query = 1000;
	t.after(() => {
		SCREEN_DEADLINES.query = deadline;
	});
	w.packet({ type: "screen.call", callId: "late", operation: { op: "query" } });
	assert.equal((await w.result("late")).error, "The window did not answer within 1 s. It may be closed or busy.");
	assert.deepEqual(await waiting("w1"), []);

	// The window closes: its waiting requests fail at once and later calls have no window.
	w.packet({ type: "screen.call", callId: "closing", operation: { op: "snapshot" } });
	assert.equal((await waiting("w1")).length, 1);
	assert.equal((await f.call("DELETE", "/api/screen/bindings/w1")).status, 204);
	assert.equal((await w.result("closing")).error, NO_WINDOW);
	w.packet({ type: "screen.call", callId: "after", operation: { op: "snapshot" } });
	assert.equal((await w.result("after")).error, NO_WINDOW);

	// Other chats cannot use a window, even with a forged packet.
	const other = worker(f, ask);
	other.packet({ type: "screen.call", callId: "forged", operation: { op: "snapshot" } });
	assert.match((await other.result("forged")).error ?? "", /Only a screen agent chat/);
});

test("a screen chat takes replies and triages the feedback it helped write", async (t) => {
	const f = await setup(t);
	const screen = await f.create("screen");
	const ask = await f.create("ask");
	const metas = f.sessions["metas"];
	for (const id of [screen, ask])
		Object.assign(metas.get(id)!, { outcome: "done", outcomeAt: Date.now(), pending: [], initializing: undefined });
	const pending = async (id: string) =>
		(JSON.parse(await readFile(join(f.home, "sessions", id, "meta.json"), "utf8")).pending ?? []) as {
			content: string;
		}[];

	// The bar is a conversation: a reply needs no waiting question.
	const reply = (sessionId: string, message: string) =>
		f.operation("chat-reply", sessionId, { purpose: "chat-reply", sessionId, message }, "0".repeat(64));
	assert.equal((await f.post(reply(screen, "And this one?"))).state, "accepted");
	assert.equal((await f.post(reply(ask, "And this one?"))).state, "rejected");
	Object.assign(metas.get(screen)!, { pending: [] });

	const saved = f.operation("user-feedback", randomUUID(), {
		purpose: "user-feedback",
		text: "The New button does nothing",
		origin: { kind: "chat", sessionId: screen },
	});
	assert.equal((await f.post(saved)).state, "accepted");
	const feedbackId = saved.targetId;
	const { mode: _mode, ...choice } = await (
		await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=ask`, { headers: f.headers })
	).json();
	const triage = (adoptSessionId: string, targetId = adoptSessionId) =>
		f.operation(
			"feedback-work",
			targetId,
			{ purpose: "feedback-work", feedbackId, action: "triage", ...choice, adoptSessionId },
			choice.contextDigest,
		);
	const chats = f.stats().sessions;
	for (const bad of [triage(ask), triage(screen, randomUUID()), triage("missing")])
		assert.equal((await f.post(bad)).state ?? "rejected", "rejected");
	const op = triage(screen);
	const receipt = await f.post(op);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.deepEqual(receipt.result, {
		operationId: op.operationId,
		recordedAt: receipt.result.recordedAt,
		kind: "triage",
		sessionId: screen,
		projectId: f.project.id,
	});
	assert.equal(f.stats().sessions, chats, "no new chat");
	const sent = (await pending(screen)).filter((p) => p.content.includes("Triage one piece of the user's feedback"));
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.content, /The New button does nothing/);
	assert.deepEqual(await f.post(op, true), receipt);
	assert.deepEqual(await f.post(op), receipt);
	assert.equal((await pending(screen)).length, 1, "sent once");
	// A second triage of the same feedback refuses.
	assert.equal((await f.post(triage(screen))).state, "rejected");
});
