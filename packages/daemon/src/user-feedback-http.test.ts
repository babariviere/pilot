import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { UserFeedback, UserFeedbackPage } from "@pilot/protocol";
import { AttachmentStore } from "./attachment-store.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";

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
