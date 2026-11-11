import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { DeliveredWork, DurableOperation, UserVerificationIntent } from "@pilot/protocol";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";
import { payloadHash } from "./operation-journal.ts";

test("native delivered-work read exposes canonical outputs, explicit verification and ordinary durable Send back", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const headers = { "content-type": "application/json", "x-pilot-github-capability": f.capability };
	const worker = await f.sessions.spawnDurable(
		{ projectId: f.project.id, mode: "build", model: "fake/model", message: "Synthetic work only" },
		randomUUID(),
		randomUUID(),
	);
	const deniedInput = randomUUID();
	await assert.rejects(
		f.sessions.sendDurable(worker.id, "Must not be admitted", "followUp", deniedInput, {
			admissionGuard: () => {
				throw new Error("Exact delivery changed");
			},
		}),
		/Exact delivery changed/,
	);
	const guardMeta = JSON.parse(await readFile(join(f.home, "sessions", worker.id, "meta.json"), "utf8"));
	assert.equal(
		guardMeta.pending.some((p: { requestId: string }) => p.requestId === deniedInput),
		false,
	);
	const mission = f.store.create({ projectId: f.project.id, title: "Fake mission" });
	f.store.join(worker.id, mission.id);
	const task = f.store.addTask(mission.id, { title: "Fake output", sessionId: worker.id });
	const path = `/api/projects/${f.project.id}/missions/${mission.id}/tasks/${task.id}/delivered-work`;
	const get = async () => {
		const r = await fetch(f.root + path, { headers });
		assert.equal(r.status, 200);
		assert.equal(r.headers.get("cache-control"), "no-store");
		return (await r.json()) as DeliveredWork;
	};
	assert.equal((await get()).deliveryId, null);
	const pr = f.store.addResource(mission.id, {
		taskId: task.id,
		url: "https://github.com/example/repo/pull/1",
		relationship: "reference",
	});
	f.store.updatePullRequest({
		number: 1,
		url: pr.url,
		title: "Fake PR",
		state: "merged",
		mergedAt: 100,
		checkedAt: 110,
	});
	f.store.linkArtifact(mission.id, {
		sessionId: worker.id,
		taskId: task.id,
		artifactId: "fake-artifact",
		title: "Fake output",
		kind: "visual",
		revision: 1,
	});
	f.store.writeBrief(mission.id, "Non-code result", 0);
	const nonCode = {
		kind: "non-code",
		references: [
			{ kind: "brief", revision: 1 },
			{ kind: "artifact", artifactId: "fake-artifact", revision: 1 },
		],
		checks: "Fixture references",
		limitations: "No production proof",
	};
	f.store.saveNonCodeDelivery(mission.id, task.id, worker.id, nonCode, new Map([["fake-artifact", worker.id]]));
	f.store.completeTask(mission.id, task.id, worker.id, {
		commit: "a".repeat(40),
		checks: "Synthetic checks",
		issues: "Not deployed",
	});
	let page = await get();
	assert.equal(page.completion?.commit, "a".repeat(40));
	assert.deepEqual(page.nonCodeDelivery, nonCode);
	assert.equal(page.pullRequests[0]?.pullRequest?.state, "merged");
	assert.equal(page.pullRequests[0]?.pullRequest?.mergedAt, 100);
	assert.equal(page.artifacts[0]?.artifactId, "fake-artifact");
	assert.equal(page.production, "not_tracked");
	assert.equal(page.verification, null);
	const before = f.store.task(mission.id, task.id);
	const operation = (action: UserVerificationIntent["action"], note = ""): DurableOperation => {
		const payload = JSON.stringify({
			purpose: "user-verification",
			subject: page.subject,
			deliveryId: page.deliveryId,
			expectedRevision: page.verificationRevision,
			action,
			note,
		});
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.host, hostId: "local" },
			destination: f.host,
			kind: "user-verification",
			targetId: page.targetId,
			bindingId: page.deliveryId!,
			bindingGeneration: 1,
			payload,
			payloadHash: payloadHash(payload),
		};
	};
	const post = async (op: DurableOperation, lookup = false, token = f.capability) => {
		const r = await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
			method: "POST",
			headers: { ...headers, "x-pilot-github-capability": token },
			body: JSON.stringify(op),
		});
		return { status: r.status, body: await r.json() };
	};
	const done = operation("done");
	assert.notEqual((await post(done, false, "bad-token")).status, 200);
	const ack = await post(done);
	assert.equal(ack.status, 200);
	assert.equal(ack.body.receipt.state, "accepted");
	assert.equal(ack.body.verificationReceipt.state, "accepted");
	assert.deepEqual(ack.body.receipt.result, ack.body.verificationReceipt.verification);
	assert.deepEqual(await post(done, true), ack, "Check is exact, passive lookup");
	assert.deepEqual(await post(done), ack, "duplicate cannot create revisions");
	page = await get();
	assert.equal(page.verificationCurrent, true);
	assert.equal(page.verificationReceiptState, "accepted");
	assert.equal((await post(operation("reopen"))).body.receipt.state, "accepted");
	page = await get();
	const note = "  Please check this exact line 🐦\nNot deployed yet.  ";
	const back = operation("send_back", note),
		result = await post(back);
	assert.equal(result.body.receipt.state, "accepted", JSON.stringify(result));
	assert.equal(result.body.verificationReceipt.verification.messageReceipt.requestId, back.operationId);
	const meta = JSON.parse(await readFile(join(f.home, "sessions", worker.id, "meta.json"), "utf8"));
	assert.equal(meta.pending.find((p: { requestId: string }) => p.requestId === back.operationId).content, note);
	assert.deepEqual(f.store.task(mission.id, task.id), before, "no task state changes");
	assert.equal((await get()).production, "not_tracked");
	assert.equal(f.stats().external, 0);
	for (const forbidden of [
		fetch(f.root + path, { headers: { ...headers, "x-pilot-github-capability": "bad" } }),
		fetch(f.root + path.replace(f.project.id, f.other.id), { headers }),
	]) {
		const r = await forbidden;
		assert.notEqual(r.status, 200);
		await r.arrayBuffer();
	}
});
