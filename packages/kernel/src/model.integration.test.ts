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
import { ConversationBusy, InboxDoc } from "@earendil-works/pi-durable";
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
			{ id: "outside", reasoning: true },
		],
	});
	const b = fauxProvider({
		provider: "pilot-model-b",
		models: [{ id: "three", reasoning: true, contextWindow: 128_000 }],
	});
	runtime.registerNativeProvider(a.provider);
	runtime.registerNativeProvider(b.provider);
	const bus = createEventBus();
	const settings = SettingsManager.inMemory({
		defaultTools: [],
		defaultProvider: "pilot-model-a",
		defaultModel: "one",
		enabledModels: [first, `${second}:high`, `${third}:low`],
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
	resolving.resolve();
	await change;
	assert.equal(session.model, second);
	assert.equal((await session.harness.inspect(context)).submissions.length, 0);
});
