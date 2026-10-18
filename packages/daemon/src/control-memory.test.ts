import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ControlMemory } from "./control-memory.ts";
import { ControlMemoryDisk } from "./control-memory-disk.ts";
import { type ControlLine, controlLine, mergeControlView } from "./control-view.ts";

async function home(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "control-memory-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	return home;
}
function build(disk: ControlMemoryDisk) {
	for (let next = disk.next(); next; next = disk.next()) disk.put(next.id, next.n, `summary ${next.id}+${next.n}`);
}
test("due order equals rollback push for every t = 0..20,000", () => {
	type State = { id: number; keep: number; older?: State };
	function push(id: number, state?: State): State {
		if (!state) return { id, keep: 0 };
		if (!state.keep) return { ...state, keep: 1 };
		return { id, keep: 0, older: push(state.id, state.older) };
	}
	let state: State | undefined;
	let view: ControlLine[] = [];
	for (let t = 0; t <= 20_000; t++) {
		state = push(t, state);
		const ids: number[] = [];
		for (let node: State | undefined = state; node; node = node.older) ids.push(node.id);
		ids.reverse();
		view.push({ id: t, n: 1, text: "x" });
		view = mergeControlView(view, t + 1, () => "x", { lines: ids.length }).lines;
		assert.deepEqual(
			view.map(({ id, n }) => [id, n]),
			ids.map((id, i) => [id, (ids[i + 1] ?? t + 1) - id]),
			`t=${t}`,
		);
	}
});
test("the last-message rule preserves old lines at T=10, and unavailable parents never merge", () => {
	const view = [
		{ id: 0, n: 4, text: "a" },
		{ id: 4, n: 4, text: "b" },
		{ id: 8, n: 1, text: "c" },
		{ id: 9, n: 1, text: "d" },
	];
	assert.deepEqual(
		mergeControlView(view, 10, () => "p", { lines: 3 }).merges.map(({ id, n }) => [id, n]),
		[[8, 2]],
	);
	assert.deepEqual(mergeControlView(view, 10, () => undefined, { lines: 1 }).lines, view);
});
test("all kinds are append-only, short nodes preserve words and tools preserve name/input", async (t) => {
	const dir = await home(t),
		disk = new ControlMemoryDisk(dir);
	t.after(() => disk.close());
	for (const kind of ["user", "assistant", "tool", "echo", "event", "note"] as const)
		disk.append({
			kind,
			text: `exact ${kind} é\n🙂`,
			...(kind === "tool" ? { name: "read", input: { path: "file" } } : {}),
			at: 1234,
		});
	assert.equal(disk.state().count, 6);
	assert.equal(disk.view()[0]!.text, "user: exact user é\n🙂");
	assert.equal(disk.view()[2]!.text, 'tool: read {"path":"file"}');
	assert.equal(disk.date(0), new Date(1234).toISOString());
	assert.throws(() => disk.append({ kind: "thought" as "user", text: "private" }));
	assert.throws(() => disk.put(0, 1, "rewrite"));
	assert.equal(disk.message(0).message.text, "exact user é\n🙂");
});
test("long messages split losslessly, only echoes clip, and retries keep IDs", async (t) => {
	const disk = new ControlMemoryDisk(await home(t));
	t.after(() => disk.close());
	const text = `${"🙂".repeat(18_000)}tail`;
	const messages = disk.append({ kind: "user", text, key: "request[*?" });
	assert.equal(messages.map((m) => m.text).join(""), text);
	assert.deepEqual(disk.append({ kind: "user", text, key: "request[*?" }), messages);
	assert.equal(disk.state().count, messages.length);
	const echoes = disk.append({ kind: "echo", text: `head${"x".repeat(40_000)}tail` });
	assert.equal(echoes.length, 1);
	assert.ok(echoes[0]!.text.length <= 30_000);
	assert.match(echoes[0]!.text, /^head.*\n\[tool result clipped\]\n.*tail$/);
	assert.equal(disk.view()[0]!.text, "(not summarized yet: zoom it)");
	let all = "",
		offset = 0;
	for (;;) {
		const page = disk.message(0, offset);
		all += page.message.text;
		if (page.next === undefined) break;
		offset = page.next;
	}
	assert.equal(all, messages[0]!.text);
});
test("128 KB triggers one due-ordered batch to 64 KB; restart preserves the exact view", async (t) => {
	const dir = await home(t);
	let disk = new ControlMemoryDisk(dir);
	t.after(() => disk.close());
	let previous: ControlLine[] = [],
		sawBatch = false;
	for (let i = 0; i < 600; i++) {
		disk.append({ kind: "user", text: `${i} ${"x".repeat(450)}` });
		build(disk);
		const view = disk.view();
		const bytes = view.reduce((sum, line) => sum + Buffer.byteLength(controlLine(line)), 0);
		assert.equal(bytes, disk.state().viewBytes);
		assert.ok(bytes <= 128_000);
		if (view.length < previous.length) {
			assert.ok(bytes <= 64_000);
			sawBatch = true;
		} else assert.deepEqual(view.slice(0, -1), previous, "no merges between batches");
		previous = view;
	}
	assert.ok(sawBatch);
	assert.ok(previous.length > 100, "restart must not refit to a log-sized binary cover");
	disk.close();
	disk = new ControlMemoryDisk(dir);
	assert.deepEqual(disk.view(), previous);
	assert.equal(disk.state().count, 600);
});
test("unfinished jobs recover and failure diagnostics/backoff survive restart", async (t) => {
	const dir = await home(t);
	let disk = new ControlMemoryDisk(dir);
	t.after(() => disk.close());
	disk.append({ kind: "user", text: "é".repeat(300) });
	const job = disk.next()!;
	assert.equal(job.id, 0);
	assert.equal(disk.next(), undefined);
	disk.close();
	disk = new ControlMemoryDisk(dir);
	assert.deepEqual({ ...disk.next() }, { ...job, attempts: 2 }, "claimed job recovered after crash");
	disk.fail(job.id, job.n);
	assert.equal(disk.next(), undefined);
	disk.append({ kind: "user", text: "second" });
	assert.equal(disk.next(), undefined, "new messages respect persisted retry backoff");
	const failure = disk.state().failure!;
	assert.equal(failure.attempts, 2);
	disk.close();
	disk = new ControlMemoryDisk(dir);
	assert.deepEqual(disk.state().failure, failure, "failure diagnostics survive restart");
	disk.retry(failure.retryAt);
	assert.deepEqual({ ...disk.next() }, { ...job, attempts: 3 });
	assert.throws(() => disk.put(0, 1, "é".repeat(257)), /512/);
	disk.put(0, 1, "é".repeat(256));
	const parent = disk.next()!;
	assert.deepEqual([parent.id, parent.n], [0, 2]);
	disk.put(0, 2, "merged");
	assert.deepEqual(
		disk.children(0, 2).map((line) => line.text),
		["é".repeat(256), "user: second"],
	);
});
test("SQLite crash recovery rolls back an unflushed log/view transaction together", async (t) => {
	const dir = await home(t);
	let disk = new ControlMemoryDisk(dir);
	disk.append({ kind: "user", text: "committed" });
	const view = disk.view();
	disk.close();
	const child = spawnSync(process.execPath, [
		"--input-type=module",
		"-e",
		`
		import { DatabaseSync } from 'node:sqlite';
		const db = new DatabaseSync(${JSON.stringify(join(dir, "chat.sqlite"))});
		db.exec("BEGIN IMMEDIATE; INSERT INTO messages VALUES (1,NULL,0,'user','{}'); INSERT INTO view VALUES (1,1); UPDATE meta SET value=2 WHERE key='count'");
		process.kill(process.pid,'SIGKILL');
	`,
	]);
	assert.equal(child.signal, "SIGKILL");
	disk = new ControlMemoryDisk(dir);
	t.after(() => disk.close());
	assert.equal(disk.state().count, 1);
	assert.deepEqual(disk.view(), view);
	assert.equal(disk.append({ kind: "user", text: "next" })[0]!.id, 1);
});
test("existing storage worker serializes calls, enforces the owner lease and drains on shutdown", async (t) => {
	const dir = await home(t),
		memory = new ControlMemory(dir),
		other = new ControlMemory(dir);
	t.after(() => other.stop());
	t.after(() => memory.stop());
	const messages = await Promise.all(
		Array.from({ length: 20 }, (_, i) => memory.append({ kind: "user", text: `message ${i}` })),
	);
	assert.deepEqual(
		messages.map((rows) => rows[0]!.id),
		Array.from({ length: 20 }, (_, i) => i),
	);
	await assert.rejects(other.state(), /locked/);
	const append = memory.append({ kind: "event", text: "last before close" });
	await memory.stop();
	await append;
	assert.equal((await other.state()).count, 21);
	await assert.rejects(memory.state(), /stopped|exited/);
});
