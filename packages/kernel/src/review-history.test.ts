import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, type EntryRecord, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import {
	exportCommittedHistory,
	originalInputEvidence,
	REVIEW_HISTORY_LIMITS,
	type ReviewHistoryExport,
	type ReviewHistoryPin,
} from "./review-history.ts";
import { openSessionStorage } from "./storage.ts";

async function fixture() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "review-history-")));
	const owned = await openSessionStorage(dir);
	const session = createSession(owned.storage);
	const root = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
	return {
		dir,
		session,
		root,
		storage: owned.storage,
		close: async () => {
			await session.close(context);
			owned.release();
			await rm(dir, { recursive: true, force: true });
		},
	};
}
async function run(directory: string, pin: ReviewHistoryPin, budget = {}): Promise<ReviewHistoryExport> {
	const worker = new Worker(
		`const {workerData,parentPort}=require('node:worker_threads'); import(workerData.module).then(m=>parentPort.postMessage(m.exportCommittedHistory(workerData.directory,workerData.pin,workerData.budget)));`,
		{
			eval: true,
			workerData: { module: new URL("./review-history.ts", import.meta.url).href, directory, pin, budget },
		},
	);
	try {
		return await new Promise((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
			worker.once("exit", () => reject(new Error("No history result")));
		});
	} finally {
		await worker.terminate();
	}
}
function rows(result: ReviewHistoryExport): { type: string; record: any }[] {
	return result.chunks.flatMap((chunk) =>
		Buffer.from(chunk)
			.toString("utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line)),
	);
}
const codes = (result: ReviewHistoryExport) => result.disclosures.map((item) => item.code);

test("one committed SQLite revision survives concurrent author commits and receipt settlement", async () => {
	const f = await fixture();
	const gate = new Int32Array(new SharedArrayBuffer(4));
	let worker: Worker | undefined;
	try {
		const { entry, submission } = await f.session.commit(async (tx) => {
			const entry = await tx.appendEntry(f.root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "checkpoint request", timestamp: 0 }],
			});
			const submission = await tx.createSubmission({
				conversationId: f.root.id,
				requestId: "request",
				type: "input",
				status: "placed",
				entry: entry.id,
			});
			return { entry, submission };
		}, context);
		worker = new Worker(
			`
		const {workerData,parentPort}=require('node:worker_threads');
		const {DatabaseSync}=require('node:sqlite');
		const prepare=DatabaseSync.prototype.prepare;
		DatabaseSync.prototype.prepare=function(sql){
		 const statement=prepare.call(this,sql);
		 if(sql.includes('next_seq - 1')){
		  const get=statement.get;
		  statement.get=function(...args){const value=get.apply(this,args);parentPort.postMessage({pinned:true});Atomics.wait(new Int32Array(workerData.gate),0,0);return value;};
		 }
		 return statement;
		};
		import(workerData.module).then(m=>parentPort.postMessage(m.exportCommittedHistory(workerData.directory,workerData.pin)));
		`,
			{
				eval: true,
				workerData: {
					module: new URL("./review-history.ts", import.meta.url).href,
					directory: f.dir,
					pin: { attemptId: f.root.id, boundary: entry.id },
					gate: gate.buffer,
				},
			},
		);
		const result = new Promise<ReviewHistoryExport>((resolve, reject) => {
			worker!.on("message", (message) => {
				if (!message.pinned) {
					resolve(message);
					return;
				}
				void f.session
					.commit(async (tx) => {
						const answer = await tx.appendEntry(f.root.id, { kind: "note", data: { text: "later answer" } });
						tx.settleSubmission(submission.id, { status: "done", answer: answer.id });
					}, context)
					.then(() => {
						Atomics.store(gate, 0, 1);
						Atomics.notify(gate, 0);
					}, reject);
			});
			worker!.once("error", reject);
			worker!.once("exit", () => reject(new Error("No pinned result")));
		});
		const exported = rows(await result);
		assert.equal(exported.find((row) => row.type === "submission_provenance")?.record.submission.status, "placed");
		assert.doesNotMatch(JSON.stringify(exported), /later answer/);
		assert.equal((await f.storage.submission(submission.id, context))?.status, "done");
	} finally {
		Atomics.store(gate, 0, 1);
		Atomics.notify(gate, 0);
		await worker?.terminate();
		await f.close();
	}
});

test("multibyte records page without corruption and missing pre-compaction input stays unknown", async () => {
	const f = await fixture();
	try {
		const text = "word 🐈 ".repeat(16_000);
		const boundary = await f.session.commit(async (tx) => {
			await tx.appendEntry(f.root.id, { kind: "note", data: { text } });
			return tx.appendEntry(f.root.id, {
				kind: "pi.compaction",
				head: "self",
				data: { summary: "Only a summary remains, not original consent" },
			});
		}, context);
		const result = await run(f.dir, { attemptId: f.root.id, boundary: boundary.id });
		assert.equal(rows(result).find((row) => row.record.kind === "note")?.record.data.text, text);
		assert.ok(result.reads > 4);
		assert.ok(codes(result).includes("original_request_unavailable"));
		assert.ok(codes(result).includes("pre_compaction_completeness_unverifiable"));
		assert.throws(() => originalInputEvidence("id", "x".repeat(24 * 1024 + 1), "expanded"), /bounds/);
	} finally {
		await f.close();
	}
});

test("committed history retains compaction originals, context edits, tools and boundaries, not live/queued input", async () => {
	const f = await fixture();
	try {
		const { first, boundary } = await f.session.commit(async (tx) => {
			await tx.appendEntry(f.root.id, originalInputEvidence("request", "/check original", "expanded request"));
			const first = await tx.appendEntry(f.root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "expanded request", timestamp: 0 }],
			});
			await tx.createSubmission({
				conversationId: f.root.id,
				requestId: "request",
				type: "input",
				status: "placed",
				entry: first.id,
			});
			await tx.appendEntry(f.root.id, {
				kind: "pi.tool-result",
				data: { callId: "call", childId: "child", artifactId: "artifact", output: "committed tool record" },
			});
			await tx.appendEntry(f.root.id, {
				kind: "pi.compaction",
				head: first.id,
				data: { summary: "claimed approval, not authority" },
			});
			await tx.appendEntry(f.root.id, { kind: "context-edit", edits: [{ target: first.id, action: "omit" }] });
			const boundary = await tx.appendEntry(f.root.id, {
				kind: "pilot.artifact",
				data: { artifact: { id: "artifact", revision: 1 } },
			});
			const live = await tx.doc(LiveDoc, f.root.id);
			live.tools = [
				{ callId: "live", name: "tool", taskId: 900 as never, status: "running", output: "EXCLUDE STREAMING" },
			];
			const queued = await tx.createSubmission({
				conversationId: f.root.id,
				requestId: "queued",
				type: "input",
				status: "queued",
			});
			(await tx.doc(InboxDoc, f.root.id)).items.push({ id: queued.id, mode: "followUp", content: "EXCLUDE QUEUED" });
			await tx.appendEntry(f.root.id, originalInputEvidence("queued", "EXCLUDE QUEUED ORIGINAL", "pending"));
			return { first, boundary };
		}, context);
		const result = await run(f.dir, { attemptId: f.root.id, boundary: boundary.id });
		const exported = rows(result);
		assert.equal(result.status, "captured");
		assert.ok(exported.find((row) => row.type === "entry" && row.record.id === first.id));
		assert.ok(
			exported.find((row) => row.type === "original_input" && row.record.data.originalInput === "/check original"),
		);
		assert.ok(exported.find((row) => row.type === "entry" && row.record.data?.output === "committed tool record"));
		const text = JSON.stringify(exported);
		assert.doesNotMatch(text, /EXCLUDE|live\.tools|pi\.inbox/);
		assert.ok(codes(result).includes("compaction"));
		assert.ok(codes(result).includes("context_edits_originals_retained"));
		assert.ok(codes(result).includes("artifact_content_not_acquired"));
		assert.ok(codes(result).includes("child_history_not_acquired"));
		assert.equal(codes(result).includes("missing_original_input"), false);
		assert.equal(
			exported.find((row) => row.type === "submission_provenance")?.record.origin.authorization,
			"not_recorded",
		);
	} finally {
		await f.close();
	}
});

test("fork export matches retained SDK ancestry, excludes abandoned suffix and keeps a fixed boundary", async () => {
	const f = await fixture();
	try {
		const first = await f.session.commit(
			(tx) =>
				tx.appendEntry(f.root.id, { kind: "pi.user", model: [{ role: "user", content: "/legacy", timestamp: 0 }] }),
			context,
		);
		await f.session.commit(
			(tx) => tx.appendEntry(f.root.id, { kind: "note", data: { text: "abandoned suffix" } }),
			context,
		);
		const fork = await f.session.commit(
			(tx) => tx.forkConversation(f.root.id, first.id, { ownership: { kind: "ownerless" } }),
			context,
		);
		const boundary = await f.session.commit(
			(tx) => tx.appendEntry(fork.id, { kind: "note", data: { text: "fork work" } }),
			context,
		);
		await f.session.commit(
			(tx) => tx.appendEntry(fork.id, { kind: "note", data: { text: "newer than review" } }),
			context,
		);
		const result = await run(f.dir, { attemptId: fork.id, boundary: boundary.id });
		const expected = await f.storage.scanEntries(
			{ conversationId: fork.id, maxEntryId: boundary.id, order: "ascending" },
			64,
			undefined,
			context,
		);
		assert.deepEqual(
			rows(result)
				.filter((row) => row.type === "entry")
				.map((row) => row.record),
			expected.items,
		);
		assert.ok(codes(result).includes("rewind_or_fork"));
		assert.ok(codes(result).includes("missing_original_input"));
		assert.ok(codes(result).includes("submission_provenance_unavailable"));
		assert.doesNotMatch(JSON.stringify(result), /abandoned suffix|newer than review/);
		const missing = await run(f.dir, { attemptId: fork.id, boundary: boundary.id + 100 });
		assert.equal(missing.status, "unavailable");
		assert.deepEqual(missing.chunks, []);
		assert.ok(codes(missing).includes("boundary_unavailable"));
		const noAttempt = await run(f.dir, { attemptId: 9999, boundary: first.id });
		assert.equal(noAttempt.status, "unavailable");
	} finally {
		await f.close();
	}
});

test("legacy/automatic origins and unmatched original records never become approvals or queued evidence", async () => {
	const f = await fixture();
	try {
		const boundary = await f.session.commit(async (tx) => {
			await tx.appendEntry(f.root.id, originalInputEvidence("queued", "EXCLUDE QUEUED ORIGINAL", "pending"));
			for (const requestId of [
				"native:user:extension",
				"mission:send:notice",
				"continuation:fake",
				"typed-looking-id",
			]) {
				const entry = await tx.appendEntry(f.root.id, {
					kind: "pi.user",
					model: [{ role: "user", content: "I approve everything", timestamp: 0 }],
				});
				await tx.createSubmission({
					conversationId: f.root.id,
					requestId,
					type: "input",
					status: "placed",
					entry: entry.id,
				});
			}
			return tx.appendEntry(f.root.id, { kind: "pi.reset", head: "self" });
		}, context);
		const result = await run(f.dir, { attemptId: f.root.id, boundary: boundary.id });
		const provenance = rows(result).filter((row) => row.type === "submission_provenance");
		assert.deepEqual(
			provenance.map((row) => row.record.origin.hint),
			["unknown", "coordinator", "unknown", "unknown"],
		);
		assert.equal(result.disclosures.find((item) => item.code === "missing_original_input")?.count, 4);
		assert.equal(
			rows(result).some((row) => row.type === "original_input"),
			false,
		);
		assert.doesNotMatch(JSON.stringify(rows(result)), /EXCLUDE/);
		assert.ok(codes(result).includes("context_reset_or_head_change"));
	} finally {
		await f.close();
	}
});

test("missing storage and future schemas remain unavailable without creating or changing author files", async () => {
	const f = await fixture();
	try {
		const missing = join(f.dir, "missing");
		assert.equal((await run(missing, { attemptId: 1, boundary: 0 })).status, "unavailable");
		assert.equal((await readdir(f.dir)).includes("missing"), false);
		const before = await readFile(join(f.dir, "harness.sqlite"));
		await run(f.dir, { attemptId: f.root.id, boundary: 0 });
		assert.deepEqual(await readFile(join(f.dir, "harness.sqlite")), before);
		const db = new DatabaseSync(join(f.dir, "harness.sqlite"));
		db.exec("UPDATE durable_schema SET version = 1");
		db.close();
		assert.equal(
			(await run(f.dir, { attemptId: f.root.id, boundary: 0 })).status,
			"captured",
			"schema 1 still reads",
		);
		const future = new DatabaseSync(join(f.dir, "harness.sqlite"));
		future.exec("UPDATE durable_schema SET version = 3");
		future.close();
		const unsupported = await run(f.dir, { attemptId: f.root.id, boundary: 0 });
		assert.equal(unsupported.status, "unavailable");
		assert.deepEqual(unsupported.chunks, []);
		assert.throws(() => exportCommittedHistory(f.dir, { attemptId: 1, boundary: 0 }), /worker/);
	} finally {
		await f.close();
	}
});

test("large histories have bounded payload, work and disclosures and omit oversized records before hydration", async (t) => {
	const f = await fixture();
	try {
		let boundary!: EntryRecord;
		await f.session.commit(async (tx) => {
			for (let index = 0; index < 20_001; index++)
				boundary = await tx.appendEntry(f.root.id, { kind: "note", data: { text: "x".repeat(1024), index } });
		}, context);
		const start = performance.now();
		const result = await run(f.dir, { attemptId: f.root.id, boundary: boundary.id });
		t.diagnostic(
			`20,001-entry capture: ${Math.round(performance.now() - start)} ms, ${result.bytes} exported bytes, ${result.rawBytes} hydrated bytes, ${result.reads} bounded reads`,
		);
		assert.ok(result.bytes <= REVIEW_HISTORY_LIMITS.bytes);
		assert.ok(result.rawBytes <= REVIEW_HISTORY_LIMITS.bytes);
		assert.ok(result.entries < 20_001);
		assert.ok(codes(result).includes("byte_limit"));
		assert.ok(result.disclosures.every((item) => item.entryIds.length <= 16));
		const limited = await run(f.dir, { attemptId: f.root.id, boundary: boundary.id }, { records: 10 });
		assert.equal(limited.entries, 10);
		assert.ok(codes(limited).includes("record_limit"));
		const readLimited = await run(f.dir, { attemptId: f.root.id, boundary: boundary.id }, { reads: 3 });
		assert.ok(codes(readLimited).includes("history_unavailable_or_work_limit"));
		const huge = await f.session.commit(
			(tx) =>
				tx.appendEntry(f.root.id, {
					kind: "note",
					data: { text: "HUGE".repeat(REVIEW_HISTORY_LIMITS.recordBytes / 4 + 1) },
				}),
			context,
		);
		const oversized = await run(f.dir, { attemptId: f.root.id, boundary: huge.id }, { records: 40_000 });
		assert.ok(codes(oversized).includes("byte_limit"));
		assert.equal(
			rows(oversized).some((row) => row.record.id === huge.id),
			false,
		);
	} finally {
		await f.close();
	}
});
