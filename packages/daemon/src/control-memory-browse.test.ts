import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
	ControlMemoryMessagePage,
	ControlMemoryMessagesResponse,
	ControlMemoryStats,
	ControlMemoryViewResponse,
} from "@pilot/protocol";
import { WebSocket } from "ws";
import { ControlMemoryDisk } from "./control-memory-disk.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

async function disk(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "control-browse-"));
	const disk = new ControlMemoryDisk(dir);
	t.after(async () => {
		disk.close();
		await rm(dir, { recursive: true, force: true });
	});
	return disk;
}
const ids = (page: ControlMemoryMessagesResponse) => page.messages.map((message) => message.id);

test("log pages run newest first with a before cursor, and clip list rows", async (t) => {
	const memory = await disk(t);
	for (let i = 0; i < 5; i++) memory.append({ kind: "user", text: `message ${i}`, at: 1000 + i });
	memory.append({ kind: "tool", text: "x".repeat(5000), name: "read", input: { path: "y".repeat(2000) } });
	let page = memory.messages(undefined, 2);
	assert.deepEqual(ids(page), [5, 4]);
	assert.equal(page.next, 4);
	const tool = page.messages[0]!;
	assert.equal(tool.name, "read");
	assert.equal(tool.clipped, true);
	assert.ok(tool.text.length <= 1000 && tool.input!.length <= 500);
	assert.ok(tool.input!.startsWith('{"path":"yyy'));
	assert.deepEqual(page.messages[1], { id: 4, at: 1004, kind: "user", text: "message 4" });
	page = memory.messages(page.next, 2);
	assert.deepEqual(ids(page), [3, 2]);
	page = memory.messages(2, 2);
	assert.deepEqual(ids(page), [1, 0]);
	assert.equal(page.next, undefined);
	assert.deepEqual(memory.messages(0).messages, []);
	assert.throws(() => memory.messages(undefined, 0), /limit/);
	assert.throws(() => memory.messages(undefined, 101), /limit/);
	assert.throws(() => memory.messages(-1), /cursor/);
	assert.throws(() => memory.messages(undefined, 10, ""), /q must/);
	assert.throws(() => memory.messages(undefined, 10, "x".repeat(201)), /q must/);
});

test("search folds Unicode case, escapes LIKE wildcards and covers tool name and input", async (t) => {
	const memory = await disk(t);
	for (const text of ["100% done", "100 percent", "a_b", "axb", "Déjà VU ÉTÉ", "back\\slash", "plain"])
		memory.append({ kind: "assistant", text });
	memory.append({ kind: "tool", text: "", name: "grep", input: { pattern: "Needle.TXT" } });
	const texts = (q: string) =>
		memory.messages(undefined, 100, q).messages.map((message) => message.text || message.name);
	assert.deepEqual(texts("%"), ["100% done"]);
	assert.deepEqual(texts("_"), ["a_b"]);
	assert.deepEqual(texts("\\"), ["back\\slash"]);
	assert.deepEqual(texts("été"), ["Déjà VU ÉTÉ"]);
	assert.deepEqual(texts("DÉJÀ vu"), ["Déjà VU ÉTÉ"]);
	assert.deepEqual(texts("needle.txt"), ["grep"]);
	assert.deepEqual(texts("GREP"), ["grep"]);
	assert.deepEqual(texts("missing"), []);
});

test("a search scans a bounded window and continues with next", async (t) => {
	const memory = await disk(t);
	for (let i = 0; i < 10; i++) memory.append({ kind: "user", text: i === 1 ? "needle" : `hay ${i}` });
	let page = memory.messages(undefined, 5, "needle", 4);
	assert.deepEqual(page, { messages: [], next: 6 });
	page = memory.messages(page.next, 5, "needle", 4);
	assert.deepEqual(page, { messages: [], next: 2 });
	page = memory.messages(page.next, 5, "needle", 4);
	assert.deepEqual(ids(page), [1]);
	assert.equal(page.next, undefined);
	page = memory.messages(undefined, 1, "hay", 4);
	assert.deepEqual(ids(page), [9]);
	assert.equal(page.next, 9);
});

test("stats and view lines flag unsummarized ranges", async (t) => {
	const memory = await disk(t);
	assert.deepEqual(
		{ ...memory.stats(), dbBytes: 0 },
		{ count: 0, pendingJobs: 0, failedJobs: 0, viewBytes: 0, merging: false, dbBytes: 0 },
	);
	memory.append({ kind: "user", text: "short", at: 10 });
	memory.append({ kind: "user", text: "long ".repeat(200), at: 20 });
	let stats = memory.stats();
	assert.equal(stats.count, 2);
	assert.equal(stats.oldestAt, 10);
	assert.equal(stats.newestAt, 20);
	assert.ok(stats.dbBytes > 0);
	assert.equal(stats.pendingJobs, 1);
	assert.deepEqual(memory.viewLines(), [
		{ id: 0, n: 1, text: "user: short" },
		{ id: 1, n: 1, text: "", pending: true },
	]);
	const job = memory.next()!;
	memory.fail(job.id, job.n);
	stats = memory.stats();
	assert.equal(stats.pendingJobs, 0);
	assert.equal(stats.failedJobs, 1);
	memory.retry();
	memory.put(memory.next()!.id, 1, "long text summary");
	assert.deepEqual(memory.childLines(0, 2), [
		{ id: 0, n: 1, text: "user: short" },
		{ id: 1, n: 1, text: "long text summary" },
	]);
	assert.throws(() => memory.childLines(0, 4), /existing/);
});

test("HTTP memory routes validate params, 404 without a control chat and broadcast coalesced changes", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-memory-http-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const sessions = new SessionManager(home, projects);
	await sessions.load();
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		new ModelCatalog(home),
		terminals,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/control-chat`;
	const ws = new WebSocket(base.replace("http:", "ws:").replace("/control-chat", "/ws"));
	const changes: number[] = [];
	ws.on("message", (data) => {
		if (JSON.parse(String(data)).type === "control-memory.changed") changes.push(Date.now());
	});
	t.after(async () => {
		ws.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	await once(ws, "open");
	assert.equal((await fetch(base + "/memory/view")).status, 404);
	assert.equal((await fetch(base + "/memory/stats")).status, 404);
	await fetch(base, { method: "POST" });
	const memory = sessions.controlMemory();
	await memory.append({ kind: "user", text: "hello 100%" });
	await memory.append({ kind: "tool", text: "ok", name: "read", input: { path: "a" } });
	await memory.append({ kind: "assistant", text: "done" });
	const view = (await (await fetch(base + "/memory/view")).json()) as ControlMemoryViewResponse;
	assert.deepEqual(
		view.lines.map((line) => line.text),
		["user: hello 100%", 'tool: read {"path":"a"}', "assistant: done"],
	);
	const stats = (await (await fetch(base + "/memory/stats")).json()) as ControlMemoryStats;
	assert.equal(stats.count, 3);
	const page = (await (await fetch(base + "/memory/messages?limit=2")).json()) as ControlMemoryMessagesResponse;
	assert.deepEqual(ids(page), [2, 1]);
	assert.equal(page.next, 1);
	assert.equal(page.messages[1]!.input, '{"path":"a"}');
	const found = (await (
		await fetch(base + "/memory/messages?q=" + encodeURIComponent("0%"))
	).json()) as ControlMemoryMessagesResponse;
	assert.deepEqual(ids(found), [0]);
	const node = (await (await fetch(base + "/memory/nodes/1/1")).json()) as ControlMemoryMessagePage;
	assert.equal(node.format, "json");
	assert.deepEqual(JSON.parse(node.message.text), { name: "read", input: { path: "a" }, text: "ok" });
	assert.deepEqual(await (await fetch(base + "/memory/nodes/0/2")).json(), {
		lines: [
			{ id: 0, n: 1, text: "user: hello 100%" },
			{ id: 1, n: 1, text: 'tool: read {"path":"a"}' },
		],
	});
	for (const path of [
		"/memory/messages?limit=0",
		"/memory/messages?limit=101",
		"/memory/messages?limit=abc",
		"/memory/messages?before=-1",
		"/memory/messages?q=",
		`/memory/messages?q=${"x".repeat(201)}`,
		"/memory/nodes/1/2",
		"/memory/nodes/0/3",
		"/memory/nodes/x/1",
		"/memory/nodes/0/2?offset=1",
		"/memory/nodes/0/1?offset=-1",
		"/memory/nodes/99/1",
	])
		assert.equal((await fetch(base + path)).status, 400, path);
	// Three quick appends: a leading broadcast, then trailing ones at least a second apart.
	await new Promise((resolve) => setTimeout(resolve, 1300));
	assert.ok(changes.length >= 2 && changes.length <= 3, String(changes.length));
	for (let i = 1; i < changes.length; i++) assert.ok(changes[i]! - changes[i - 1]! >= 900);
});
