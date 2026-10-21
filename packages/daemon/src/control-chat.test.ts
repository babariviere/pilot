import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlChat } from "./control-chat.ts";
import { CONTROL_TURN_HISTORY_BYTES, ControlMemoryDisk } from "./control-memory-disk.ts";
import { controlLine } from "./control-view.ts";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

test("singleton is project-less, pinned, never archived, and creation starts no worker", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-chat-")),
		projects = new ProjectStore(home);
	await projects.load();
	let starts = 0;
	const sessions = new SessionManager(home, projects, undefined, {
		worker: () => {
			starts++;
			throw new Error("must not start");
		},
	});
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	// Explicit legacy fixture, never the production default.
	sessions.setControlRoleGuard(() => true);
	await sessions.load();
	const chats = await Promise.all(Array.from({ length: 10 }, () => sessions.ensureControlChat()));
	assert.equal(new Set(chats.map((chat) => chat.id)).size, 1);
	assert.equal(starts, 0);
	const chat = chats[0]!;
	assert.equal(chat.control, true);
	assert.equal(chat.mode, "ask");
	assert.equal(chat.projectId, undefined);
	assert.equal(chat.cwd, "");
	assert.equal(chat.workspace, undefined);
	assert.equal(chat.pinned, true);
	await assert.rejects(sessions.archive(chat.id), /cannot be archived/);
	await assert.rejects(sessions.setPinned(chat.id, false), /stays pinned/);
	assert.throws(() => sessions.assertWritable(chat.id), /read-only/);
});

test("failed compaction records a redacted cause while an under-cap turn proceeds exactly once", {
	timeout: 10_000,
}, async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-raw-turn-"));
	const control = new ControlChat(
		home,
		home,
		{
			compactControl: async () => {
				throw new TypeError("Authorization: Bearer private-token");
			},
		} as unknown as ModelCatalog,
		(id) => id === "control",
		() => "test/model",
	);
	t.after(async () => {
		await control.stop();
		await rm(home, { recursive: true, force: true });
	});
	let failed!: () => void;
	const failure = new Promise<void>((resolve) => {
		failed = resolve;
	});
	const remove = control.memory.onChange(() => {
		void control.memory.state().then((s) => {
			if (s.failure) failed();
		});
	});
	t.after(remove);
	const message = { kind: "user", text: "raw history ".repeat(100), key: "retained" };
	await control.call("control", "record", { message });
	const args = { key: "first", requestId: "typed", tools: [] };
	const view = await control.call("control", "prepare", args);
	assert.match(JSON.stringify(view), /raw history/);
	assert.doesNotMatch(JSON.stringify(view), /not summarized/);
	await failure;
	const state = await control.memory.state();
	assert.equal(state.failure?.attempts, 1);
	assert.equal(state.failure?.errorClass, "TypeError");
	assert.match(state.failure?.reason ?? "", /REDACTED/);
	assert.doesNotMatch(JSON.stringify(state), /private-token/);
	assert.deepEqual(await control.call("control", "prepare", args), view, "same input keeps its frozen view");
	await control.call("control", "record", { message });
	assert.equal((await control.memory.state()).count, 1, "record retry never duplicates history");
	assert.equal((await control.memory.stats()).compactionFailure?.attempts, 1);
});

test("over-cap raw history keeps the newest sources whole and older ones zoomable; success clears failures", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-raw-cap-"));
	const disk = new ControlMemoryDisk(home);
	t.after(async () => {
		disk.close();
		await rm(home, { recursive: true, force: true });
	});
	for (let i = 0; i < 5; i++) disk.append({ kind: "user", text: `${i}`.repeat(29_000), key: `input-${i}` });
	for (let job = disk.next(); job; job = disk.next())
		disk.fail(job.id, job.n, { errorClass: "NetworkError", reason: "Provider unreachable" });
	const capped = disk.turnView("too-large");
	assert.ok(capped.reduce((n, line) => n + Buffer.byteLength(controlLine(line)), 0) <= CONTROL_TURN_HISTORY_BYTES);
	assert.deepEqual(
		capped.map((line) => (line.text.startsWith("user: ") ? line.text.length - 6 : line.text)),
		["(not summarized yet: zoom it)", 29_000, 29_000, 29_000, 29_000],
		"newest sources stay whole; the oldest keeps its zoomable placeholder, never a truncated source",
	);
	const count = disk.state().count;
	disk.retry(Number.MAX_SAFE_INTEGER);
	for (let job = disk.next(); job; job = disk.next()) disk.put(job.id, job.n, "Recovered summary");
	assert.equal(disk.state().failure, undefined);
	assert.equal(disk.state().pending, 0);
	assert.equal(disk.state().count, count);
	assert.match(JSON.stringify(disk.turnView("retry-explicitly")), /Recovered summary/);
	assert.equal(disk.state().count, count);
});

test("persistently failing compaction never pushes a turn over the history cap", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-raw-failing-"));
	const disk = new ControlMemoryDisk(home);
	t.after(async () => {
		disk.close();
		await rm(home, { recursive: true, force: true });
	});
	// Short messages build without a model; every parent summary fails, so no persisted merge is possible.
	for (let i = 0; i < 600; i++) {
		disk.append({ kind: "user", text: `${i} ${"x".repeat(450)}` });
		for (let job = disk.next(); job; job = disk.next())
			disk.fail(job.id, job.n, { errorClass: "Error", reason: "down" });
	}
	assert.ok(disk.state().viewBytes > CONTROL_TURN_HISTORY_BYTES, "fixture must exceed the cap");
	const lines = disk.turnView("stuck");
	assert.ok(lines.reduce((n, line) => n + Buffer.byteLength(controlLine(line)), 0) <= CONTROL_TURN_HISTORY_BYTES);
	assert.equal(lines.at(-1)!.text, `user: 599 ${"x".repeat(450)}`, "recent history stays verbatim");
	assert.equal(lines[0]!.id, 0, "the view still covers the whole log");
	assert.equal(
		lines.reduce((n, line) => n + line.n, 0),
		600,
	);
	assert.match(lines[0]!.text, /not summarized yet: zoom it/);
});

test("raw fallback measures decoded UTF-8, not escaped JSON payload bytes", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-raw-escaping-"));
	const disk = new ControlMemoryDisk(home);
	t.after(async () => {
		disk.close();
		await rm(home, { recursive: true, force: true });
	});
	disk.append({ kind: "user", text: "\\".repeat(75_000) });
	const lines = disk.turnView("raw");
	assert.equal(
		lines.reduce((n, line) => n + line.text.replace(/^user: /, "").length, 0),
		75_000,
	);
});

test("a hanging summary call delays a turn by the bounded wait only, never fails it", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-hanging-"));
	let calls = 0;
	const control = new ControlChat(
		home,
		home,
		{
			compactControl: (
				_cwd: string,
				_provider: string,
				_tools: unknown,
				_job: unknown,
				_lines: unknown,
				signal: AbortSignal,
			) => {
				calls++;
				return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
			},
		} as unknown as ModelCatalog,
		(id) => id === "control",
		() => "test/model",
		() => [],
		50,
	);
	t.after(async () => {
		await control.stop();
		await rm(home, { recursive: true, force: true });
	});
	await control.call("control", "record", { message: { kind: "user", text: "slow ".repeat(200), key: "slow" } });
	const started = Date.now();
	const view = (await control.call("control", "prepare", { key: "1", requestId: "typed", tools: [] })) as {
		lines: { text: string }[];
	};
	assert.ok(Date.now() - started < 5_000);
	assert.ok(calls >= 1, "the summary call was still running");
	assert.equal(view.lines[0]!.text, `user: ${"slow ".repeat(200)}`);
});
test("turn view survives record/retry, and daemon remembers notice origin independently of actions", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-turn-service-"));
	const models = { compactControl: async () => "compressed" } as unknown as ModelCatalog;
	const control = new ControlChat(
		home,
		home,
		models,
		(id) => id === "control",
		() => "test/model",
	);
	t.after(async () => {
		await control.stop();
		await rm(home, { recursive: true, force: true });
	});
	await assert.rejects(control.call("other", "prepare", {}), /Only the control/);
	await control.call("control", "record", { message: { kind: "user", text: "previous", key: "previous" } });
	const args = { key: "1", requestId: "typed", tools: [] };
	const before = await control.call("control", "prepare", args);
	assert.equal(control.handlingNotice, false);
	await control.call("control", "record", { message: { kind: "user", text: "current", key: "current" } });
	assert.deepEqual(await control.call("control", "prepare", args), before);
	await control.call("control", "prepare", { ...args, key: "2", requestId: "watch-notice:1" });
	assert.equal(control.handlingNotice, true);
});

test("a failed summarization never faults preparation, changes retained messages or retries the failed job", {
	timeout: 10_000,
}, async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-summary-failure-"));
	let started!: () => void,
		release!: () => void,
		retryReady!: () => void,
		calls = 0;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const retryDone = new Promise<void>((resolve) => {
		retryReady = resolve;
	});
	const models = {
		compactControl: async () => {
			calls++;
			started();
			await held;
			throw new Error("PRIVATE_PROVIDER_ERROR");
		},
	} as unknown as ModelCatalog;
	const control = new ControlChat(
		home,
		home,
		models,
		(id) => id === "synthetic",
		() => "offline/test",
	);
	t.after(async () => {
		release();
		await control.stop();
		await rm(home, { recursive: true, force: true });
	});
	const retry = control.memory.retry.bind(control.memory);
	t.mock.method(control.memory, "retry", async () => {
		await retry();
		retryReady();
	});
	await control.call("synthetic", "record", {
		message: { kind: "user", text: "PRIVATE_HISTORY ".repeat(60), key: "previous" },
	});
	await entered;
	const before = await control.memory.messages();
	const preparation = control.call("synthetic", "prepare", { key: "turn", requestId: "typed", tools: [] });
	await retryDone; // fail during this request, not before its existing explicit-turn retry boundary
	release();
	const { lines } = (await preparation) as { lines: { text: string }[] };
	assert.equal(lines[0]!.text, `user: ${"PRIVATE_HISTORY ".repeat(60)}`, "the turn uses the complete source");
	assert.equal(calls, 1);
	assert.equal((await control.memory.state()).pending, 1, "failed summary stays pending, not silently discarded");
	assert.deepEqual(await control.memory.messages(), before);
	await control.stop();
	assert.equal(calls, 1, "no automatic retry after preparation fails or during shutdown");
});
