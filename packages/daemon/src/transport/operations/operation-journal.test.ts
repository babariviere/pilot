import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation, OperationHost } from "@pilot/protocol";
import { payloadHash } from "../../runtime/contracts/canonical.ts";
import { OperationConflict, OperationExpired, OperationJournal, OperationRejected } from "./operation-journal.ts";

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
test("an unknown outcome is noted once; recovery at the next start does not log the same outcome again", async (t) => {
	const f = await fixture(t);
	const op = operation();
	const file = join(f.directory, `${payloadHash(op.operationId)}.json`);
	const lost = async () => {
		throw new Error("Unknown admission; no replay");
	};
	assert.equal((await f.journal.execute(op, lost)).state, "pending");
	const saved = JSON.parse(await readFile(file, "utf8"));
	assert.equal(saved.unknown, "Error: Unknown admission; no replay");
	assert.equal("unknown" in (await f.journal.lookup(op))!, false, "the note is never part of the receipt");
	const written = (await stat(file)).ino;
	const restarted = new OperationJournal(f.directory, destination);
	await restarted.recover(lost);
	assert.equal((await stat(file)).ino, written, "the same unknown outcome is not written or logged again");
	await restarted.recover(async () => {
		throw new Error("Another reason");
	});
	assert.equal(JSON.parse(await readFile(file, "utf8")).unknown, "Error: Another reason");
	assert.equal((await restarted.lookup(op))!.state, "pending");
});

test("acquired cold reader sees saved originals and synchronously observes later reservations", async (t) => {
	const { directory, journal } = await fixture(t);
	const saved = operation();
	await journal.execute(saved, async () => {
		throw new Error("Exact unknown outcome");
	});
	const original = await readFile(join(directory, `${payloadHash(saved.operationId)}.json`), "utf8");
	const reopened = new OperationJournal(directory, destination);
	const read = await reopened.openReader(({ records, pendingKinds, failed }) => ({
		entries: [...records].map((record) => ({ id: record.operation.operationId, original: record.original() })),
		pendingKinds: [...pendingKinds],
		failed,
	}));
	assert.deepEqual(read(), { entries: [{ id: saved.operationId, original }], pendingKinds: [], failed: false });
	const later = operation(2);
	const pending = reopened.reserve(later);
	assert.deepEqual(read().pendingKinds, [later.kind], "an acquired reader sees reservation before its first await");
	await pending;
	assert.deepEqual(read().pendingKinds, []);
	assert.deepEqual(
		read().entries.map((entry) => entry.id),
		[saved.operationId, later.operationId],
	);
	assert.equal(read().entries[0]!.original, original);
});

test("an acquired reader sees a later persistence fault without reopening", async (t) => {
	const { directory, journal } = await fixture(t);
	await journal.reserve(operation());
	const failed = await journal.openReader((state) => state.failed);
	assert.equal(failed(), false);
	const blocked = operation(2);
	await mkdir(join(directory, `${payloadHash(blocked.operationId)}.json`));
	await assert.rejects(journal.reserve(blocked));
	assert.equal(failed(), true);
});

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

test("recovery finishes receipt deletion interrupted after replay-floor publication", async (t) => {
	const { directory, journal } = await fixture(t);
	const op = operation();
	await journal.execute(op, async () => null);
	const file = join(directory, `${payloadHash(op.operationId)}.json`);
	const original = await readFile(file);
	await journal.retire(origin, op.producerId, 1);
	await writeFile(file, original); // Simulate a crash-left retired record.
	const reopened = new OperationJournal(directory, destination);
	await assert.rejects(reopened.lookup(op), OperationExpired);
	assert.deepEqual(await readFile(file), original, "passive lookup never cleans up files");
	await reopened.recover(async () => null);
	await assert.rejects(readFile(file), { code: "ENOENT" });
	assert.equal((await reopened.reserve(operation(2))).state, "pending");
});

test("retained identity references are exact read-only observations, not resource or authority proof", async (t) => {
	const { directory, journal } = await fixture(t);
	const intent = (sequence: number, missionId = "m", kind = "insights-enable") => {
		const op = operation(sequence);
		const payload = JSON.stringify({ projectId: "p", missionId });
		return { ...op, kind, payload, payloadHash: payloadHash(payload) };
	};
	const pending = intent(1),
		accepted = intent(2, "m", "insights-create");
	await journal.reserve(pending);
	await journal.execute(accepted, async () => ({ sessionId: accepted.targetId }));
	await journal.execute(intent(3), async () => {
		throw new OperationRejected("refused before effects");
	});
	await journal.reserve(intent(4, "other"));
	await journal.reserve(intent(5, "m", "chat-create"));
	const rows = [pending, accepted];
	const before = await Promise.all(rows.map((op) => readFile(join(directory, `${payloadHash(op.operationId)}.json`))));
	assert.deepEqual(
		await journal.retainedTargets(["insights-create", "insights-enable"], { projectId: "p", missionId: "m" }),
		[pending.targetId, accepted.targetId],
	);
	assert.deepEqual(
		await journal.retainedTargets(
			["insights-create", "insights-enable"],
			{ projectId: "p", missionId: "m" },
			pending.operationId,
		),
		[accepted.targetId],
	);
	assert.deepEqual(await journal.retainedTargets(["insights-enable"], { projectId: "other", missionId: "m" }), []);
	assert.deepEqual(
		await Promise.all(rows.map((op) => readFile(join(directory, `${payloadHash(op.operationId)}.json`)))),
		before,
	);
});
