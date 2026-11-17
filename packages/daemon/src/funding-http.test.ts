import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { Funding } from "./funding.ts";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";
import { payloadHash } from "./operation-journal.ts";

test("native creation shows its project default and opens exactly one explicitly chosen lifetime account", async (t) => {
	const f = await nativeIntakeFixture(),
		funding = new Funding(join(f.home, "funding.sqlite"));
	f.sessions.funding = funding;
	t.after(async () => {
		await funding.close();
		await f.close();
	});
	await funding.configure(f.project.id, 0, {
		dailyMicros: 1_000_000,
		missionDefaultMicros: 20_000_000,
		quickFixDefaultMicros: 5_000_000,
	});
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const selection = await (
		await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=build`, { headers })
	).json();
	assert.equal(selection.allowanceMicros, 5_000_000);
	assert.equal(f.stats().sessions, 0);
	const create = (amount: number | null) => {
		const draftId = randomUUID(),
			payload = JSON.stringify({
				...selection,
				purpose: "native-chat-create",
				draftId,
				message: "Fix the parser",
				allowanceMicros: amount,
			});
		return {
			schemaVersion: 1 as const,
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
	const post = async (op: ReturnType<typeof create>, lookup = false) =>
		(
			await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
				method: "POST",
				headers,
				body: JSON.stringify(op),
			})
		).json();
	assert.equal((await post(create(null))).state, "rejected");
	assert.equal(f.stats().sessions, 0);
	const op = create(7_000_000),
		receipt = await post(op);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal(f.sessions.fundingRequired(receipt.result.sessionId), true);
	assert.equal((await funding.read()).accounts[0]!.limitMicros, 7_000_000);
	assert.deepEqual(await post(op, true), receipt);
	assert.deepEqual(await post(op), receipt);
	assert.equal((await funding.read()).accounts.length, 1);
	assert.equal(f.stats().sessions, 1);
});

test("with limits off, native creation asks no amount, opens no allowance and starts unmetered work", async (t) => {
	const f = await nativeIntakeFixture(),
		funding = new Funding(join(f.home, "funding.sqlite"));
	f.sessions.funding = funding;
	t.after(async () => {
		await funding.close();
		await f.close();
	});
	await funding.setEnabled((await funding.read()).revision, false);
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const selection = await (
		await fetch(`${f.root}/api/projects/${f.project.id}/chat-profile?mode=build`, { headers })
	).json();
	assert.equal(selection.allowanceMicros, undefined);
	assert.equal(selection.fundingRequired, undefined);
	const draftId = randomUUID(),
		payload = JSON.stringify({ ...selection, purpose: "native-chat-create", draftId, message: "Fix the parser" });
	const receipt = await (
		await fetch(`${f.root}/api/operations`, {
			method: "POST",
			headers,
			body: JSON.stringify({
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
			}),
		})
	).json();
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal(f.sessions.fundingRequired(receipt.result.sessionId), false);
	assert.equal((await funding.read()).accountCount, 0);
});
