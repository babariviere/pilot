import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	contentText,
	fauxAssistantMessage,
	fauxProvider,
	getCurrentTools,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	AssistantEntry,
	createRegistry,
	type EntryId,
	Harness,
	LiveDoc,
	section,
	type ToolRegistration,
	UserEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ControlTurn } from "./control-turn.ts";
import { NativeAdapter } from "./native-adapter.ts";

test("20k retained entries never enter preparation or SDK mirroring; request-phase recovery keeps the run", {
	timeout: 90_000,
}, async (t) => {
	t.mock.method(globalThis, "fetch", () => assert.fail("fixture must remain offline"));
	const root = await mkdtemp(join(tmpdir(), "control-history-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});

	const faux = fauxProvider({ models: [{ id: "offline", contextWindow: 1_000_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const keys = new Set<string>();
	const prefixes = new Map<string, JsonValue>();
	let adapter!: NativeAdapter, harness!: Harness, turn!: ControlTurn;
	let conversationId!: Parameters<Harness["conversation"]>[0];
	let guarded = false,
		boundedReads = 0;
	const open = async () => {
		adapter = await NativeAdapter.open({
			cwd: root,
			agentDir: root,
			sessionId: "history",
			control: true,
			settingsManager: SettingsManager.inMemory(),
			sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
		});
		const storage = await openNodeSqliteStorage(join(root, "harness.sqlite"));
		const scan = storage.scanEntries.bind(storage);
		storage.scanEntries = (query, limit, cursor, ctx) => {
			if (guarded && limit > 1) {
				assert.ok(query.minEntryId !== undefined, "no retained-history context scan");
				assert.ok(limit <= 4096, "entry reads are bounded");
				boundedReads++;
			}
			return scan(query, limit, cursor, ctx);
		};
		turn = new ControlTurn(
			async (action, args) => {
				if (action === "record") {
					keys.add(String((args.message as Record<string, JsonValue>).key));
					return null;
				}
				assert.equal(action, "prepare");
				const key = String(args.key);
				if (!prefixes.has(key))
					prefixes.set(key, { lines: [{ id: 0, n: 1, text: "SAVED VIEW, not rebuilt from the transcript" }] });
				return prefixes.get(key)!;
			},
			() => harness,
			storage,
			() => conversationId,
		);
		adapter.controlContext = (ctx) => turn.context(ctx);
		const registry = createRegistry();
		const extension = turn.prepare(adapter.extension, (block) => {
			adapter.controlCacheBlock = block;
			adapter.controlRequestReady = true;
		});
		registry.install(extension);
		adapter.onToolsChanged = (next) =>
			registry.install(
				turn.prepare(next, (block) => {
					adapter.controlCacheBlock = block;
					adapter.controlRequestReady = true;
				}),
			);
		harness = await Harness.open(
			storage,
			{
				models: adapter.models,
				registry: turn.registry(registry),
				settings: { compaction: { enabled: false }, toolExecution: "sequential" },
			},
			context,
		);
		const conversation = await harness.root(context, {
			agent: { model: adapter.model, extensions: [extension], tools: null },
		});
		conversationId = conversation.id;
		return conversation;
	};
	let conversation = await open();
	t.after(async () => {
		await harness.close(context);
		await adapter.close();
	});
	// Seed before attaching transcript observers. These are individual committed entries, not one giant message array.
	await conversation.commit(async (tx) => {
		for (let i = 0; i < 20_001; i++)
			await tx.appendEntry(UserEntry, conversation.id, {
				model: [{ role: "user", content: `OLD ${i} ${"x".repeat(128)}`, timestamp: i }],
			});
	}, context);
	await turn.record(context);
	await adapter.bindHarness(harness, conversation.id);
	guarded = true;
	let signalStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const check = (messages: readonly Message[]) => {
		assert.ok(messages.length < 20);
		assert.doesNotMatch(JSON.stringify(messages), /OLD /);
		assert.match(contentText(messages[1]!.content), /SAVED VIEW/);
		assert.ok(getCurrentTools(messages).some((tool) => tool.name === "codemode"));
		assert.ok(adapter.session.messages.length < 20);
	};
	faux.setResponses([
		async (ctx) => {
			check(ctx.messages);
			return fauxAssistantMessage(
				{ type: "toolCall", name: "codemode", id: "once", arguments: { code: 'text("committed tool result");' } },
				{ stopReason: "toolUse" },
			);
		},
		async (ctx, options) => {
			check(ctx.messages);
			assert.ok(ctx.messages.some((message) => message.role === "toolResult" && !message.isError));
			signalStarted();
			return new Promise((_resolve, reject) =>
				options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }),
			);
		},
	]);
	await conversation.submit({ type: "input", requestId: "run", content: "new input" }, context);
	await started;
	const before = await harness.snapshot(LiveDoc, conversation.id, context);
	assert.ok(before?.run);
	await harness.close(context);
	await adapter.close();
	guarded = false;
	conversation = await open();
	await adapter.bindHarness(harness, conversation.id);
	guarded = true;
	faux.setResponses([
		async (ctx) => {
			check(ctx.messages);
			assert.ok(
				ctx.messages.some(
					(message) =>
						message.role === "toolResult" && contentText(message.content).includes("committed tool result"),
				),
			);
			return fauxAssistantMessage("recovered answer");
		},
	]);
	await conversation.waitForIdle(context);
	await turn.record(context);
	await adapter.refreshUsage(context);
	assert.ok((adapter.usage.current.context?.tokens ?? Infinity) < 10_000);
	assert.equal(prefixes.size, 1, "recovery reuses the same saved turn view");
	assert.equal(faux.state.callCount, 3, "the tool is not replayed by a second model loop");
	assert.ok(boundedReads > 10, "exercise preparation, SDK tool hooks, recovery and usage reads");
	assert.ok(keys.size >= 20_005);
	guarded = false;
	const transcript = await conversation.context(context);
	assert.equal(
		transcript.messages.filter(
			(message) => message.role === "user" && contentText(message.content).startsWith("OLD "),
		).length,
		20_001,
	);
	assert.equal(transcript.messages.filter((message) => message.role === "toolResult").length, 1);
	assert.equal(contentText(transcript.messages.at(-1)!.content), "recovered answer");
	const view = await conversation.viewState(context);
	assert.ok(view.value && view.value.entries.length > 20_001, "display still sees the full transcript");
	await assert.rejects(adapter.session.prompt("forbidden"), /Only durable Harness/);
	const fork = await conversation.fork(transcript.entries[100]!.id, { ownership: { kind: "ownerless" } }, context);
	conversationId = fork.id;
	assert.equal((await turn.context(context)).messages.length, 0, "a rewound idle fork never mirrors its future run");
});

for (const mutation of ["overflow", "edit"] as const)
	test(`control ${mutation} fails before provider dispatch`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "control-bounds-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const storage = await openNodeSqliteStorage(join(root, "harness.sqlite"));
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const faux = fauxProvider();
		runtime.registerNativeProvider(faux.provider);
		let harness!: Harness, id!: Parameters<Harness["conversation"]>[0];
		const turn = new ControlTurn(
			async () => ({ lines: [] }),
			() => harness,
			storage,
			() => id,
		);
		const registry = createRegistry();
		let cutoff!: EntryId;
		const extension = {
			name: "bounds",
			sections: [
				section("bounds", async () => {
					await harness.commit(async (tx) => {
						for (let i = 0; i < (mutation === "overflow" ? 4096 : 1); i++)
							await tx.appendEntry(AssistantEntry, id, {
								...(mutation === "edit" ? { edits: [{ target: cutoff, action: "omit" as const }] } : {}),
								model: [],
							});
					}, context);
					return "bounded";
				}),
			],
		};
		registry.install(extension);
		harness = await Harness.open(
			storage,
			{ models: runtime, registry: turn.registry(registry), settings: { compaction: { enabled: false } } },
			context,
		);
		t.after(() => harness.close(context));
		const conversation = await harness.root(context, {
			agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, extensions: [extension] },
		});
		id = conversation.id;
		await conversation.commit(async (tx) => {
			cutoff = (await tx.appendEntry(UserEntry, id, { model: [] })).id;
		}, context);
		let dispatches = 0;
		const stream = runtime.streamSimple.bind(runtime);
		runtime.streamSimple = (...args) => {
			dispatches++;
			return stream(...args);
		};
		await conversation.submit({ type: "input", content: "input" }, context);
		await conversation.waitForIdle(context);
		await assert.rejects(turn.context(context), mutation === "overflow" ? /4096/ : /context edits/);
		await assert.rejects(turn.context(context, cutoff), /cutoff precedes/);
		assert.equal(dispatches, 0);
		assert.equal(faux.state.callCount, 0);
	});

test("deferred polling uses bounded context when the result starts a tool round", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "control-poll-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const storage = await openNodeSqliteStorage(join(root, "harness.sqlite"));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ deferred: { pendingFetches: 0, pollAfterMs: 0 } });
	runtime.registerNativeProvider(faux.provider);
	let harness!: Harness,
		id!: Parameters<Harness["conversation"]>[0],
		executions = 0;
	const turn = new ControlTurn(
		async (action) => (action === "prepare" ? { lines: [] } : null),
		() => harness,
		storage,
		() => id,
	);
	const tool: ToolRegistration = {
		name: "probe",
		description: "offline",
		parameters: Type.Object({}),
		execute: async () => {
			executions++;
			return { output: [{ type: "text", text: "tool ran" }] };
		},
	};
	const registry = createRegistry();
	const extension = turn.prepare({ name: "poll", tools: [tool] }, () => {});
	registry.install(extension);
	harness = await Harness.open(
		storage,
		{
			models: runtime,
			registry: turn.registry(registry),
			settings: {
				stream: { deferred: true },
				compaction: { enabled: false },
				toolExecution: "sequential",
			},
		},
		context,
	);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, {
		agent: {
			model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
			extensions: [extension],
			tools: [tool],
		},
	});
	id = conversation.id;
	await conversation.commit(async (tx) => {
		for (let i = 0; i < 100; i++)
			await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: "OLD", timestamp: i }] });
	}, context);
	await turn.record(context);
	const scan = storage.scanEntries.bind(storage);
	storage.scanEntries = (query, limit, cursor, ctx) => {
		if (limit > 1) assert.ok(query.minEntryId !== undefined, "poll must not materialize retained context");
		return scan(query, limit, cursor, ctx);
	};
	faux.setResponses([
		async (ctx) => {
			assert.doesNotMatch(JSON.stringify(ctx.messages), /OLD/);
			return fauxAssistantMessage(
				{ type: "toolCall", name: "probe", id: "poll-tool", arguments: {} },
				{ stopReason: "toolUse" },
			);
		},
		async (ctx) => {
			assert.ok(ctx.messages.some((message) => message.role === "toolResult" && !message.isError));
			return fauxAssistantMessage("done");
		},
	]);
	await conversation.submit({ type: "input", content: "defer then run a tool" }, context);
	await conversation.waitForIdle(context);
	assert.equal(executions, 1);
	assert.equal(faux.state.callCount, 2);
	assert.equal(faux.state.deferredFetchCount, 2);
});
