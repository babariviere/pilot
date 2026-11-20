import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { nativeIntakeFixture } from "../day/intake/native-intake.fixture.ts";
import { payloadHash } from "../transport/operations/operation-journal.ts";

test("authenticated native schedule HTTP keeps exact receipts, stale fences and passive reads", async (t) => {
	const f = await nativeIntakeFixture({ schedules: true });
	t.after(() => f.close());
	const schedules = f.schedules;
	assert.ok(schedules);
	const target = await f.sessions.spawn({
		projectId: f.project.id,
		workspace: "direct",
		message: "Kept fixture agent",
	});
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const read = () => fetch(`${f.root}/api/schedule-controls`, { headers });
	const denied = await fetch(`${f.root}/api/schedule-controls`, { headers: { "x-pilot-github-capability": "wrong" } });
	assert.notEqual(denied.status, 200);
	await denied.arrayBuffer();
	const page = await (await read()).json();
	assert.equal(page.enabled, false);
	assert.equal(page.schedules.length, 0);
	assert.equal(
		page.targets.some((r: { id: string }) => r.id === target.id),
		true,
	);
	const make = (action: string, value: object, binding: string): DurableOperation => {
		const payload = JSON.stringify({
			purpose: "schedule-controls",
			draftId: randomUUID(),
			action,
			value,
			binding,
			page: 0,
		});
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.host, hostId: "local" },
			destination: f.host,
			kind: "schedule-controls",
			targetId: "global-schedules",
			payload,
			payloadHash: payloadHash(payload),
			bindingId: binding,
			bindingGeneration: 1,
		};
	};
	const post = (op: DurableOperation, lookup = false, token = f.capability) =>
		fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
			method: "POST",
			headers: { ...headers, "x-pilot-github-capability": token },
			body: JSON.stringify(op),
		});
	const op = make(
		"create",
		{
			title: "Check work",
			trigger: "at",
			at: Date.now() + 86400000,
			expiresAt: Date.now() + 172800000,
			target: { kind: "message", sessionId: target.id, message: "Check only the agreed work" },
		},
		page.binding,
	);
	const unauthorized = await post(op, false, "wrong");
	assert.notEqual(unauthorized.status, 200);
	await unauthorized.arrayBuffer();
	assert.equal(schedules.list().length, 0);
	// Discard the original response, then recover only the exact saved receipt.
	const lost = await post(op);
	assert.equal(lost.status, 200);
	await lost.arrayBuffer();
	const receipt = await (await post(op, true)).json();
	assert.equal(receipt.state, "accepted");
	assert.deepEqual(await (await post(op)).json(), receipt);
	assert.equal(schedules.list().length, 1);
	const id = receipt.result.scheduleId,
		original = schedules.require(id);
	assert.equal(original.target.kind, "message");
	assert.equal(original.state, "pending");
	const stale = make("update", { id, expectedRevision: original.revision, paused: true }, page.binding);
	assert.equal((await (await post(stale)).json()).state, "rejected");
	assert.equal(schedules.require(id).paused, undefined);
	const before = f.sessions.get(target.id);
	for (let i = 0; i < 3; i++) {
		const value = await (await read()).json();
		assert.equal(value.schedules[0].held, true);
		assert.equal(value.schedules[0].id, id);
	}
	assert.equal(f.sessions.get(target.id)?.updatedAt, before?.updatedAt);
	assert.equal(f.stats().sessions, 1);
	assert.equal(f.stats().external, 0);
	for (const paused of [true, false]) {
		const current = await (await read()).json(),
			row = schedules.require(id);
		assert.equal(
			(await (await post(make("update", { id, expectedRevision: row.revision, paused }, current.binding))).json())
				.state,
			"accepted",
		);
		assert.equal(!!schedules.require(id).paused, paused);
	}
	const current = await (await read()).json();
	assert.equal(
		(
			await (
				await post(make("cancel", { id, expectedRevision: schedules.require(id).revision }, current.binding))
			).json()
		).state,
		"accepted",
	);
	assert.equal(schedules.require(id).state, "cancelled");
	assert.deepEqual(schedules.require(id).target, original.target);
	const malformed = await post(make("create", { target: { kind: "chat", spawn: { cwd: "/" } } }, current.binding));
	assert.equal(malformed.status, 400);
	await malformed.arrayBuffer();
	assert.equal(schedules.list().length, 1);
});
