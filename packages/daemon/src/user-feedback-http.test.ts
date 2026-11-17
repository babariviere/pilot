import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation, UserFeedback, UserFeedbackPage } from "@pilot/protocol";
import { AttachmentStore } from "./attachment-store.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";
import { payloadHash } from "./operation-journal.ts";

test("user feedback saves once with exact receipts, derived origins and a native-only newest-first history", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const list = async (query = "", token = f.capability) =>
		fetch(`${f.root}/api/feedback${query}`, { headers: { "x-pilot-github-capability": token } });
	const page = async (query = ""): Promise<UserFeedbackPage> => {
		const res = await list(query);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("cache-control"), "no-store");
		return res.json();
	};
	const denied = await list("", "wrong");
	assert.notEqual(denied.status, 200);
	await denied.arrayBuffer();
	assert.deepEqual(await page(), { items: [], more: false, before: null });

	const send = (request: Record<string, unknown>, id: string = randomUUID()) =>
		f.operation(id, { purpose: "user-feedback", ...request } as { purpose: string });
	const mission = send({
		text: "The plan page hides who is working. 日本語 ✓",
		origin: { kind: "mission", missionId: f.missionId },
	});
	const wrong = await f.post(mission, false, "wrong");
	assert.notEqual(wrong.status, 200);
	await wrong.arrayBuffer();
	assert.equal((await (await f.post(mission, true)).json()).state, "unknown");
	const receipt = await (await f.post(mission)).json();
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	const saved = receipt.result as UserFeedback;
	assert.equal(saved.id, mission.targetId);
	assert.equal(saved.operationId, mission.operationId);
	assert.equal(saved.text, "The plan page hides who is working. 日本語 ✓");
	assert.deepEqual(saved.origin, {
		kind: "mission",
		missionId: f.missionId,
		projectId: f.project.id,
		title: "Synthetic planning",
	});
	// The same envelope never saves twice; lookup returns the exact receipt.
	assert.deepEqual(await (await f.post(mission)).json(), receipt);
	assert.deepEqual(await (await f.post(mission, true)).json(), receipt);

	const general = send({ text: "Feedback about Pilot in general", origin: null });
	assert.equal((await (await f.post(general)).json()).result.origin, null);
	const chat = send({ text: "This chat stalled", origin: { kind: "chat", sessionId: f.owner } });
	const chatSaved = (await (await f.post(chat)).json()).result as UserFeedback;
	assert.deepEqual(chatSaved.origin, {
		kind: "chat",
		sessionId: f.owner,
		projectId: f.project.id,
		title: "Synthetic planning owner",
	});

	for (const bad of [
		send({ text: "   ", origin: null }),
		send({ text: "x".repeat(8193), origin: null }),
		send({ text: "Missing mission", origin: { kind: "mission", missionId: "missing" } }),
		send({ text: "Mixed origin", origin: { kind: "chat", sessionId: f.owner, missionId: f.missionId } }),
		send({ text: "Extra field", origin: null, projectId: f.project.id }),
	]) {
		const r = await (await f.post(bad)).json();
		assert.equal(r.state, "rejected", JSON.stringify(r));
	}
	// The journal refuses an invalid target before any feedback admission.
	const badId = await f.post(send({ text: "Bad ID", origin: null }, "bad id"));
	assert.equal(badId.status, 400);
	await badId.arrayBuffer();

	const first = await page("?limit=2");
	assert.deepEqual(
		first.items.map((i) => i.id),
		[chat.targetId, general.targetId],
	);
	assert.equal(first.more, true);
	assert.equal(first.before, first.items[1]!.sequence);
	const older = await page(`?before=${first.before}`);
	assert.deepEqual(
		older.items.map((i) => i.id),
		[mission.targetId],
	);
	assert.equal(older.more, false);
	assert.equal(older.before, null);
	const tooMany = await list("?limit=21");
	assert.equal(tooMany.status, 400);
	await tooMany.arrayBuffer();

	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==",
		"base64",
	);
	const uploadId = randomUUID();
	const image = { uploadId, sha256: createHash("sha256").update(png).digest("hex"), bytes: png.length };
	const upload = (bytes: Buffer) =>
		fetch(`${f.root}/api/attachments/${uploadId}`, {
			method: "PUT",
			headers: {
				"x-pilot-github-capability": f.capability,
				"x-pilot-attachment": Buffer.from(JSON.stringify({ ...image, origin: mission.origin })).toString("base64"),
			},
			body: Uint8Array.from(bytes),
		});
	// A truncated upload is not ready; retrying the same upload ID uses the same bytes.
	const failed = await upload(png.subarray(0, 34));
	assert.notEqual(failed.status, 201);
	await failed.arrayBuffer();
	const notReady = await (await f.post(send({ text: "not ready", attachments: [image] }))).json();
	assert.equal(notReady.state, "rejected");
	assert.equal((await upload(png)).status, 201);
	assert.equal((await upload(png)).status, 201);
	const attached = send({ text: "The screenshot shows the popup", origin: null, attachments: [image] });
	const attachedReceipt = await (await f.post(attached)).json();
	assert.equal(attachedReceipt.state, "accepted", JSON.stringify(attachedReceipt));
	assert.deepEqual(attachedReceipt.result.attachments, [image]);
	const reused = await (await f.post(send({ text: "another owner", attachments: [image] }))).json();
	assert.equal(reused.state, "rejected");
	for (const images of [[null], [{ ...image, path: "/etc/passwd" }], [image, image], Array(5).fill(image)]) {
		assert.equal((await (await f.post(send({ text: "bad images", attachments: images }))).json()).state, "rejected");
	}
	await f.restart();
	assert.deepEqual(await (await f.post(attached, true)).json(), attachedReceipt);
	assert.deepEqual((await page()).items[0]?.attachments, [image]);
	const paths = await new AttachmentStore(f.home).feedbackPaths(attachedReceipt.result);
	assert.deepEqual(paths, [join(f.home, "attachments", `${uploadId}.png`)]);
	assert.deepEqual(await readFile(paths[0]!), png);
	assert.deepEqual(await (await f.post(mission, true)).json(), receipt);
	assert.equal((await page()).items.length, 4);
});

test("saved feedback owns only its retained same-host investigation operation; reads never dispatch it", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	Object.defineProperty(f.sessions, "start", { value: async () => new Map() });
	f.sessions.selectTaskModel = async () => ({ model: "fake/model", thinking: "high" });
	const response = await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=ask`, {
		headers: { "x-pilot-github-capability": f.capability },
	});
	assert.equal(response.status, 200);
	const { mode: _mode, ...choice } = await response.json();
	const child = (feedbackId: string) =>
		f.operation(
			randomUUID(),
			{ purpose: "feedback-work", action: "triage", feedbackId, ...choice },
			choice.contextDigest,
		);
	const parent = (feedbackId: string, operation: DurableOperation) =>
		f.operation(feedbackId, {
			purpose: "user-feedback",
			text: "Investigate this saved feedback",
			origin: null,
			investigation: { operation },
		});
	const post = async (operation: DurableOperation, lookup = false) => (await f.post(operation, lookup)).json();
	const feedbackId = randomUUID();
	const nested = child(feedbackId);
	const save = parent(feedbackId, nested);
	const accepted = await post(save);
	assert.equal(accepted.state, "accepted", JSON.stringify(accepted));
	assert.deepEqual(accepted.result.investigation, { operation: nested });
	assert.equal(accepted.result.savePayloadHash, save.payloadHash);
	assert.equal(f.sessions.list().length, 0, "saving the claim does not start it");
	assert.equal((await post(nested, true)).state, "unknown", "saving a claim creates no child journal record");
	await fetch(`${f.root}/api/feedback`, { headers: { "x-pilot-github-capability": f.capability } }).then((r) =>
		r.json(),
	);
	assert.deepEqual(await post(save, true), accepted);
	assert.equal(f.sessions.list().length, 0, "GET and accepted parent Check remain passive");
	assert.equal(
		(await post(child(feedbackId))).state,
		"rejected",
		"fresh manual triage cannot replace the claimed child",
	);
	const otherId = randomUUID();
	const changedPayload = JSON.stringify({ ...JSON.parse(nested.payload), feedbackId: otherId });
	const duplicateClaim = { ...nested, payload: changedPayload, payloadHash: payloadHash(changedPayload) };
	assert.equal(
		(await post(parent(otherId, duplicateClaim))).state,
		"rejected",
		"a child operation identity belongs to one feedback",
	);
	const reusedChat = { ...child(otherId), targetId: nested.targetId };
	assert.equal((await post(parent(otherId, reusedChat))).state, "rejected", "a reserved chat belongs to one feedback");
	for (const bad of [
		{ ...child(otherId), origin: { ...nested.origin, daemonId: "other-daemon" } },
		{ ...child(otherId), destination: { ...nested.destination, lineageId: "other-lineage" } },
		nested,
		{ ...child(otherId), payload: nested.payload },
		{ ...child(otherId), bindingId: "0".repeat(64) },
		{ ...child(otherId), kind: "native-chat-create" },
	])
		assert.equal((await post(parent(otherId, bad))).state, "rejected", JSON.stringify(bad));
	assert.equal(f.store.feedback.get(otherId), undefined);
	await f.restart();
	assert.deepEqual(await post(save, true), accepted);
	assert.deepEqual(f.store.feedback.get(feedbackId)?.investigation, { operation: nested });
	assert.equal((await post(nested, true)).state, "unknown");
	const started = await post(nested);
	assert.equal(started.state, "accepted", JSON.stringify(started));
	assert.deepEqual(await post(nested, true), started);
	assert.deepEqual(await post(nested), started);
	assert.equal(f.store.feedback.work(feedbackId).length, 1);
	assert.equal(f.sessions.list().length, 1);
	const meta = JSON.parse(await readFile(join(f.home, "sessions", nested.targetId, "meta.json"), "utf8"));
	assert.equal(meta.projectId, choice.projectId);
	assert.equal(meta.mode, "ask");
	assert.equal(meta.fundingBackground, true);
	assert(
		!meta.pending[0].content.includes(nested.operationId),
		"agent context excludes the native operation capability",
	);
});

test("unknown feedback save confirms exact durable input after restart; an entered child never replays", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	Object.defineProperty(f.sessions, "start", { value: async () => new Map() });
	f.sessions.selectTaskModel = async () => ({ model: "fake/model", thinking: "high" });
	const response = await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=ask`, {
		headers: { "x-pilot-github-capability": f.capability },
	});
	const { mode: _mode, ...choice } = await response.json();
	const feedbackId = randomUUID();
	const nested = f.operation(
		randomUUID(),
		{ purpose: "feedback-work", action: "triage", feedbackId, ...choice },
		choice.contextDigest,
	);
	const save = f.operation(feedbackId, {
		purpose: "user-feedback",
		text: "Saved before ACK",
		origin: null,
		investigation: { operation: nested },
	});
	const post = async (operation: DurableOperation, lookup = false) => (await f.post(operation, lookup)).json();
	const add = f.store.feedback.add.bind(f.store.feedback);
	t.mock.method(f.store.feedback, "add", (feedback: UserFeedback) => {
		add(feedback);
		throw new Error("lost parent ACK after save");
	});
	assert.equal((await post(save)).state, "pending");
	assert.equal(f.sessions.list().length, 0);
	await f.restart();
	const recovered = await post(save, true);
	assert.equal(recovered.state, "accepted", JSON.stringify(recovered));
	assert.equal(recovered.result.savePayloadHash, save.payloadHash);
	assert.deepEqual(recovered.result.investigation, { operation: nested });
	assert.deepEqual(await post(save), recovered, "save re-entry only confirms, never saves twice");
	assert.equal(f.sessions.list().length, 0, "parent recovery never dispatches a child");
	assert.equal((await post(nested, true)).state, "unknown", "native may now send this never-entered exact child");
	const spawn = f.sessions.spawnDurable.bind(f.sessions);
	let attempts = 0;
	t.mock.method(f.sessions, "spawnDurable", async (...args: Parameters<typeof spawn>) => {
		attempts++;
		await spawn(...args);
		throw new Error("lost child ACK after entry");
	});
	assert.equal((await post(nested)).state, "pending");
	assert.equal((await post(nested, true)).state, "pending");
	assert.equal((await post(nested)).state, "pending");
	await f.restart();
	assert.deepEqual(await post(save, true), recovered);
	assert.equal((await post(nested, true)).state, "pending");
	assert.equal((await post(nested)).state, "pending");
	assert.equal(attempts, 1, "entered child is never admitted twice, including after parent Check and restart");
	assert.equal(f.store.feedback.work(feedbackId).length, 1);
	assert.equal(f.sessions.list().length, 1);
});
