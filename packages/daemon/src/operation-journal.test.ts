import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation, OperationHost } from "@pilot/protocol";
import {
	OperationConflict,
	OperationExpired,
	OperationJournal,
	OperationRejected,
	payloadHash,
} from "./operation-journal.ts";

const origin: OperationHost = { hostId: "local", daemonId: "origin", lineageId: "original" };
const destination: OperationHost = { hostId: "devbox", daemonId: "target", lineageId: "history" };
function operation(sequence = 1): DurableOperation {
	const payload = JSON.stringify({ message: "hello" });
	return {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: "app",
		sequence,
		origin,
		destination,
		kind: "chat-create",
		targetId: randomUUID(),
		payload,
		payloadHash: payloadHash(payload),
	};
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const directory = await mkdtemp(join(tmpdir(), "pilot-operations-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return { directory, journal: new OperationJournal(directory, destination) };
}
test("reservation survives crash before admission, repeated acknowledgment loss returns one stable receipt", async (t) => {
	const { directory, journal } = await fixture(t);
	const op = operation();
	assert.equal((await journal.reserve(op)).state, "pending");
	let calls = 0;
	const reopened = new OperationJournal(directory, destination);
	const handler = async (intent: DurableOperation) => {
		calls++;
		return { sessionId: intent.targetId };
	};
	const receipts = await Promise.all(Array.from({ length: 20 }, () => reopened.execute(op, handler)));
	assert.equal(calls, 1);
	assert.ok(receipts.every((r) => r.state === "accepted" && r.targetId === op.targetId));
	assert.deepEqual(await new OperationJournal(directory, destination).lookup(op), receipts[0]);
	await reopened.execute(op, handler);
	assert.equal(calls, 1);
});
test("admission/receipt crash resumes the same operation ID and target, never a fresh session", async (t) => {
	const { directory, journal } = await fixture(t);
	const op = operation();
	const admitted = new Set<string>();
	const handler = async (intent: DurableOperation) => {
		admitted.add(intent.targetId + intent.operationId);
		throw new Error("process died after kernel reserved input");
	};
	assert.equal((await journal.execute(op, handler)).state, "pending");
	const reopened = new OperationJournal(directory, destination);
	await reopened.recover(async (intent) => {
		admitted.add(intent.targetId + intent.operationId);
		return { sessionId: intent.targetId };
	});
	assert.equal(admitted.size, 1);
	assert.equal((await reopened.lookup(op))?.state, "accepted");
});
test("payload, target, sequence, origin lineage and binding conflicts are not retries", async (t) => {
	const { journal } = await fixture(t);
	const op = operation();
	await journal.reserve(op);
	for (const changed of [
		{ ...op, payload: "{}" },
		{ ...op, targetId: randomUUID() },
		{ ...op, origin: { ...origin, lineageId: "restored" } },
		{ ...op, bindingId: "new", bindingGeneration: 2 },
		{ ...op, operationId: randomUUID() },
	])
		await assert.rejects(journal.reserve(changed), OperationConflict);
	await assert.rejects(
		journal.reserve({ ...op, destination: { ...destination, lineageId: "restored" } }),
		OperationConflict,
	);
});
test("pending is not rejected; explicit rejection is final and cannot acquire side effects on replay", async (t) => {
	const { journal } = await fixture(t);
	const op = operation();
	const receipt = await journal.execute(op, async () => {
		throw new OperationRejected("outside scope");
	});
	assert.equal(receipt.state, "rejected");
	await journal.execute(op, async () => {
		assert.fail("rejected intent replayed");
	});
});
test("durable retirement floors reject expired IDs after receipt cleanup/restart", async (t) => {
	const { directory, journal } = await fixture(t);
	const op = operation();
	await journal.reserve(op);
	await assert.rejects(journal.retire(origin, op.producerId, 1), OperationConflict);
	await journal.execute(op, async () => null);
	await journal.retire(origin, op.producerId, 1);
	const reopened = new OperationJournal(directory, destination);
	await assert.rejects(reopened.reserve(op), OperationExpired);
	await assert.rejects(reopened.reserve({ ...op, operationId: randomUUID() }), OperationExpired);
	assert.equal((await reopened.reserve(operation(2))).state, "pending");
});
test("receipt equality does not depend on JSON property order, payload hash is actual UTF-8 bytes", async (t) => {
	const { journal } = await fixture(t);
	const op = operation();
	await journal.reserve(op);
	const reordered = Object.fromEntries(Object.entries(op).reverse()) as unknown as DurableOperation;
	assert.equal((await journal.reserve(reordered)).state, "pending");
	const oversized = "雪".repeat(24 * 1024);
	await assert.rejects(
		journal.reserve({ ...operation(2), payload: oversized, payloadHash: payloadHash(oversized) }),
		OperationConflict,
	);
});
