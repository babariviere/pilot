import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { readInputCausality } from "./snapshot.ts";
import { openSessionStorage } from "./storage.ts";

test("cold causal reads keep exact input/answer identities and late state without running work", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-input-links-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const owned = await openSessionStorage(directory);
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context);
		const ids = await root.commit(async (tx) => {
			const first = await tx.createSubmission({
				conversationId: root.id,
				requestId: "first",
				type: "input",
				status: "queued",
			});
			const second = await tx.createSubmission({
				conversationId: root.id,
				requestId: "second",
				type: "input",
				status: "queued",
			});
			const firstEntry = await tx.appendEntry(root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "Topic A", timestamp: 1 }],
			});
			const secondEntry = await tx.appendEntry(root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "Topic B", timestamp: 2 }],
			});
			tx.placeSubmission(first.id, firstEntry.id);
			tx.placeSubmission(second.id, secondEntry.id);
			const answer = await tx.appendEntry(root.id, {
				kind: "pi.assistant",
				model: [fauxAssistantMessage("Both topics")],
			});
			tx.settleSubmission(first.id, { status: "done", answer: answer.id });
			tx.settleSubmission(second.id, { status: "done", answer: answer.id });
			const late = await tx.createSubmission({
				conversationId: root.id,
				requestId: "late",
				type: "input",
				status: "queued",
			});
			const stopped = await tx.createSubmission({
				conversationId: root.id,
				requestId: "stopped",
				type: "input",
				status: "queued",
			});
			tx.settleSubmission(stopped.id, { status: "unanswered", reason: "aborted" });
			await tx.createSubmission({
				conversationId: root.id,
				requestId: "passive-write",
				type: "write",
				status: "queued",
			});
			return { firstEntry, secondEntry, answer, late };
		}, context);
		assert.deepEqual(await readInputCausality(directory, [Number(ids.answer.id)], []), [
			{ requestId: "first", entryId: Number(ids.firstEntry.id), answerId: Number(ids.answer.id), status: "done" },
			{ requestId: "second", entryId: Number(ids.secondEntry.id), answerId: Number(ids.answer.id), status: "done" },
		]);
		assert.deepEqual(await readInputCausality(directory, [], ["late", "stopped", "passive-write"]), [
			{ requestId: "late", status: "queued" },
			{ requestId: "stopped", status: "unanswered" },
		]);
		const lateEntry = await root.commit(async (tx) => {
			const entry = await tx.appendEntry(root.id, { kind: "pi.user" });
			tx.placeSubmission(ids.late.id, entry.id);
			return entry;
		}, context);
		assert.deepEqual(await readInputCausality(directory, [Number(lateEntry.id)], []), [
			{ requestId: "late", entryId: Number(lateEntry.id), status: "placed" },
		]);
		await root.commit(async (tx) => {
			tx.settleSubmission(ids.late.id, { status: "done", answer: ids.answer.id });
		}, context);
		// Exercise the real worker branch while another process owns the writer lease.
		const worker = new Worker(new URL("./snapshot-worker.ts", import.meta.url), {
			workerData: {
				directory,
				cwd: directory,
				inputCausality: { entryIds: [Number(lateEntry.id)], requestIds: [] },
			},
		});
		t.after(() => worker.terminate());
		const reply = await new Promise<{ view?: { inputCausality: unknown }; error?: string }>((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
			worker.once("exit", (code) => {
				if (code !== 0) reject(new Error(`Reader exited ${code}`));
			});
		});
		assert.equal(reply.error, undefined);
		assert.deepEqual(reply.view?.inputCausality, [
			{ requestId: "late", entryId: Number(lateEntry.id), answerId: Number(ids.answer.id), status: "done" },
		]);
		assert.deepEqual(await readInputCausality(directory, [], ["missing"]), []);
		// A long chat keeps its submissions. Read only matching metadata even when it has 10,000 older inputs.
		await root.commit(async (tx) => {
			for (let i = 0; i < 10_000; i++) {
				const input = await tx.createSubmission({
					conversationId: root.id,
					requestId: `older-${i}`,
					type: "input",
					status: "queued",
				});
				tx.settleSubmission(input.id, { status: "unanswered", reason: "aborted" });
			}
		}, context);
		const started = performance.now();
		assert.deepEqual(await readInputCausality(directory, [], ["late"]), [
			{ requestId: "late", entryId: Number(lateEntry.id), answerId: Number(ids.answer.id), status: "done" },
		]);
		t.diagnostic(
			`Cold causality, 10,000 older inputs: ${Math.round(performance.now() - started)} ms, one result, no message bodies`,
		);
		await assert.rejects(readInputCausality(join(directory, "missing"), [1], []), /unavailable/);
		await assert.rejects(readInputCausality(directory, [0], []), /Invalid/);
	} finally {
		await harness.close(context);
		await owned.storage.close(context);
		owned.release();
	}
});
