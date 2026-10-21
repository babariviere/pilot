import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Message,
} from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { createEventBus, type ExtensionFactory, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AssistantEntry, createRegistry, Harness, MemoryStorage, UserEntry } from "@earendil-works/pi-durable";
import type { UsageObservation } from "@pilot/protocol";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";
import type { KernelUsage } from "./usage.ts";

const context = BACKGROUND_CONTEXT;
const contextWindow = 32_000;
function assertBaseUsage(actual: KernelUsage, expected: Omit<KernelUsage, "accounting">): void {
	assert.deepEqual({ context: actual.context, provider: actual.provider }, expected);
}
async function fixture(t: TestContext, extensions: ExtensionFactory[] = []) {
	const root = await mkdtemp(join(tmpdir(), "pilot-usage-"));
	const cleanup: Array<() => Promise<void>> = [];
	t.after(async () => {
		try {
			for (const close of cleanup.reverse()) await close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	// Fail rather than silently using credentials or a network provider if isolation regresses.
	t.mock.method(globalThis, "fetch", () => {
		assert.fail("offline usage integration must not access the network");
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({
		provider: "pilot-usage-test",
		models: [{ id: "offline", contextWindow }],
		tokenSize: { min: 4, max: 4 },
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const bus = createEventBus();
	const options: NativeAdapterOptions = {
		cwd: root,
		agentDir: join(root, "agent"),
		projectTrusted: false,
		settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
		sessionOptions: { modelRuntime, model: faux.getModel() },
		bundledExtensions: false,
		loaderOptions: {
			cwd: root,
			agentDir: join(root, "agent"),
			eventBus: bus,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Offline usage integration fixture.",
			appendSystemPrompt: [],
			extensionFactories: extensions,
		},
	};
	return {
		root,
		options,
		bus,
		faux,
		cleanup,
		async open(onUsageChanged?: (usage: KernelUsage) => void) {
			const adapter = await NativeAdapter.open({ ...options, onUsageChanged });
			cleanup.push(() => adapter.close());
			return adapter;
		},
	};
}

async function bindHarness(f: Awaited<ReturnType<typeof fixture>>, adapter: NativeAdapter) {
	const registry = createRegistry();
	registry.install(adapter.extension);
	const harness = await Harness.open(new MemoryStorage(), { models: adapter.models, registry }, context);
	f.cleanup.push(() => harness.close(context));
	const conversation = await harness.root(context, {
		agent: { model: adapter.model, extensions: [adapter.extension], tools: [] },
	});
	await adapter.bindHarness(harness, conversation.id);
	return { harness, conversation };
}

test("native usage ignores the pi event bus; subscription windows are served by the daemon", async (t) => {
	const f = await fixture(t, [
		(pi) => {
			pi.on("session_start", () => {
				pi.events.emit("usage:snapshot", { fetchedAt: 1, snapshot: { provider: "anthropic", windows: [] } });
			});
		},
	]);
	const changes: KernelUsage[] = [];
	const adapter = await f.open((usage) => changes.push(usage));
	f.bus.emit("usage:snapshot", { fetchedAt: 2, snapshot: { provider: "openai", windows: [] } });
	assert.deepEqual(adapter.usage.current, {});
	assert.deepEqual(changes, []);
});

test("refresh reads committed Harness context without changing native history", async (t) => {
	const f = await fixture(t);
	const changes: KernelUsage[] = [];
	const adapter = await f.open((usage) => changes.push(usage));
	assert.deepEqual(adapter.usage.current, {});
	await adapter.refreshUsage(context);
	assert.deepEqual(changes, [], "unbound refresh is harmless");
	const { harness, conversation } = await bindHarness(f, adapter);
	await conversation.commit(async (tx) => {
		await tx.appendEntry(UserEntry, conversation.id, {
			model: [{ role: "user", content: "abcdefgh", timestamp: 1 }],
		});
	}, context);
	// Deliberately disagree with the canonical transcript. refreshUsage must not use or rebuild this mirror.
	adapter.session.sessionManager.appendMessage({ role: "user", content: "native-only".repeat(100), timestamp: 2 });
	adapter.session.agent.state.messages = [{ role: "user", content: "live tool state", timestamp: 3 }];
	const nativeEntries = structuredClone(adapter.session.sessionManager.getEntries());
	const nativeMessages = structuredClone(adapter.session.messages);
	const before = await conversation.context(context);
	const inspection = await harness.inspect(context);
	await adapter.refreshUsage(context);
	assertBaseUsage(adapter.usage.current, {
		context: { tokens: 3, contextWindow, percent: (3 / contextWindow) * 100 },
		provider: adapter.model.provider,
	});
	assert.deepEqual(changes, [adapter.usage.current]);
	assert.deepEqual(adapter.session.sessionManager.getEntries(), nativeEntries);
	assert.deepEqual(adapter.session.messages, nativeMessages);
	assert.deepEqual(await conversation.context(context), before);
	assert.deepEqual(await harness.inspect(context), inspection, "refresh does not create tasks or submissions");
	await adapter.refreshUsage(context);
	assert.equal(changes.length, 1);
});

test("native sync borrows its return view while prompt preparation and native history remain isolated", async (t) => {
	const f = await fixture(t);
	const adapter = await f.open();
	const { harness, conversation } = await bindHarness(f, adapter);
	await conversation.commit(async (tx) => {
		await tx.appendEntry(UserEntry, conversation.id, {
			model: [{ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 }],
		});
	}, context);
	const view = await conversation.context(context);
	t.mock.method(harness, "conversation", async () => conversation);
	t.mock.method(conversation, "context", async () => view);
	const clone = structuredClone;
	let messageArrayClones = 0;
	t.mock.method(globalThis, "structuredClone", <T>(value: T, options?: Parameters<typeof structuredClone>[1]) => {
		if (
			Array.isArray(value) &&
			value.length === view.messages.length &&
			value.every((message, index) => message === view.messages[index])
		)
			messageArrayClones++;
		return clone(value, options);
	});
	// biome-ignore lint/complexity/useLiteralKeys: Inspect the private synchronization boundary.
	assert.equal(await adapter["sync"](context), view.messages);
	assert.equal(messageArrayClones, 0, "ignored sync results do not clone the entire message array");
	const mirrored = adapter.session.messages.find((message) => message.role === "user");
	assert.ok(mirrored?.role === "user" && Array.isArray(mirrored.content));
	const block = mirrored.content[0];
	assert.ok(block?.type === "text");
	block.text = "native mutation";
	const canonical = view.messages.find((message) => message.role === "user");
	assert.ok(canonical?.role === "user");
	assert.deepEqual(canonical.content, [{ type: "text", text: "original" }]);
	// biome-ignore lint/complexity/useLiteralKeys: Inspect the private prompt isolation boundary.
	await adapter["preparePrompt"](context);
	assert.equal(messageArrayClones, 1, "prompt preparation retains its detached message copy");
	assert.deepEqual(canonical.content, [{ type: "text", text: "original" }]);
});

test("committed response usage anchors trailing context, while resets discard old measurements", async (t) => {
	const f = await fixture(t);
	const adapter = await f.open();
	const { conversation } = await bindHarness(f, adapter);
	const response: AssistantMessage = {
		...fauxAssistantMessage("final answer"),
		provider: adapter.model.provider,
		model: adapter.model.modelId,
		usage: {
			input: 80,
			output: 10,
			cacheRead: 40,
			cacheWrite: 20,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const trailing: Message = { role: "user", content: "123456789012", timestamp: response.timestamp + 1 };
	await conversation.commit(async (tx) => {
		await tx.appendEntry(UserEntry, conversation.id, {
			model: [{ role: "user", content: "old prompt".repeat(100), timestamp: 1 }],
		});
		await tx.appendEntry(AssistantEntry, conversation.id, { model: [response] });
		await tx.appendEntry(UserEntry, conversation.id, { model: [trailing] });
	}, context);
	await adapter.refreshUsage(context);
	assertBaseUsage(adapter.usage.current, {
		provider: adapter.model.provider,
		context: { tokens: 154, contextWindow, percent: (154 / contextWindow) * 100 },
	});

	await conversation.reset("fresh123", context);
	await conversation.waitForIdle(context);
	await adapter.refreshUsage(context);
	assertBaseUsage(adapter.usage.current, {
		provider: adapter.model.provider,
		context: { tokens: 3, contextWindow, percent: (3 / contextWindow) * 100 },
	});
});

test("virtual selection displays the latest successful physical response's context window without routing", async (t) => {
	const f = await fixture(t);
	const adapter = await f.open();
	const virtualWindow = 1_000_000;
	adapter.session.modelRuntime.registerVirtualModel({
		provider: "pilot-usage-router",
		id: "auto",
		name: "Offline router",
		contextWindow: virtualWindow,
		route: () => assert.fail("usage refresh must not route or invoke a model"),
	});
	const virtual = adapter.session.modelRuntime.getModel("pilot-usage-router", "auto");
	assert.ok(virtual);
	await adapter.session.setModel(virtual);
	const { conversation } = await bindHarness(f, adapter);
	await adapter.refreshUsage(context);
	assert.deepEqual(adapter.usage.current.context, { tokens: 0, contextWindow: virtualWindow, percent: 0 });
	assert.equal(adapter.usage.current.provider, "pilot-usage-router");
	const physical = f.faux.getModel();
	const response = {
		...fauxAssistantMessage("physical answer"),
		api: physical.api,
		provider: physical.provider,
		model: physical.id,
	};
	response.usage = { ...response.usage, input: 90, output: 10, totalTokens: 100 };
	await conversation.commit(async (tx) => {
		await tx.appendEntry(AssistantEntry, conversation.id, { model: [response] });
	}, context);
	await adapter.refreshUsage(context);
	assert.deepEqual(adapter.usage.current.context, {
		tokens: 100,
		contextWindow,
		percent: (100 / contextWindow) * 100,
	});
	assert.equal(adapter.usage.current.provider, physical.provider, "subscription lookup follows the physical route");
	assert.equal(adapter.session.model?.api, "pi-virtual", "refresh leaves the selected virtual model unchanged");
	assert.equal(f.faux.state.callCount, 0);
});

test("KernelSession exposes startup usage for ready and publishes committed final-response context", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const openAdapter = NativeAdapter.open;
	// KernelSession has no public SDK DI argument. Replace only its opening boundary with the real offline SDK adapter.
	t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, {
			...options,
			...f.options,
			sessionId: options.sessionId,
			sessionFile: options.sessionFile,
			model: options.model,
			onUsageChanged: options.onUsageChanged,
		}),
	);
	const changes: KernelUsage[] = [];
	const captured = new Map<string, UsageObservation>();
	let capturedRequest!: () => void;
	const requestCaptured = new Promise<void>((resolve) => {
		capturedRequest = resolve;
	});
	const reportUsageHistory = async (row: UsageObservation) => {
		captured.set(row.operationId, structuredClone(row));
		if (row.kind === "request") capturedRequest();
		return "stored" as const;
	};
	const working: boolean[] = [];
	let usageChanged: ((usage: KernelUsage) => void) | undefined;
	let settle!: () => void;
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const spec = {
		sessionId: randomUUID(),
		usageHistory: { generation: randomUUID(), captureFloor: 0, retentionFloor: 0 },
		cwd: f.root,
		agentDir: f.options.agentDir,
		storageDir: join(f.root, "storage"),
	};
	const session = await KernelSession.open(spec, {
		reportUsageHistory,
		onUsageChanged: (usage) => {
			changes.push(usage);
			usageChanged?.(usage);
		},
		onWorking: (value) => {
			working.push(value);
			if (!value) settle();
		},
	});
	f.cleanup.push(() => session.close());
	const waitForTokens = (tokens: number): Promise<void> => {
		if (session.usage.context?.tokens === tokens) return Promise.resolve();
		return new Promise((resolve) => {
			usageChanged = (usage) => {
				if (usage.context?.tokens !== tokens) return;
				usageChanged = undefined;
				resolve();
			};
		});
	};
	const provider = f.faux.getModel().provider;
	assertBaseUsage(session.usage, { provider, context: { tokens: 0, contextWindow, percent: 0 } });
	assert.equal(session.usage.accounting?.direct.activity.count, 0);
	assert.deepEqual(changes.at(-1), session.usage, "ready can read the same state as the usage hook");
	assert.equal(session.working, false);
	const readyUsage = session.usage;
	readyUsage.context!.tokens = 999;
	assert.equal(session.usage.context!.tokens, 0, "ready getter returns a detached snapshot");

	f.faux.setResponses([fauxAssistantMessage("offline final response")]);
	await session.submit("offline-input", "Hello offline model", "followUp");
	await session.conversation.waitForIdle(context);
	await settled;
	const view = await session.conversation.context(context);
	const final = view.messages.findLast((message) => message.role === "assistant");
	assert.ok(final?.role === "assistant");
	assert.equal(final.stopReason, "stop");
	assert.equal(f.faux.state.callCount, 1, "only the durable Harness invokes the offline model");
	const tokens = calculateContextTokens(final.usage);
	assert.ok(tokens > 0);
	// Lifecycle notification precedes the same batch's asynchronous usage refresh.
	await waitForTokens(tokens);
	await requestCaptured;
	const capturedRow = [...captured.values()].find((row) => row.kind === "request")!;
	assert.equal(capturedRow.coverage, "committed");
	assert.equal(capturedRow.physicalModel?.provider, provider);
	assert.equal(capturedRow.tokens?.output, final.usage.output);
	assert.equal(capturedRow.attribution?.chatId, spec.sessionId);
	assertBaseUsage(session.usage, {
		provider,
		context: { tokens, contextWindow, percent: (tokens / contextWindow) * 100 },
	});
	assert.equal(session.usage.accounting?.direct.activity.count, 1);
	assert.ok((session.usage.accounting?.direct.tokens.output ?? 0) > 0);
	assert.deepEqual(changes.at(-1), session.usage);
	assert.deepEqual(working, [true, false]);
	assert.equal(session.working, false);

	// A passive committed message also refreshes the status watch without another model run.
	const trailing: Message = { role: "user", content: "tail", timestamp: final.timestamp + 1 };
	await session.conversation.submit({ type: "write", entry: { kind: UserEntry.kind, model: [trailing] } }, context);
	await waitForTokens(tokens + estimateMessageTokens(trailing));
	assert.deepEqual(changes.at(-1), session.usage, "passive committed messages refresh the usage hook");
	// Ready usage is reconstructed from committed history, without another model call.
	await session.close();
	const restored = await KernelSession.open(spec, {
		reportUsageHistory,
		onWorking: () => {},
		onUsageChanged: (usage) => changes.push(usage),
	});
	f.cleanup.push(() => restored.close());
	const restoredTokens = tokens + estimateMessageTokens(trailing);
	assertBaseUsage(restored.usage, {
		provider,
		context: { tokens: restoredTokens, contextWindow, percent: (restoredTokens / contextWindow) * 100 },
	});
	assert.equal(restored.usage.accounting?.direct.activity.count, 1);
	assert.equal(f.faux.state.callCount, 1, "restoring ready usage never invokes a model");
	assert.equal([...captured.values()].filter((row) => row.kind === "request").length, 1);
});
