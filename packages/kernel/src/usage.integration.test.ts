import assert from "node:assert/strict";
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
import type { SessionUsage } from "@pilot/protocol";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

const context = BACKGROUND_CONTEXT;
const contextWindow = 32_000;
const snapshot = {
	fetchedAt: 1_700_000_000_000,
	snapshot: {
		provider: "anthropic",
		windows: [{ label: "5 hours", usedPercent: 27, resetsAt: "2026-07-04T12:00:00Z" }],
	},
};
const subscription = { fetchedAt: snapshot.fetchedAt, ...snapshot.snapshot };

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
		async open(onUsageChanged?: (usage: SessionUsage) => void) {
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
	adapter.bindHarness(harness, conversation.id);
	return { harness, conversation };
}

test("native usage captures extension startup and later bus events, ignores malformed data, and unsubscribes", async (t) => {
	let startupCount = 0;
	const f = await fixture(t, [
		(pi) => {
			pi.on("session_start", () => {
				startupCount++;
				pi.events.emit("usage:snapshot", { fetchedAt: "malformed", snapshot: null });
				pi.events.emit("usage:snapshot", snapshot);
			});
		},
	]);
	const changes: SessionUsage[] = [];
	const adapter = await f.open((usage) => changes.push(usage));
	assert.equal(startupCount, 1);
	assert.deepEqual(changes, [{ subscription }]);
	assert.deepEqual(adapter.usage.current, { subscription });

	const later = {
		fetchedAt: snapshot.fetchedAt + 1,
		snapshot: {
			provider: "openai",
			windows: [{ label: "Week", usedPercent: 54 }],
			error: "temporarily unavailable",
			accessToken: "must-not-be-forwarded",
		},
		credentials: { apiKey: "must-not-be-forwarded" },
	};
	f.bus.emit("usage:snapshot", later);
	const expected = {
		subscription: {
			fetchedAt: later.fetchedAt,
			provider: "openai",
			windows: [{ label: "Week", usedPercent: 54 }],
			error: "temporarily unavailable",
		},
	};
	assert.deepEqual(adapter.usage.current, expected);
	assert.deepEqual(changes.at(-1), expected);
	f.bus.emit("usage:snapshot", later);
	assert.equal(changes.length, 2, "identical events do not publish twice");
	for (const malformed of [
		null,
		[],
		{},
		{ ...snapshot, fetchedAt: Number.NaN },
		{ ...snapshot, snapshot: { windows: "bad" } },
		{ ...snapshot, snapshot: { windows: [{ label: "bad", usedPercent: -1 }] } },
		{ ...snapshot, snapshot: { provider: "unknown", windows: [] } },
	]) {
		assert.doesNotThrow(() => f.bus.emit("usage:snapshot", malformed));
	}
	assert.equal(changes.length, 2);
	assert.deepEqual(adapter.usage.current, expected);

	await adapter.close();
	await adapter.close();
	f.bus.emit("usage:snapshot", snapshot);
	assert.equal(changes.length, 2, "closed adapters no longer receive usage");
});

test("without a usage extension, refresh reads committed Harness context without changing native history", async (t) => {
	const f = await fixture(t);
	const changes: SessionUsage[] = [];
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
	assert.deepEqual(adapter.usage.current, {
		context: { tokens: 2, contextWindow, percent: (2 / contextWindow) * 100 },
	});
	assert.deepEqual(changes, [adapter.usage.current]);
	assert.deepEqual(adapter.session.sessionManager.getEntries(), nativeEntries);
	assert.deepEqual(adapter.session.messages, nativeMessages);
	assert.deepEqual(await conversation.context(context), before);
	assert.deepEqual(await harness.inspect(context), inspection, "refresh does not create tasks or submissions");
	await adapter.refreshUsage(context);
	assert.equal(changes.length, 1);
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
	f.bus.emit("usage:snapshot", snapshot);
	await adapter.refreshUsage(context);
	assert.deepEqual(adapter.usage.current, {
		subscription,
		context: { tokens: 153, contextWindow, percent: (153 / contextWindow) * 100 },
	});

	await conversation.reset("fresh123", context);
	await conversation.waitForIdle(context);
	await adapter.refreshUsage(context);
	assert.deepEqual(adapter.usage.current, {
		subscription,
		context: { tokens: 2, contextWindow, percent: (2 / contextWindow) * 100 },
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
	assert.equal(adapter.session.model?.api, "pi-virtual", "refresh leaves the selected virtual model unchanged");
	assert.equal(f.faux.state.callCount, 0);
});

test("KernelSession exposes startup usage for ready and publishes committed final-response context", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t, [
		(pi) => {
			pi.on("session_start", () => pi.events.emit("usage:snapshot", snapshot));
		},
	]);
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
	const changes: SessionUsage[] = [];
	const working: boolean[] = [];
	let usageChanged: ((usage: SessionUsage) => void) | undefined;
	let settle!: () => void;
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const spec = {
		sessionId: "offline-usage",
		cwd: f.root,
		agentDir: f.options.agentDir,
		storageDir: join(f.root, "storage"),
	};
	const session = await KernelSession.open(spec, {
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
	assert.deepEqual(session.usage, { subscription, context: { tokens: 0, contextWindow, percent: 0 } });
	assert.deepEqual(changes.at(-1), session.usage, "ready can read the same state as the usage hook");
	assert.equal(session.working, false);
	const readyUsage = session.usage;
	readyUsage.subscription!.windows[0]!.usedPercent = 999;
	assert.equal(session.usage.subscription!.windows[0]!.usedPercent, 27, "ready getter returns a detached snapshot");

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
	assert.deepEqual(session.usage, {
		subscription,
		context: { tokens, contextWindow, percent: (tokens / contextWindow) * 100 },
	});
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
		onWorking: () => {},
		onUsageChanged: (usage) => changes.push(usage),
	});
	f.cleanup.push(() => restored.close());
	assert.deepEqual(restored.usage, {
		subscription,
		context: { tokens: tokens + 1, contextWindow, percent: ((tokens + 1) / contextWindow) * 100 },
	});
	assert.equal(f.faux.state.callCount, 1, "restoring ready usage never invokes a model");
});
