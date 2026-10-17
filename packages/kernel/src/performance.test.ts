import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	PerformanceLog,
	type PerformanceRecord,
	performanceLine,
	preparePerformanceClear,
	RequestTiming,
	setPerformanceCollectionEnabled,
} from "./performance.ts";

function record(request = 1): PerformanceRecord {
	return {
		v: 1,
		request,
		at: 1000,
		source: "generation",
		outcome: "completed",
		preparationMs: 12,
		providerMs: 70,
		totalMs: 82,
		httpAttempts: 0,
	};
}

async function directory(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "pilot-performance-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("timings separate preparation, dispatch, headers, provider events and content with a monotonic clock", () => {
	let now = 100;
	const records: PerformanceRecord[] = [];
	const timing = new RequestTiming(
		{ record: (r) => records.push(r) },
		1,
		"generation",
		{ started: 100, at: 5000, toolFinished: 80 },
		() => now,
	);
	timing.mark("firstContentMs"); // No provider yet.
	now = 112;
	timing.providerStart();
	now = 116;
	timing.mark("payloadReadyMs");
	now = 120;
	timing.mark("httpDispatchMs");
	now = 130;
	timing.mark("responseHeadersMs");
	now = 140;
	timing.mark("firstProviderEventMs");
	now = 150;
	timing.mark("firstThinkingMs");
	timing.mark("firstContentMs");
	now = 160;
	timing.mark("firstTextMs");
	timing.mark("firstContentMs"); // Does not replace first content.
	now = 170;
	timing.mark("httpDispatchMs"); // Internal provider retry.
	now = 182;
	timing.finish("completed");
	timing.mark("firstToolCallMs");
	timing.finish("error");
	assert.deepEqual(records, [
		{
			...record(),
			at: 5000,
			toolToPreparationMs: 20,
			payloadReadyMs: 4,
			httpDispatchMs: 8,
			responseHeadersMs: 18,
			firstProviderEventMs: 28,
			firstThinkingMs: 38,
			firstContentMs: 38,
			firstTextMs: 48,
			httpAttempts: 2,
		},
	]);
});

test("failed preparation and aborts do not invent a provider response, and sink failures cannot fail a request", () => {
	const records: PerformanceRecord[] = [];
	const timing = new RequestTiming(
		{ record: (r) => records.push(r) },
		2,
		"generation",
		{ started: 10, at: 1000 },
		() => 15,
	);
	timing.finish("aborted");
	assert.deepEqual(records, [{ ...record(2), outcome: "aborted", preparationMs: 5, providerMs: 0, totalMs: 5 }]);
	assert.doesNotThrow(() =>
		new RequestTiming(
			{
				record: () => {
					throw new Error("private sink failure");
				},
			},
			3,
			"stream",
		).finish("error"),
	);
});

test("serialization whitelists numeric timings and enums, never labels, content, headers or errors", () => {
	const value = {
		...record(),
		prompt: "private prompt",
		toolOutput: "private output",
		provider: "private provider",
		model: "private model",
		error: "private failure",
		headers: { authorization: "private credential" },
		firstContentMs: Number.NaN,
		httpDispatchMs: -1,
		responseHeadersMs: Infinity,
	};
	const line = performanceLine(value)!;
	assert.doesNotMatch(line, /private|prompt|toolOutput|provider"|model|error"|headers|authorization/);
	assert.deepEqual(JSON.parse(line), record());
	assert.equal(performanceLine({ ...record(), source: "private source" as "stream" }), undefined);
	assert.equal(performanceLine({ ...record(), outcome: "private error" as "error" }), undefined);
	assert.ok(Number.isFinite(JSON.parse(performanceLine({ ...record(), totalMs: Number.MAX_VALUE })!).totalMs));
});

test("local logs rotate to two private capped segments and survive reopening", async (t) => {
	const dir = await directory(t);
	const file = join(dir, "performance.jsonl");
	for (let batch = 0; batch < 3; batch++) {
		const log = new PerformanceLog(file, { maxBytes: 2048 });
		for (let i = 0; i < 40; i++) log.record(record(batch * 40 + i));
		await log.close();
		log.record(record(999));
	}
	assert.deepEqual((await readdir(dir)).sort(), ["performance.jsonl", "performance.jsonl.1"]);
	for (const path of [file, `${file}.1`]) {
		const info = await stat(path);
		assert.ok(info.size <= 2048);
		assert.equal(info.mode & 0o777, 0o600);
		const lines = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.ok(lines.length);
		assert.ok(lines.every((r) => r.request < 120 && r.v === 1));
	}
});

test("queue overload drops records rather than blocking and reports loss on the next accepted record", async (t) => {
	const dir = await directory(t);
	const file = join(dir, "performance.jsonl");
	const log = new PerformanceLog(file, { maxPending: 2 });
	for (let i = 0; i < 5; i++) log.record(record(i));
	await log.flush();
	log.record(record(5));
	await log.close();
	const lines = (await readFile(file, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		lines.map((r) => r.request),
		[0, 1, 5],
	);
	assert.equal(lines[2].droppedBefore, 3);
});

test("unwritable paths and symlinks fail closed without affecting the caller or modifying a target", async (t) => {
	const dir = await directory(t);
	const missing = new PerformanceLog(join(dir, "missing", "performance.jsonl"));
	missing.record(record());
	await missing.close();
	const target = join(dir, "target");
	await writeFile(target, "untouched", { mode: 0o644 });
	const file = join(dir, "performance.jsonl");
	await symlink(target, file);
	const log = new PerformanceLog(file);
	log.record(record());
	await log.close();
	assert.equal(await readFile(target, "utf8"), "untouched");
	assert.equal((await stat(target)).mode & 0o777, 0o644);
});

test("a FIFO log path cannot hang the asynchronous writer or shutdown", { timeout: 5000 }, async (t) => {
	const dir = await directory(t);
	const file = join(dir, "performance.jsonl");
	execFileSync("mkfifo", [file]);
	const log = new PerformanceLog(file);
	log.record(record());
	await log.close();
	assert.ok((await stat(file)).isFIFO());
});

test("local consent and clear preparation stop records without blocking callers", async (t) => {
	const dir = await directory(t);
	t.after(() => setPerformanceCollectionEnabled(true));
	const file = join(dir, "performance.jsonl");
	const log = new PerformanceLog(file);
	setPerformanceCollectionEnabled(false);
	log.record(record(1));
	await preparePerformanceClear();
	await assert.rejects(readFile(file), { code: "ENOENT" });
	setPerformanceCollectionEnabled(true);
	log.record(record(2));
	await log.close();
	assert.equal(JSON.parse((await readFile(file, "utf8")).trim()).request, 2);
});
