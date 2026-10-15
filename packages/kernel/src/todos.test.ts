import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { ModelRuntime, SettingsManager, wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { AgentEvent } from "@pilot/protocol";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";
import { readSessionSnapshot, readSessionTodoCount } from "./snapshot.ts";
import { openSessionStorage } from "./storage.ts";
import { callParentTodo, startTodoBridge } from "./todo-bridge.ts";
import {
	applyTodo,
	TODO_BODY_BYTES,
	TODO_LIMIT,
	type TodoArgs,
	TodoProgressDoc,
	type TodoRecord,
	TodosDoc,
	todoProgress,
} from "./todos.ts";

function mutate(items: TodoRecord[], args: TodoArgs, actor = "parent"): TodoRecord {
	return applyTodo(items, args, actor) as TodoRecord;
}
test("compatible actions, summaries, assignments, and every unclosed status", () => {
	const items: TodoRecord[] = [];
	const item = mutate(items, { action: "create", title: "First", tags: ["qa"], body: "Notes" });
	assert.match(item.id, /^TODO-[a-f0-9]{8}$/);
	assert.equal(mutate(items, { action: "get", id: item.id.slice(5).toUpperCase() }).body, "Notes");
	assert.equal(mutate(items, { action: "append", id: item.id, body: "More" }).body, "Notes\n\nMore");
	assert.equal(mutate(items, { action: "claim", id: item.id }, "child").assigned_to_session, "child");
	assert.throws(() => mutate(items, { action: "claim", id: item.id }), /another agent/);
	assert.throws(() => mutate(items, { action: "release", id: item.id }), /another agent/);
	assert.equal(mutate(items, { action: "release", id: item.id, force: true }).assigned_to_session, undefined);
	mutate(items, { action: "claim", id: item.id });
	for (const status of ["open", "in_progress", "blocked", "arbitrary"]) {
		mutate(items, { action: "update", id: item.id, status });
		assert.equal(todoProgress(items).openCount, 1);
	}
	mutate(items, { action: "update", id: item.id, status: "DONE" });
	assert.equal(items[0].assigned_to_session, undefined);
	assert.equal(todoProgress(items).openCount, 0);
	assert.deepEqual(applyTodo(items, { action: "list" }, "parent"), []);
	const all = applyTodo(items, { action: "listAll" }, "parent") as Omit<TodoRecord, "body">[];
	assert.equal(all.length, 1);
	assert.equal("body" in all[0], false);
	assert.throws(() => mutate(items, { action: "claim", id: item.id }), /Reopen/);
	mutate(items, { action: "update", id: item.id, status: "open", body: "Replaced", tags: [] });
	assert.equal(mutate(items, { action: "get", id: `#${item.id}` }).body, "Replaced");
	assert.equal(mutate(items, { action: "delete", id: item.id }).id, item.id);
	assert.equal(items.length, 0);
	assert.throws(() => mutate(items, { action: "get", id: item.id }), /not found/);
});

test("storage, item, UTF-8 and input bounds reject without committing partial data", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pilot-todo-bounds-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const owned = await openSessionStorage(directory);
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	t.after(async () => {
		await harness.close(context);
		owned.release();
	});
	const commit = (args: TodoArgs) =>
		harness.commit(async (tx) => {
			const state = await tx.doc(TodosDoc);
			const copy = state.items.map((item) => ({ ...item, tags: [...item.tags] }));
			const result = applyTodo(copy, args, "parent");
			state.items = copy;
			Object.assign(await tx.doc(TodoProgressDoc), todoProgress(copy));
			return result;
		}, context);
	await commit({ action: "create", title: "Keep", body: "safe" });
	const before = await harness.snapshot(TodosDoc, context);
	await assert.rejects(commit({ action: "create", title: "Too big", body: "é".repeat(TODO_BODY_BYTES) }), /UTF-8/);
	assert.deepEqual(await harness.snapshot(TodosDoc, context), before);
	const items = structuredClone(before!.items);
	for (let index = items.length; index < TODO_LIMIT; index++) mutate(items, { action: "create", title: "Bounded" });
	assert.throws(() => mutate(items, { action: "create", title: "Extra" }), /limit/);
	assert.throws(() => mutate([], { action: "create", title: " " }), /nonempty/);
	assert.throws(() => mutate(items, { action: "update", id: "../../file" }), /Expected/);
	assert.throws(() => mutate(items, { action: "update", id: items[0].id, tags: [42] as unknown as string[] }), /Tag/);
	for (let index = 0; index < 15; index++)
		await commit({ action: "create", title: "Body", body: "x".repeat(TODO_BODY_BYTES) });
	await assert.rejects(commit({ action: "create", title: "Over total", body: "x".repeat(TODO_BODY_BYTES) }), /1 MiB/);
	const full = await harness.snapshot(TodosDoc, context);
	await assert.rejects(commit({ action: "append", id: full!.items[1].id, body: "x" }), /UTF-8/);
	assert.deepEqual(await harness.snapshot(TodosDoc, context), full);
	const db = new DatabaseSync(join(directory, "harness.sqlite"), { readOnly: true });
	try {
		assert.equal(
			db.prepare("SELECT COUNT(*) AS n FROM document_revisions").get()!.n,
			2,
			"latest-only checkpoints bound document revisions",
		);
	} finally {
		db.close();
	}
});

test("parent tools and concurrent child writes share a durable list, events and cheap count across restore", {
	timeout: 30_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-todo-session-"));
	const cwd = join(root, "workspace");
	const storageDir = join(root, "durable");
	await mkdir(join(cwd, ".pi/todos"), { recursive: true });
	const legacy = join(cwd, ".pi/todos/aabbccdd.md");
	await writeFile(legacy, '{"title":"Legacy","status":"open"}');
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider();
	runtime.registerNativeProvider(faux.provider);
	let native!: NativeAdapter;
	const open = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) => {
		native = await open.call(NativeAdapter, {
			...options,
			agentDir: root,
			projectTrusted: false,
			bundledExtensions: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
			loaderOptions: {
				cwd,
				agentDir: root,
				noSkills: true,
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
		});
		return native;
	});
	let session: KernelSession | undefined;
	t.after(async () => {
		await session?.close();
		await rm(root, { recursive: true, force: true });
	});
	const counts: number[] = [];
	const spec = { sessionId: "parent", storageDir, cwd };
	session = await KernelSession.open(spec, { onWorking: () => {}, onTodosChanged: (count) => counts.push(count) });
	const events: AgentEvent[] = [];
	await session.watch("todos", (batch) => {
		events.push(...batch);
	});
	assert.deepEqual(
		events.find((e) => e.type === "todos_update"),
		{ type: "todos_update", items: [] },
	);
	faux.setResponses([
		fauxAssistantMessage(
			{
				type: "toolCall",
				id: "todo-call",
				name: "codemode",
				arguments: { code: 'return await tools.todo({action:"create",title:"From parent",body:"Durable"});' },
			},
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Saved"),
	]);
	await session.submit("input", "Create a todo", "followUp");
	await session.harness.waitForIdle(context);
	assert.equal(session.openTodoCount, 1);
	const children = (await Promise.all(
		Array.from({ length: 4 }, (_, i) => callParentTodo({ action: "create", title: `Child ${i}` }, `child-${i}`)),
	)) as TodoRecord[];
	assert.equal(session.openTodoCount, 5);
	await callParentTodo({ action: "claim", id: children[0].id }, "child-0");
	await assert.rejects(callParentTodo({ action: "release", id: children[0].id }, "child-1"), /another agent/);
	await callParentTodo({ action: "update", id: children[0].id, status: "closed" }, "child-0");
	assert.equal(await readSessionTodoCount(storageDir), 4);
	assert.equal(session.openTodoCount, 4);
	assert.equal(counts.at(-1), 4);
	assert.deepEqual(await readFile(legacy, "utf8"), '{"title":"Legacy","status":"open"}');
	const view = await readSessionSnapshot(storageDir, cwd);
	const progress = view.events.find((e) => e.type === "todos_update");
	assert.equal(progress?.items.length, 5);
	assert.equal(events.filter((e) => e.type === "todos_update").at(-1)?.items.length, 5);
	await session.close();
	session = undefined;
	await rm(cwd, { recursive: true, force: true });
	await mkdir(cwd);
	assert.equal(await readSessionTodoCount(storageDir), 4);
	session = await KernelSession.open(spec, { onWorking: () => {} });
	assert.equal(session.openTodoCount, 4);
	assert.equal((await session.harness.snapshot(TodosDoc, context))?.items[0].body, "Durable");
	assert.deepEqual(
		(await readSessionSnapshot(storageDir, cwd)).events.find((e) => e.type === "todos_update"),
		progress,
	);
	const tool = native.session.getToolDefinition("todo")!;
	const sourceInfo = native.session.getAllTools().find((tool) => tool.name === "todo")!.sourceInfo;
	const result = await wrapRegisteredTool({ definition: tool, sourceInfo }, native.session.extensionRunner).execute(
		"get",
		{ action: "get", id: children[0].id },
	);
	assert.equal((result.details as TodoRecord).status, "closed");
	await session.close();
	session = undefined;
	session = await KernelSession.open(
		{ ...spec, sessionId: "other-chat", storageDir: join(root, "other-durable") },
		{ onWorking: () => {} },
	);
	assert.equal(session.openTodoCount, 0, "another chat in the same workspace has its own list");
	assert.deepEqual((await session.harness.snapshot(TodosDoc, context))?.items, []);
	assert.equal(await readSessionTodoCount(storageDir), 4, "the first chat's list is untouched");
});

test("a child cannot fall back to checkout storage when its parent bridge closes", async (t) => {
	// The test runner itself can be launched by a Pilot chat. Never fall through to its live bridge.
	const previous = process.env.PILOT_TODO_BRIDGE;
	delete process.env.PILOT_TODO_BRIDGE;
	t.after(() => {
		if (previous === undefined) delete process.env.PILOT_TODO_BRIDGE;
		else process.env.PILOT_TODO_BRIDGE = previous;
	});
	const bridge = await startTodoBridge(async () => []);
	assert.deepEqual(await callParentTodo({ action: "list" }, "child"), []);
	await bridge.close();
	await assert.rejects(callParentTodo({ action: "list" }, "child"), /unavailable/);
});

test("parent bridge shutdown drains admitted commits before releasing its owner", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started!: () => void;
	const admitted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const bridge = await startTodoBridge(async () => {
		started();
		await gate;
		return [];
	});
	const call = callParentTodo({ action: "list" }, "child");
	await admitted;
	let closed = false;
	const closing = bridge.close().then(() => {
		closed = true;
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(closed, false);
	} finally {
		release();
	}
	await call;
	await closing;
	assert.equal(closed, true);
});
