import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createEventBus, type ExtensionFactory, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ConversationBusy, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { SessionUsage } from "@pilot/protocol";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

const context = BACKGROUND_CONTEXT;
const first = "pilot-model-a/one";
const second = "pilot-model-a/two";
const third = "pilot-model-b/three";
const subscription = {
	fetchedAt: 100,
	snapshot: { provider: "anthropic", windows: [{ label: "5 hours", usedPercent: 20 }] },
};

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

async function fixture(t: TestContext, extensions: ExtensionFactory[] = []) {
	const root = await mkdtemp(join(tmpdir(), "pilot-model-"));
	const sessions: KernelSession[] = [];
	t.after(async () => {
		for (const session of sessions.reverse()) await session.close();
		await rm(root, { recursive: true, force: true });
	});
	t.mock.method(globalThis, "fetch", () => assert.fail("model integration must stay offline"));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const a = fauxProvider({
		provider: "pilot-model-a",
		models: [
			{ id: "one", reasoning: true, contextWindow: 32_000 },
			{ id: "two", reasoning: true, contextWindow: 64_000 },
			{ id: "plain", reasoning: false },
			{ id: "outside", reasoning: true },
		],
	});
	const b = fauxProvider({
		provider: "pilot-model-b",
		models: [{ id: "three", reasoning: true, contextWindow: 128_000 }],
	});
	runtime.registerNativeProvider(a.provider);
	runtime.registerNativeProvider(b.provider);
	runtime.getModel("pilot-model-a", "two")!.thinkingLevelMap = { minimal: null, xhigh: "xhigh" };
	const bus = createEventBus();
	const settings = SettingsManager.inMemory({
		defaultTools: [],
		defaultProvider: "pilot-model-a",
		defaultModel: "one",
		enabledModels: [first, `${second}:high`, `${third}:low`, "pilot-model-a/plain"],
	});
	const adapters: NativeAdapter[] = [];
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) => {
		const adapter = await openAdapter.call(NativeAdapter, {
			...options,
			projectTrusted: false,
			settingsManager: settings,
			sessionOptions: { modelRuntime: runtime, model: a.getModel() },
			loaderOptions: {
				cwd: root,
				agentDir: join(root, "agent"),
				eventBus: bus,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: "Offline model selection fixture.",
				appendSystemPrompt: [],
				extensionFactories: extensions,
			},
		});
		adapters.push(adapter);
		return adapter;
	});
	const spec = {
		sessionId: "offline-model",
		cwd: root,
		storageDir: join(root, "durable"),
		agentDir: join(root, "agent"),
		model: first,
	};
	const changes: SessionUsage[] = [];
	const open = async (model = first) => {
		const session = await KernelSession.open(
			{ ...spec, model },
			{ onWorking: () => {}, onUsageChanged: (usage) => changes.push(usage) },
		);
		sessions.push(session);
		return session;
	};
	return { open, a, b, bus, changes, adapters };
}

test("model selection updates native and durable choices, context usage and thinking, and survives reopen", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	const adapter = f.adapters[0]!;
	const globalSettings = adapter.session.settingsManager.getGlobalSettings();
	f.bus.emit("usage:snapshot", subscription);
	await session.changeModel(second);
	assert.equal(session.model, second);
	assert.equal(adapter.session.model?.id, "two");
	assert.equal(session.thinkingLevel, "high");
	assert.equal((await session.conversation.agent(context)).thinkingLevel, "high");
	assert.equal(session.usage.context?.contextWindow, 64_000);
	assert.ok(session.usage.subscription, "same-provider selection retains subscription data");
	assert.equal(
		adapter.session.sessionManager.getEntries().findLast((entry) => entry.type === "model_change")?.modelId,
		"two",
	);
	await session.changeModel(third);
	assert.equal(session.model, third);
	assert.equal(session.thinkingLevel, "low");
	assert.deepEqual((await session.conversation.agent(context)).model, { provider: "pilot-model-b", modelId: "three" });
	assert.equal(session.usage.subscription, undefined, "provider switch removes stale subscription entirely");
	assert.ok(!("subscription" in f.changes.at(-1)!));
	assert.equal(session.usage.context?.contextWindow, 128_000);
	assert.equal(f.a.state.callCount + f.b.state.callCount, 0, "switching never runs a model");
	await session.close();
	const restored = await f.open(second);
	assert.equal(restored.model, third, "durable selection overrides creation/host defaults");
	assert.equal(f.adapters.at(-1)!.session.model?.id, "three");
	assert.equal(restored.thinkingLevel, "low");
	assert.equal((await restored.conversation.agent(context)).thinkingLevel, "low");
	assert.equal(restored.usage.context?.contextWindow, 128_000);
	assert.equal(f.a.state.callCount + f.b.state.callCount, 0);
	assert.deepEqual(
		adapter.session.settingsManager.getGlobalSettings(),
		globalSettings,
		"session-specific selection does not rewrite pi's global model, thinking or scope settings",
	);
});

test("provider switching preserves fresh usage emitted by native model_select and restores usage on rejection", async (t) => {
	const fresh = { fetchedAt: 200, snapshot: { provider: "openai", windows: [{ label: "Week", usedPercent: 45 }] } };
	const f = await fixture(t, [
		(pi) => {
			pi.on("model_select", (event) => {
				if (event.model.provider === "pilot-model-b") pi.events.emit("usage:snapshot", fresh);
			});
		},
	]);
	const session = await f.open();
	f.bus.emit("usage:snapshot", subscription);
	await session.changeModel(third);
	assert.deepEqual(session.usage.subscription, { fetchedAt: fresh.fetchedAt, ...fresh.snapshot });
	assert.deepEqual(f.changes.at(-1), session.usage, "modelChanged reads fresh usage, not a post-selection clear");
	await session.changeModel(first);
	f.bus.emit("usage:snapshot", subscription);
	const adapter = f.adapters[0]!;
	t.mock.method(adapter.session, "setModel", async () => {
		throw new Error("authentication unavailable");
	});
	await assert.rejects(session.changeModel(third), /authentication unavailable/);
	assert.equal(session.model, first);
	assert.deepEqual(session.usage.subscription, { fetchedAt: subscription.fetchedAt, ...subscription.snapshot });
	assert.deepEqual((await session.conversation.agent(context)).model, { provider: "pilot-model-a", modelId: "one" });
});

test("unavailable, fuzzy and out-of-scope model choices do not silently select a fallback", async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	const before = await session.conversation.agent(context);
	for (const choice of ["missing/model", "two", "pilot-model-a/tw", "pilot-model-a/outside", `${second}:high`, ""]) {
		await assert.rejects(session.changeModel(choice), /not available|model is required/);
		assert.equal(session.model, first);
		assert.deepEqual(await session.conversation.agent(context), before);
	}
});

test("running and queued conversations reject model changes without aborting or changing native selection", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	const response = deferred<ReturnType<typeof fauxAssistantMessage>>();
	f.a.setResponses([() => response.promise]);
	await session.submit("busy", "Keep working", "followUp");
	await session.submit("queued", "Then do more", "followUp");
	const before = await session.harness.inspect(context);
	await assert.rejects(session.changeModel(second), ConversationBusy);
	await assert.rejects(session.changeModel(first, "low"), ConversationBusy);
	assert.equal(session.model, first);
	assert.deepEqual(await session.harness.inspect(context), before);
	response.resolve(fauxAssistantMessage("done"));
	await session.abort();
	await session.conversation.waitForIdle(context);
	// An idle run can still have a retained queue after failure. Check the inbox on the commit line.
	await session.conversation.commit(async (tx) => {
		(await tx.doc(InboxDoc, session.conversation.id)).items.push({
			id: 999 as never,
			mode: "followUp",
			content: "retained",
		});
	}, context);
	await assert.rejects(session.changeModel(second), ConversationBusy);
	await assert.rejects(session.changeModel(first, "low"), ConversationBusy);
	assert.equal(session.model, first);
	assert.equal((await session.conversation.agent(context)).model?.modelId, "one");
	await session.conversation.commit(async (tx) => {
		(await tx.doc(InboxDoc, session.conversation.id)).items = [];
	}, context);
	await session.changeModel(second);
});

test("input preparation and model selection have synchronous admission barriers", { timeout: 15_000 }, async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	const adapter = f.adapters[0]!;
	const prepared = deferred<string>();
	const prepare = t.mock.method(adapter, "prepareInput", () => prepared.promise);
	f.a.setResponses([fauxAssistantMessage("done")]);
	const input = session.submit("preparing", "Preparing", "followUp");
	await assert.rejects(session.changeModel(second), ConversationBusy);
	prepared.resolve("Prepared");
	await input;
	prepare.mock.restore();
	await session.conversation.waitForIdle(context);
	const resolving = deferred();
	const resolveModel = adapter.resolveModel.bind(adapter);
	t.mock.method(adapter, "resolveModel", async (name: string) => {
		await resolving.promise;
		return resolveModel(name);
	});
	const change = session.changeModel(second);
	await assert.rejects(session.submit("racing", "Do not admit", "followUp"), ConversationBusy);
	await assert.rejects(session.changeModel(third), ConversationBusy);
	await assert.rejects(session.changeModel(first, "low"), ConversationBusy);
	resolving.resolve();
	await change;
	assert.equal(session.model, second);
	assert.equal((await session.harness.inspect(context)).submissions.length, 0);
});

test("explicit thinking overrides scope defaults, edits without model reselection, and survives reopening", async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	const adapter = f.adapters[0]!;
	const settings = adapter.session.settingsManager.getGlobalSettings();
	await session.changeModel(second, "low");
	assert.equal(session.thinkingLevel, "low", "explicit selection wins over :high scope default");
	const select = t.mock.method(adapter.session, "setModel", () => assert.fail("thinking-only edit reselected model"));
	await session.changeModel(second, "off");
	assert.equal(select.mock.callCount(), 0);
	assert.equal(session.model, second);
	assert.equal(adapter.session.thinkingLevel, "off");
	assert.equal((await session.conversation.agent(context)).thinkingLevel, "off");
	assert.deepEqual(adapter.session.settingsManager.getGlobalSettings(), settings);
	select.mock.restore();
	await session.close();
	const restored = await f.open(first);
	assert.equal(restored.model, second);
	assert.equal(restored.thinkingLevel, "off");
	assert.equal((await restored.conversation.agent(context)).thinkingLevel, "off");
	assert.equal(f.a.state.callCount + f.b.state.callCount, 0);
});

test("thinking validation follows actual model capabilities, rejecting unsupported levels before mutation", async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	const before = await session.conversation.agent(context);
	for (const level of ["", "unknown", "minimal", "max", " high "])
		await assert.rejects(session.changeModel(second, level), /Thinking level is not supported/);
	await assert.rejects(session.changeModel("pilot-model-a/plain", "low"), /Thinking level is not supported/);
	assert.equal(session.model, first);
	assert.deepEqual(await session.conversation.agent(context), before);
	await session.changeModel(second, "xhigh");
	assert.equal(session.thinkingLevel, "xhigh");
	await session.changeModel("pilot-model-a/plain", "off");
	assert.equal(session.thinkingLevel, "off");
});

test("failed durable thinking edits restore the native level without reselecting the model", async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	await session.changeModel(second);
	const adapter = f.adapters[0]!;
	const before = await session.conversation.agent(context);
	const commit = session.conversation.commit.bind(session.conversation);
	let commits = 0;
	t.mock.method(session.conversation, "commit", (...args: Parameters<typeof commit>) => {
		if (++commits === 3) throw new Error("configuration commit failed");
		return commit(...args);
	});
	t.mock.method(adapter.session, "setModel", () => assert.fail("thinking edit rollback reselected model"));
	await assert.rejects(session.changeModel(second, "low"), /configuration commit failed/);
	assert.equal(session.thinkingLevel, "high");
	assert.equal(session.model, second);
	assert.deepEqual(await session.conversation.agent(context), before);
});

test("idle-only input rejects live runs and retained inbox items but permits idempotent retry", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	const response = deferred<ReturnType<typeof fauxAssistantMessage>>();
	f.a.setResponses([() => response.promise]);
	await session.submit("idle-first", "Start only if idle", "steer", true);
	const before = await session.harness.inspect(context);
	await session.submit("idle-first", "Retry", "followUp", true);
	assert.deepEqual(await session.harness.inspect(context), before);
	await assert.rejects(session.submit("idle-rejected", "No queue", "steer", true), ConversationBusy);
	response.resolve(fauxAssistantMessage("done"));
	await session.conversation.waitForIdle(context);
	await session.conversation.commit(async (tx) => {
		(await tx.doc(InboxDoc, session.conversation.id)).items.push({
			id: 999 as never,
			mode: "followUp",
			content: "retained",
		});
	}, context);
	await session.submit("idle-first", "Retry after completion", "followUp", true);
	await assert.rejects(session.submit("idle-inbox", "Must not consume inbox", "followUp", true), ConversationBusy);
	assert.equal((await session.harness.snapshot(InboxDoc, session.conversation.id, context))?.items.length, 1);
	await session.conversation.commit(async (tx) => {
		(await tx.doc(InboxDoc, session.conversation.id)).items = [];
		(await tx.doc(LiveDoc, session.conversation.id)).compactions = [
			{ taskId: 999 as never, reason: "manual", blocking: false, attempt: 0 },
		];
	}, context);
	await assert.rejects(session.submit("idle-compacting", "No compaction race", "followUp", true), ConversationBusy);
	await session.conversation.commit(async (tx) => {
		delete (await tx.doc(LiveDoc, session.conversation.id)).compactions;
	}, context);
	f.a.setResponses([fauxAssistantMessage("done")]);
	await session.submit("idle-after", "Now idle", "followUp", true);
	await session.conversation.waitForIdle(context);
});

test("idle-only input checks durable state after native preparation and guards concurrent admissions", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	const prepared = deferred<string>();
	const prepare = t.mock.method(f.adapters[0]!, "prepareInput", () => prepared.promise);
	const input = session.submit("idle-preparing", "Prepare first", "followUp", true);
	await assert.rejects(session.submit("idle-racing", "Concurrent", "followUp", true), ConversationBusy);
	await session.conversation.commit(async (tx) => {
		(await tx.doc(InboxDoc, session.conversation.id)).items.push({
			id: 999 as never,
			mode: "followUp",
			content: "raced preparation",
		});
	}, context);
	prepared.resolve("Prepared");
	await assert.rejects(input, ConversationBusy);
	prepare.mock.restore();
	await session.conversation.commit(async (tx) => {
		(await tx.doc(InboxDoc, session.conversation.id)).items = [];
	}, context);
	f.a.setResponses([fauxAssistantMessage("done")]);
	await session.submit("idle-preparing", "Can retry rejected admission", "followUp", true);
	await session.conversation.waitForIdle(context);
});
