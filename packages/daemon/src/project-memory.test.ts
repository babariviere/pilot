// biome-ignore-all lint/complexity/useLiteralKeys: Inspect the private recall worker lifetime without widening the service API.
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { cover } from "./memory-cover.ts";
import { Conflict } from "./errors.ts";
import { MemoryDisk, RECORD_BYTES } from "./memory-disk.ts";
import { type MemorySummarizer, ProjectMemoryService } from "./project-memory.ts";

async function until(check: () => boolean) {
	const end = Date.now() + 5000;
	while (!check()) {
		assert.ok(Date.now() < end, "condition timed out");
		await delay(5);
	}
}
async function fixture(t: TestContext, summarize?: MemorySummarizer, retryBaseMs?: number) {
	const home = await mkdtemp(join(tmpdir(), "pilot-memory-"));
	const service = new ProjectMemoryService(home, summarize, retryBaseMs);
	t.after(async () => {
		await service.stop();
		await rm(home, { recursive: true, force: true });
	});
	return { home, service };
}
function build(disk: MemoryDisk) {
	for (;;) {
		const next = disk.next();
		if (!next) return;
		assert.ok(disk.put(next.lo, next.hi, next.epoch, `summary ${next.lo}-${next.hi}`));
	}
}

test("cover exactly tiles prefixes with aligned dyadic nodes, spending spare detail near the present", () => {
	assert.deepEqual(cover(0), []);
	assert.deepEqual(cover(4, 4), [
		[0, 1],
		[1, 2],
		[2, 3],
		[3, 4],
	]);
	assert.deepEqual(cover(16, 4), [
		[0, 8],
		[8, 12],
		[12, 14],
		[14, 16],
	]);
	for (const count of [7, 96, 97, 1000, 1_000_000, Number.MAX_SAFE_INTEGER]) {
		const nodes = cover(count, 96);
		assert.equal(nodes[0]?.[0], 0);
		assert.equal(nodes.at(-1)?.[1], count);
		assert.ok(nodes.length <= 96);
		for (let i = 0; i < nodes.length; i++) {
			const [lo, hi] = nodes[i]!,
				size = hi - lo;
			assert.equal(lo % size, 0);
			assert.ok(Number.isInteger(Math.log2(size)));
			if (i) assert.equal(nodes[i - 1]![1], lo);
		}
	}
	assert.ok(cover(1_000_000).at(-1)![1] - cover(1_000_000).at(-1)![0] === 1);
});

test("concurrent appends are serialized, durable, identified, and isolated by project", async (t) => {
	const { home, service } = await fixture(t);
	const entries = await Promise.all(Array.from({ length: 40 }, (_, i) => service.note("p", `note ${i} é🙂`, "chat")));
	assert.deepEqual(
		entries.map((e) => e.index),
		Array.from({ length: 40 }, (_, i) => i),
	);
	assert.equal(new Set(entries.map((e) => e.id)).size, 40);
	assert.equal(new Set(entries.map((e) => e.deviceId)).size, 1);
	await service.note("q", "other", "another-chat");
	assert.equal((await service.wake("q")).count, 1);
	assert.equal((await service.wake("p")).nodes.length, 40);
	await service.stop();
	const reopened = new ProjectMemoryService(home);
	t.after(() => reopened.stop());
	assert.deepEqual(
		(await reopened.wake("p")).nodes.map((n) => n.entry),
		entries,
	);
	assert.equal((await reopened.note("p", "after restart", "chat")).deviceId, entries[0]!.deviceId);
});

test("partial and torn full-width crash tails are repaired before the next append", async (t) => {
	const { home, service } = await fixture(t);
	const first = await service.note("p", "survives", "chat");
	await service.stop();
	const path = join(home, "memory", "p", "log");
	await appendFile(path, Buffer.concat([Buffer.alloc(RECORD_BYTES, 88), Buffer.from("partial utf8 é")]));
	const reopened = new ProjectMemoryService(home);
	t.after(() => reopened.stop());
	assert.equal((await reopened.load("p")).count, 1);
	assert.equal((await stat(path)).size, RECORD_BYTES);
	const next = await reopened.note("p", "repaired", "chat");
	assert.equal(next.index, 1);
	assert.equal((await reopened.wake("p")).nodes[0]?.entry?.id, first.id);
});

test("advisory lease refuses a second writer and releases on worker exit", async (t) => {
	const { home, service } = await fixture(t);
	await service.load("p");
	const other = new ProjectMemoryService(home);
	t.after(() => other.stop());
	await assert.rejects(other.note("p", "must not write", "chat"), /locked/);
	await service.stop();
	assert.equal((await other.note("p", "after owner exits", "chat")).index, 0);
});

test("wake is bounded when summaries are missing; zoom reports pending children", async (t) => {
	const { service } = await fixture(t);
	for (let i = 0; i < 100; i++) await service.note("p", `raw ${i}`, "chat");
	const wake = await service.wake("p", 8);
	assert.equal(wake.count, 100);
	assert.equal(wake.nodes.length, 8);
	assert.equal(wake.omittedBefore, 92);
	assert.match(wake.text, /Older memories #0-91 omitted/);
	assert.deepEqual(
		(await service.zoom("p", 0, 7)).map((n) => n.pending),
		[true, true],
	);
	assert.equal((await service.zoom("p", 98, 99))[1]?.entry?.index, 99);
	for (const range of [
		[1, 2],
		[0, 2],
		[0, 127],
		[-2, -1],
	])
		await assert.rejects(service.zoom("p", range[0]!, range[1]!));
});

test("forget drops dense suffixes and ancestors, rejects stale in-flight results, and rebuilds without touching the log", async (t) => {
	const { home } = await fixture(t);
	const dir = join(home, "direct"),
		disk = new MemoryDisk(dir, "device");
	try {
		for (let i = 0; i < 64; i++) disk.note(`fact ${i}`, "chat");
		build(disk);
		const before = await readFile(join(dir, "log"));
		const view = disk.wake(8);
		assert.equal(view.omittedBefore, 0);
		assert.equal(view.nodes.length, 8);
		assert.ok(view.nodes.some((n) => !n.entry));
		disk.forget(16, 31);
		const old = disk.next()!;
		assert.equal(old.lo, 16);
		assert.equal(old.hi, 31);
		disk.forget(0, 1);
		assert.equal(disk.put(old.lo, old.hi, old.epoch, "stale"), false);
		assert.ok(disk.pending() > 0);
		build(disk);
		assert.equal(disk.pending(), 0);
		assert.deepEqual(await readFile(join(dir, "log")), before);
		assert.equal(disk.wake(8).omittedBefore, 0);
		assert.match(disk.zoom(0, 31)[0]!.text!, /summary 0-15/);
	} finally {
		disk.close();
	}
});

test("tree tail repair invalidates parents and a cache can be rebuilt from only the log", async (t) => {
	const { home } = await fixture(t);
	const dir = join(home, "direct");
	let disk = new MemoryDisk(dir, "device");
	for (let i = 0; i < 32; i++) disk.note(`fact ${i}`, "chat");
	build(disk);
	disk.close();
	const tree = join(dir, "tree", "16");
	const data = await readFile(tree);
	await writeFile(tree, data.subarray(0, RECORD_BYTES + 7));
	disk = new MemoryDisk(dir, "device");
	assert.equal(disk.pending(), 2);
	build(disk);
	disk.close();
	await rm(join(dir, "tree"), { recursive: true });
	disk = new MemoryDisk(dir, "device");
	assert.equal(disk.count, 32);
	assert.equal(disk.pending(), 31);
	build(disk);
	assert.equal(disk.wake(8).omittedBefore, 0);
	disk.close();
});

test("recall streams a snapshot, keeps newest bounded matches, and validates inputs", async (t) => {
	const { service } = await fixture(t);
	for (let i = 0; i < 150; i++) await service.note("p", `match ${i} ${"é".repeat(100)}`, "chat");
	const recall = await service.recall("p", "MATCH", 256);
	assert.equal(recall.matches, 150);
	assert.ok(recall.entries.length < 96);
	assert.equal(recall.entries[0]?.index, 149);
	assert.ok(recall.truncated);
	const two = await service.recall("p", "match", 2);
	assert.deepEqual(
		two.entries.map((e) => e.index),
		[149, 148],
	);
	assert.equal((await service.recall("p", "nothing")).matches, 0);
	await assert.rejects(service.recall("p", "["));
	await assert.rejects(service.recall("p", ".", 0));
	await assert.rejects(service.note("p", "é".repeat(141), "chat"));
	await assert.rejects(service.note("p", "two\nlines", "chat"));
});

test("compactor coalesces notes, builds in order, and a held model call never blocks notes or wake", async (t) => {
	let release: (value: string) => void = () => {},
		calls = 0,
		active = 0,
		max = 0;
	const prompts: string[] = [];
	const { service } = await fixture(t, async (prompt) => {
		prompts.push(prompt);
		calls++;
		active++;
		max = Math.max(max, active);
		if (calls === 1)
			await new Promise<string>((r) => {
				release = r;
			});
		active--;
		return `summary ${calls}`;
	});
	await service.note("p", "one", "chat");
	await service.note("p", "two", "chat");
	await until(() => calls === 1);
	for (let i = 2; i < 8; i++) await service.note("p", `fact ${i}`, "chat");
	assert.equal((await service.wake("p")).nodes.length, 8);
	assert.equal(calls, 1);
	release("ok");
	await until(() => service.summary("p").compaction.state === "idle");
	assert.equal(calls, 7);
	assert.equal(max, 1);
	assert.deepEqual(
		prompts.map((p) => p.match(/memories (#\d+-\d+)/)![1]),
		["#0-1", "#2-3", "#4-5", "#6-7", "#0-3", "#4-7", "#0-7"],
	);
	await service.forget("p", 0, 3);
	await until(() => service.summary("p").compaction.state === "idle");
	assert.equal(calls, 10);
});

test("compactor failures and invalid output back off, survive new notes, and recover without blocking callers", async (t) => {
	let calls = 0;
	const { service } = await fixture(
		t,
		async () => {
			calls++;
			if (calls === 1) throw new Error("provider offline");
			if (calls === 2) return "bad\nline";
			return "lasting fact";
		},
		100,
	);
	await service.note("p", "one", "chat");
	await service.note("p", "two", "chat");
	await until(() => service.summary("p").compaction.state === "backoff");
	assert.equal(service.summary("p").compaction.error, "provider offline");
	await service.note("p", "three", "chat");
	assert.equal((await service.wake("p")).count, 3);
	assert.equal(calls, 1);
	await until(() => calls === 2 && service.summary("p").compaction.state === "backoff");
	assert.match(service.summary("p").compaction.error!, /one nonempty line/);
	await until(() => service.summary("p").compaction.state === "idle");
	assert.equal(calls, 3);
});

test("exhausted summary corrections preserve notes and existing summaries across restart", async (t) => {
	const message = "Memory summary was 282 UTF-8 bytes (limit 280) after 3 attempts; will retry automatically";
	let calls = 0;
	const { home, service } = await fixture(t, async () => {
		if (calls++ === 0) return "saved summary";
		throw new Error(message);
	});
	const entries = [
		await service.note("p", "first condition", "chat"),
		await service.note("p", "second condition", "chat"),
	];
	await until(() => service.summary("p").compaction.state === "idle");
	const treePath = join(home, "memory", "p", "tree", "2");
	const saved = await readFile(treePath);
	entries.push(
		await service.note("p", "third condition", "chat"),
		await service.note("p", "fourth condition", "chat"),
	);
	await until(() => service.summary("p").compaction.state === "backoff");
	assert.equal(service.summary("p").compaction.error, message);
	assert.deepEqual(await readFile(treePath), saved);
	assert.deepEqual(
		(await service.wake("p")).nodes.map((n) => n.entry),
		entries,
	);
	await service.stop();
	const reopened = new ProjectMemoryService(home);
	t.after(() => reopened.stop());
	assert.deepEqual(
		(await reopened.wake("p")).nodes.map((n) => n.entry),
		entries,
	);
	assert.deepEqual(await readFile(treePath), saved);
	assert.ok((await reopened.load("p")).compaction.pending > 0);
});

test("a pathological recall regex is timed out without blocking append or wake", async (t) => {
	const { service } = await fixture(t);
	await service.note("p", `${"a".repeat(275)}!`, "chat");
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pending = service.recall("p", "(a+)+$");
	const rejected = assert.rejects(pending, /5-second limit/);
	assert.equal((await service.note("p", "still responsive", "chat")).index, 1);
	assert.equal((await service.wake("p")).count, 2);
	// The load RPC precedes these writes; its isolated recall worker is now registered.
	assert.equal(service["recalls"].size, 1);
	t.mock.timers.tick(4_999);
	assert.equal(service["recalls"].size, 1, "the production deadline has not elapsed");
	t.mock.timers.tick(1);
	await rejected;
	assert.equal(service["recalls"].size, 0);
});

test("compaction concurrency is globally bounded and unloaded projects release locks without losing notes", async (t) => {
	let active = 0,
		max = 0,
		calls = 0;
	const { home, service } = await fixture(t, async (_prompt, signal) => {
		calls++;
		active++;
		max = Math.max(max, active);
		try {
			await delay(30, undefined, { signal });
			return "summary";
		} finally {
			active--;
		}
	});
	for (const project of ["a", "b", "c", "d"]) {
		await service.note(project, "one", "chat");
		await service.note(project, "two", "chat");
	}
	await until(() => ["a", "b", "c", "d"].every((p) => service.summary(p).compaction.state === "idle"));
	assert.equal(calls, 4);
	assert.ok(max <= 2);
	await service.unload("a");
	const other = new ProjectMemoryService(home);
	t.after(() => other.stop());
	assert.equal((await other.load("a")).count, 2);
	assert.equal((await other.note("a", "retained after unload", "chat")).index, 2);
});

test("restart resumes pending blocks, while unload cancels a non-cooperative model", async (t) => {
	const { home, service } = await fixture(t);
	await service.note("p", "one", "chat");
	await service.note("p", "two", "chat");
	await service.stop();
	let calls = 0;
	const resumed = new ProjectMemoryService(home, async () => {
		calls++;
		return "rebuilt";
	});
	t.after(() => resumed.stop());
	await resumed.load("p");
	await until(() => resumed.summary("p").compaction.state === "idle");
	assert.equal(calls, 1);
	await resumed.unload("p");
	const held = new ProjectMemoryService(home, async () => {
		calls++;
		return new Promise<string>(() => {});
	});
	t.after(() => held.stop());
	await held.note("p", "three", "chat");
	await held.note("p", "four", "chat");
	await until(() => calls === 2);
	await held.unload("p");
	await delay(20);
	assert.equal(held.summary("p").compaction.state, "idle");
	assert.equal(held.summary("p").compaction.error, undefined);
	const owner = new ProjectMemoryService(home);
	t.after(() => owner.stop());
	assert.equal((await owner.load("p")).count, 4);
});

test("corrections hide replaced notes from wake, keep them in recall and rebuild covering summaries", async (t) => {
	const { home } = await fixture(t);
	const dir = join(home, "direct");
	let disk = new MemoryDisk(dir, "device");
	try {
		for (let i = 0; i < 32; i++) disk.note(`fact ${i}`, "chat");
		build(disk);
		assert.equal(disk.pending(), 0);
		const log = await readFile(join(dir, "log"));
		const old = disk.entry(3);
		const fix = disk.note("fact 3, corrected", "chat", [3]);
		// Appended as a new entry with a stable reference; the log prefix is untouched.
		assert.deepEqual(fix.replaces, [old.id]);
		assert.deepEqual((await readFile(join(dir, "log"))).subarray(0, log.length), log);
		assert.equal(disk.entry(3).replacedBy, 32);
		assert.equal(disk.entry(3).id, old.id);
		// The summaries over #3 (2, 4, 8, 16 and 32 wide) are stale; others are kept.
		assert.equal(disk.pending(), 5);
		const lines = disk.wake(64).text.split("\n");
		assert.ok(!lines.some((l) => /^#3 /.test(l)));
		assert.ok(lines.some((l) => /^#32 .*fact 3, corrected$/.test(l)));
		assert.equal(disk.wake(64).omittedBefore, 0);
		const prompts: string[] = [];
		for (;;) {
			const next = disk.next();
			if (!next) break;
			prompts.push(next.prompt);
			assert.ok(disk.put(next.lo, next.hi, next.epoch, `rebuilt ${next.lo}-${next.hi}`));
		}
		assert.deepEqual(
			prompts.map((p) => p.match(/memories (#\d+-\d+)/)![1]),
			["#2-3", "#0-3", "#0-7", "#0-15", "#0-31"],
		);
		assert.ok(!prompts[0]!.includes("fact 3"));
		assert.match(prompts[0]!, /fact 2/);
		assert.equal(disk.pending(), 0);
		assert.equal(disk.zoom(0, 3)[1]!.text, "rebuilt 2-3");
		assert.equal(disk.zoom(4, 7)[0]!.text, "summary 4-5");
		disk.close();
		disk = new MemoryDisk(dir, "device");
		assert.equal(disk.pending(), 0, "rebuilt summaries stay fresh after reopening");
		assert.equal(disk.entry(3).replacedBy, 32);
		// Replacing both notes of a pair empties its summary without a model call.
		disk.note("fact 0 and 1, merged", "chat", [0, 1]);
		const rebuilt: string[] = [];
		for (let next = disk.next(); next; next = disk.next()) {
			rebuilt.push(next.prompt);
			assert.ok(disk.put(next.lo, next.hi, next.epoch, `again ${next.lo}-${next.hi}`));
		}
		assert.deepEqual(
			rebuilt.map((p) => p.match(/memories (#\d+-\d+)/)![1]),
			["#32-33", "#0-3", "#0-7", "#0-15", "#0-31"],
		);
		assert.equal(disk.zoom(0, 3)[0]!.replaced, true);
		for (const prompt of rebuilt) assert.doesNotMatch(prompt, /^#[013] /m);
		assert.ok(
			!disk
				.wake(64)
				.text.split("\n")
				.some((l) => /^#[013] /.test(l)),
		);
	} finally {
		disk.close();
	}
});

test("summaries over a note corrected while closed, or torn while rewriting, are rebuilt after reopening", async (t) => {
	const { home } = await fixture(t);
	const dir = join(home, "direct");
	let disk = new MemoryDisk(dir, "device");
	for (let i = 0; i < 4; i++) disk.note(`fact ${i}`, "chat");
	build(disk);
	disk.note("fact 1 was wrong", "chat", [1]);
	disk.close();
	disk = new MemoryDisk(dir, "device");
	assert.equal(disk.pending(), 2);
	disk.close();
	// A crash mid-rewrite leaves a corrupt record in place, which reopening treats as stale.
	const tree = join(dir, "tree", "2");
	const data = await readFile(tree);
	data.fill(88, 10, 40);
	await writeFile(tree, data);
	disk = new MemoryDisk(dir, "device");
	try {
		assert.equal(disk.pending(), 2);
		build(disk);
		assert.equal(disk.pending(), 0);
		assert.doesNotMatch(disk.wake(8).text, /^#1 /m);
	} finally {
		disk.close();
	}
});

test("notes reject normalized duplicates of live notes and invalid corrections", async (t) => {
	const { service } = await fixture(t);
	const first = await service.note("p", "Use  pnpm for installs", "chat");
	await assert.rejects(service.note("p", "use pnpm\tFOR installs ", "chat"), (error: Error) => {
		assert.ok(error instanceof Conflict);
		assert.equal(error.message, "Already in memory as #0");
		return true;
	});
	await assert.rejects(service.note("p", "other", "chat", [5]), /existing note indices/);
	await assert.rejects(service.note("p", "other", "chat", [0, 0]), /existing note indices/);
	assert.equal((await service.wake("p")).count, 1);
	const fix = await service.note("p", "Use pnpm for installs and scripts", "chat", [first.index]);
	assert.equal(fix.index, 1);
	// A replaced note no longer blocks its text, so a fact can be restated after a wrong correction.
	const back = await service.note("p", "use pnpm for installs", "chat", [fix.index]);
	assert.equal(back.index, 2);
	assert.deepEqual(back.replaces, [fix.id]);
	const wake = await service.wake("p");
	assert.deepEqual(
		wake.nodes.map((n) => n.lo),
		[2],
	);
	const recall = await service.recall("p", "pnpm");
	assert.deepEqual(
		recall.entries.map((e) => [e.index, e.replacedBy]),
		[
			[2, undefined],
			[1, 2],
			[0, 1],
		],
	);
	assert.deepEqual(
		recall.entries.map((e) => e.id),
		[back.id, fix.id, first.id],
	);
	assert.equal(service.summary("p").recent[1]?.replacedBy, 2);
});
