import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { Funding } from "./funding.ts";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";
import { payloadHash } from "./operation-journal.ts";
import type { SessionWorker } from "./sessions.ts";

test("native recovery keeps the owning chat and exact corrected words; receipt lookup never resends", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const chat = await f.sessions.spawnDurable(
		{ projectId: f.project.id, mode: "build", message: "Original goal" },
		randomUUID(),
		randomUUID(),
	);
	// A failed cold worker, not a fabricated successful run. No provider is opened.
	// biome-ignore lint/complexity/useLiteralKeys: lifecycle fixture
	const meta = f.sessions["metas"].get(chat.id)!;
	Object.assign(meta, {
		outcome: "failed",
		fundingId: "original-allowance",
		outcomeReason: "Provider unavailable",
		pending: [],
		working: false,
		initializing: undefined,
	});
	const before = { cwd: meta.cwd, projectId: meta.projectId, fundingId: meta.fundingId };
	const payload = JSON.stringify({
		purpose: "chat-recover",
		sessionId: chat.id,
		message: "  Corrected scope\nKeep the original work. 🐦  ",
		updatedAt: meta.updatedAt,
		inputGeneration: meta.inputGeneration ?? 0,
	});
	const op: DurableOperation = {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: { ...f.host, hostId: "local" },
		destination: f.host,
		kind: "chat-recover",
		targetId: chat.id,
		payload,
		payloadHash: payloadHash(payload),
		bindingId: "0".repeat(64),
		bindingGeneration: 1,
	};
	const post = async (receipt = false) => {
		const r = await fetch(`${f.root}/api/operations${receipt ? "/receipt" : ""}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pilot-github-capability": f.capability },
			body: JSON.stringify(op),
		});
		assert.equal(r.status, 200);
		return r.json();
	};
	const ack = await post();
	assert.equal(ack.state, "accepted", JSON.stringify(ack));
	assert.deepEqual(await post(true), ack);
	assert.deepEqual(await post(), ack);
	const saved = JSON.parse(await readFile(join(f.home, "sessions", chat.id, "meta.json"), "utf8"));
	assert.deepEqual({ cwd: saved.cwd, projectId: saved.projectId, fundingId: saved.fundingId }, before);
	assert.deepEqual(
		saved.pending.map((p: { content: string }) => p.content),
		[JSON.parse(payload).message],
	);
	assert.equal(f.stats().sessions, 1);
	assert.equal(f.stats().external, 0);
});

async function failedChat(t: TestContext) {
	const f = await nativeIntakeFixture();
	const beforeClose: Array<() => Promise<void>> = [];
	t.after(async () => {
		for (const close of beforeClose) await close();
		await f.close();
	});
	const chat = await f.sessions.spawnDurable(
		{ projectId: f.project.id, message: "Original context" },
		randomUUID(),
		randomUUID(),
	);
	// biome-ignore lint/complexity/useLiteralKeys: saved lifecycle fixture, no provider
	const meta = f.sessions["metas"].get(chat.id)!;
	Object.assign(meta, { outcome: "failed", pending: [], working: false, initializing: undefined });
	const operation = (message = "", updatedAt = meta.updatedAt): DurableOperation => {
		const payload = JSON.stringify({
			purpose: "chat-recover",
			sessionId: chat.id,
			message,
			updatedAt,
			inputGeneration: meta.inputGeneration ?? 0,
		});
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.host, hostId: "local" },
			destination: f.host,
			kind: "chat-recover",
			targetId: chat.id,
			payload,
			payloadHash: payloadHash(payload),
			bindingId: "0".repeat(64),
			bindingGeneration: 1,
		};
	};
	const post = async (op: DurableOperation, lookup = false) => {
		const r = await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pilot-github-capability": f.capability },
			body: JSON.stringify(op),
		});
		assert.equal(r.status, 200);
		return r.json();
	};
	return { ...f, chat, meta, operation, post, beforeClose };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("lost recovery ACK never resends queued input or infers kernel acceptance", async (t) => {
	const f = await failedChat(t);
	const send = f.sessions.sendDurable.bind(f.sessions);
	let sends = 0;
	f.sessions.sendDurable = async (...args) => {
		sends++;
		await send(...args);
		throw new Error("Lost recovery ACK");
	};
	const op = f.operation("Keep my files");
	assert.equal((await f.post(op)).state, "pending");
	assert.equal((await f.post(op, true)).state, "pending");
	assert.equal((await f.post(op)).state, "pending");
	assert.equal(sends, 1);
	assert.equal(f.meta.pending?.length, 1);
});

test("stale recovery, changes during preservation, and archived targets never admit input", async (t) => {
	const f = await failedChat(t);
	assert.equal((await f.post(f.operation("", f.meta.updatedAt - 1))).state, "rejected");
	const preserve = f.sessions.preserveWorkingContext.bind(f.sessions);
	f.sessions.preserveWorkingContext = async (id) => {
		await preserve(id);
		f.meta.updatedAt++;
	};
	assert.equal((await f.post(f.operation("Correct only the parser"))).state, "rejected");
	assert.equal(f.meta.pending?.length, 0);
	await f.sessions.archive(f.chat.id);
	assert.equal((await f.post(f.operation())).state, "rejected");
	assert.equal(f.meta.pending?.length, 0);
});

test("a newer Stop generation refuses displayed recovery even when the wall-clock timestamp is unchanged", async (t) => {
	const f = await failedChat(t);
	const op = f.operation("Original correction");
	f.meta.inputGeneration = (f.meta.inputGeneration ?? 0) + 1;
	assert.equal((await f.post(op)).state, "rejected");
	assert.equal(f.meta.pending?.length, 0);
});

test("startup retry commits its own admission before a lost ACK and keeps the original outbox", async (t) => {
	const f = await failedChat(t);
	f.meta.failure = "Session startup: worker disconnected";
	f.meta.pending = [{ type: "input", requestId: "original-input", content: "Original work", mode: "followUp" }];
	const original = structuredClone(f.meta.pending);
	const retry = f.sessions.retryStartup.bind(f.sessions);
	let retries = 0;
	f.sessions.retryStartup = async (...args) => {
		retries++;
		await retry(...args);
		throw new Error("Lost startup ACK");
	};
	const op = f.operation();
	assert.equal((await f.post(op)).state, "pending");
	assert.equal(await f.sessions.startupRecoveryAdmitted(f.chat.id, op.operationId), true);
	assert.equal((await f.post(op, true)).state, "accepted");
	assert.equal((await f.post(op)).state, "accepted");
	assert.equal(retries, 1);
	assert.deepEqual(f.meta.pending, original);
});

test("startup recovery rechecks the displayed failure after preservation I/O", async (t) => {
	const f = await failedChat(t);
	f.meta.failure = "Session startup: worker disconnected";
	const preserve = f.sessions.preserveWorkingContext.bind(f.sessions);
	f.sessions.preserveWorkingContext = async (id) => {
		await preserve(id);
		f.meta.updatedAt++;
	};
	assert.equal((await f.post(f.operation())).state, "rejected");
	assert.equal(f.meta.failure, "Session startup: worker disconnected");
	assert.equal(f.meta.startupRecoveryOperationId, undefined);
});

test("explicit recovery applies a saved next-attempt model without a new chat or allowance", async (t) => {
	const f = await failedChat(t);
	f.meta.nextAttemptModel = { model: "fake/replacement", thinking: "high" };
	f.meta.outcomeAt = 300;
	f.meta.fundingId = "original-allowance";
	const cwd = f.meta.cwd;
	const op = f.operation("  Correct only CSV. 🐦  ");
	assert.equal((await f.post(op)).state, "accepted");
	assert.equal((await f.post(op, true)).state, "accepted");
	assert.equal((await f.post(op)).state, "accepted");
	assert.deepEqual(f.meta.recoveryModel, { model: "fake/replacement", thinking: "high" });
	assert.equal(f.meta.cwd, cwd);
	assert.equal(f.meta.fundingId, "original-allowance");
	assert.deepEqual(
		f.meta.pending?.map((p) => (p.type === "input" ? p.content : "")),
		["  Correct only CSV. 🐦  "],
	);
});

test("stale saved-model recovery neither activates its preference nor closes the old worker", async (t) => {
	const f = await failedChat(t);
	f.meta.outcomeAt = 300;
	f.meta.nextAttemptModel = { model: "fake/replacement" };
	let closed = 0;
	const worker: SessionWorker = {
		ready: Promise.resolve(),
		state: "idle",
		busy: false,
		send() {},
		async request() {},
		async close() {
			closed++;
		},
	};
	// biome-ignore lint/complexity/useLiteralKeys: lifecycle fixture for the existing worker boundary
	f.sessions["workers"].set(f.chat.id, worker);
	const preserve = f.sessions.preserveWorkingContext.bind(f.sessions);
	f.sessions.preserveWorkingContext = async (id) => {
		await preserve(id);
		f.meta.updatedAt++;
	};
	assert.equal((await f.post(f.operation("Correct the original scope"))).state, "rejected");
	assert.equal(f.meta.recoveryModel, undefined);
	assert.equal(closed, 0);
});

test("recovery does not reopen or refill an exhausted real lifetime allowance", async (t) => {
	const f = await failedChat(t);
	const funding = new Funding(join(f.home, "funding.sqlite"));
	f.sessions.funding = funding;
	f.beforeClose.push(() => funding.close());
	const owner = { kind: "quick_fix" as const, id: f.chat.id, projectId: f.project.id };
	await funding.open(owner, 220);
	const quote = {
		provider: "fixture",
		model: "bounded",
		inputTokens: 100,
		outputTokens: 10,
		rate: { input: 1_000_000, output: 2_000_000, cacheRead: 100_000, cacheWrite: 2_000_000 },
	};
	await funding.reserve(owner, "lost-request", quote);
	f.meta.fundingId = f.chat.id;
	f.meta.fundingRequired = true;
	const before = (await funding.read()).accounts;
	assert.equal(before[0]?.remainingMicros, 0);
	const op = f.operation("Continue only within the remaining allowance");
	assert.equal((await f.post(op)).state, "accepted");
	assert.equal((await f.post(op, true)).state, "accepted");
	assert.deepEqual((await funding.read()).accounts, before);
	await assert.rejects(funding.reserve(owner, "recovery-request", quote), /cannot fund/);
});

test("an older queued lifecycle write cannot publish startup admission without its retry state", async (t) => {
	const f = await failedChat(t);
	f.meta.failure = "Session startup: worker disconnected";
	const beforeOld = deferred();
	const beforeRetry = deferred();
	const retryReady = deferred();
	// biome-ignore lint/complexity/useLiteralKeys: exercise the existing metadata FIFO boundary
	f.sessions["saving"].set(f.chat.id, beforeOld.promise);
	// biome-ignore lint/complexity/useLiteralKeys: capture the old lifecycle snapshot before retry mutates state
	const oldWrite = f.sessions["save"](f.meta);
	// biome-ignore lint/complexity/useLiteralKeys: stop before the retry snapshot enters the writer
	const save = f.sessions["save"].bind(f.sessions);
	// biome-ignore lint/complexity/useLiteralKeys: deterministic crash-boundary fixture
	f.sessions["save"] = async (...args) => {
		if (args[0].startupRecoveryOperationId) {
			retryReady.resolve();
			await beforeRetry.promise;
		}
		return save(...args);
	};
	const opId = randomUUID();
	const retry = f.sessions.retryStartup(f.chat.id, { operationId: opId, admissionGuard() {} });
	await retryReady.promise;
	beforeOld.resolve();
	let saved: { startupRecoveryOperationId?: string; failure?: string };
	try {
		await oldWrite;
		saved = JSON.parse(await readFile(join(f.home, "sessions", f.chat.id, "meta.json"), "utf8"));
	} finally {
		beforeRetry.resolve();
		await retry;
	}
	assert.equal(saved.startupRecoveryOperationId, undefined);
	assert.equal(saved.failure, "Session startup: worker disconnected");
	assert.equal(await f.sessions.startupRecoveryAdmitted(f.chat.id, opId), true);
});
