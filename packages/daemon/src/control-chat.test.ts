import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlChat } from "./control-chat.ts";
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

test("a failed summarization faults preparation without changing retained messages or retrying the failed job", {
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
	await assert.rejects(preparation, /Earlier chat messages could not be summarized/);
	assert.equal(calls, 1);
	assert.equal((await control.memory.state()).pending, 1, "failed summary stays pending, not silently discarded");
	assert.deepEqual(await control.memory.messages(), before);
	await control.stop();
	assert.equal(calls, 1, "no automatic retry after preparation fails or during shutdown");
});
