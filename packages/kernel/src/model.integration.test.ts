import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	Type,
} from "@earendil-works/pi-ai";
import {
	createEventBus,
	type ExtensionContext,
	type ExtensionFactory,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ConversationBusy, Harness, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { userText } from "./attempts.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";
import { readSessionSnapshot } from "./snapshot.ts";
import type { KernelUsage } from "./usage.ts";

const context = BACKGROUND_CONTEXT;
const first = "pilot-model-a/one";
const second = "pilot-model-a/two";
const third = "pilot-model-b/three";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

async function fixture(
	t: TestContext,
	extensions: ExtensionFactory[] = [],
	resources: (root: string) => Promise<Partial<NonNullable<NativeAdapterOptions["loaderOptions"]>>> = async () => ({}),
) {
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
	const loaded = await resources(root);
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
				...loaded,
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
	const changes: KernelUsage[] = [];
	const open = async (model = first) => {
		const session = await KernelSession.open(
			{ ...spec, model },
			{ onWorking: () => {}, onUsageChanged: (usage) => changes.push(usage) },
		);
		sessions.push(session);
		return session;
	};
	return { open, a, b, bus, changes, adapters, spec };
}

test("kernel coalesces durable progress without losing short final responses", {
	timeout: 15_000,
}, async (t) => {
	const open = Harness.open;
	const settings: unknown[] = [];
	t.mock.method(Harness, "open", (...args: Parameters<typeof Harness.open>) => {
		settings.push(args[1].settings);
		return open(...args);
	});
	const f = await fixture(t);
	f.a.setResponses([fauxAssistantMessage("Short final answer.")]);
	const session = await f.open();
	await session.submit("short-answer", "Answer briefly", "followUp");
	await session.conversation.waitForIdle(context);
	const snapshot = await readSessionSnapshot(f.spec.storageDir, f.spec.cwd);
	assert.ok(JSON.stringify(snapshot).includes("Short final answer."));
	await session.close();
	const restored = await f.open();
	assert.deepEqual(settings, [
		{ toolExecution: "sequential", progress: { partialIntervalMs: 250, outputIntervalMs: 250 } },
		{ toolExecution: "sequential", progress: { partialIntervalMs: 250, outputIntervalMs: 250 } },
	]);
	await restored.close();
});

test("jobs-style completions stay pending while Harness works and wake it once after settling", {
	timeout: 15_000,
}, async (t) => {
	let ctx!: ExtensionContext;
	let complete!: (name: string) => void;
	const pending: string[] = [];
	const notifications: string[] = [];
	const settled = deferred();
	const entered = deferred();
	const followUpEntered = deferred();
	const response = deferred<ReturnType<typeof fauxAssistantMessage>>();
	// Unblock the faux stream even if a pre-fix assertion fails.
	t.after(() => response.resolve(fauxAssistantMessage("Finished work.")));
	const f = await fixture(t, [
		(pi) => {
			const flush = () => {
				if (!ctx.isIdle() || !pending.length) return;
				const content = `Finished background jobs: ${pending.splice(0).join(", ")}`;
				notifications.push(content);
				pi.sendMessage(
					{ customType: "jobs.result", content, display: true },
					{
						deliverAs: "followUp",
						triggerTurn: true,
					},
				);
			};
			pi.on("session_start", (_event, context) => {
				ctx = context;
				complete = (name) => {
					pending.push(name);
					flush();
				};
			});
			pi.on("agent_settled", () => {
				flush();
				if (notifications.length && !pending.length) settled.resolve();
			});
		},
	]);
	f.a.setResponses([
		() => {
			entered.resolve();
			return response.promise;
		},
		() => {
			followUpEntered.resolve();
			return fauxAssistantMessage("Both jobs noted.");
		},
	]);
	const session = await f.open();
	assert.equal(ctx.isIdle(), true);
	await session.submit("work", "Do other work", "followUp");
	await entered.promise;
	assert.equal(ctx.isIdle(), false, "the dormant SDK loop must not report Harness as idle");
	complete("tests");
	complete("lint");
	assert.deepEqual(notifications, [], "busy completions must not create separate durable follow-ups");
	assert.equal((await session.harness.snapshot(InboxDoc, session.conversation.id, context))?.items.length, 0);
	response.resolve(fauxAssistantMessage("Finished work."));
	await settled.promise;
	await followUpEntered.promise;
	await session.conversation.waitForIdle(context);
	assert.deepEqual(notifications, ["Finished background jobs: tests, lint"]);
	assert.equal(f.a.state.callCount, 2, "one follow-up model turn for the whole batch");
	const view = await session.conversation.context(context);
	assert.deepEqual(
		view.messages.filter((message) => message.role === "user").map((message) => message.content),
		["Do other work", "Finished background jobs: tests, lint"],
	);
});

test("native settlement skips queued run boundaries and idle snapshots, and stops on close", {
	timeout: 15_000,
}, async (t) => {
	let settlements = 0;
	let ctx!: ExtensionContext;
	const settled = deferred();
	const f = await fixture(t, [
		(pi) => {
			pi.on("session_start", (_event, context) => {
				ctx = context;
			});
			pi.on("agent_settled", () => {
				assert.equal(ctx.isIdle(), true);
				settlements++;
				settled.resolve();
			});
		},
	]);
	const entered = deferred();
	const response = deferred<ReturnType<typeof fauxAssistantMessage>>();
	t.after(() => response.resolve(fauxAssistantMessage("First done.")));
	f.a.setResponses([
		() => {
			entered.resolve();
			return response.promise;
		},
		fauxAssistantMessage("Second done."),
	]);
	const session = await f.open();
	assert.equal(settlements, 0, "opening an idle session does not settle a nonexistent run");
	await session.submit("first", "First", "followUp");
	await entered.promise;
	await session.submit("second", "Second", "followUp");
	response.resolve(fauxAssistantMessage("First done."));
	await settled.promise;
	await session.conversation.waitForIdle(context);
	assert.equal(settlements, 1, "queued end/start in the same commit is not an idle boundary");
	assert.equal(ctx.isIdle(), true);
	await session.close();
	assert.equal(settlements, 1, "shutdown does not release pending job notifications");
	const restored = await f.open();
	assert.equal(ctx.isIdle(), true);
	assert.equal(settlements, 1, "reopening idle history does not emit a duplicate settlement");
	await restored.close();
});

test("native extensions remain busy through tool execution and multiple model rounds", {
	timeout: 15_000,
}, async (t) => {
	const busy: boolean[] = [];
	let settlements = 0;
	const settled = deferred();
	const f = await fixture(t, [
		(pi) => {
			pi.on("before_agent_start", (_event, ctx) => {
				busy.push(!ctx.isIdle());
			});
			pi.on("tool_call", (_event, ctx) => {
				busy.push(!ctx.isIdle());
			});
			pi.on("tool_result", (_event, ctx) => {
				busy.push(!ctx.isIdle());
			});
			pi.on("agent_settled", () => {
				settlements++;
				settled.resolve();
			});
			pi.registerTool({
				name: "probe",
				label: "Probe",
				description: "Check native idle state during a Harness tool.",
				parameters: Type.Object({}),
				execute: async (_id, _args, _signal, _update, ctx) => {
					busy.push(!ctx.isIdle());
					return { content: [{ type: "text", text: "Checked" }], details: undefined };
				},
			});
		},
	]);
	f.a.setResponses([
		fauxAssistantMessage(
			{ type: "toolCall", id: "probe-call", name: "probe", arguments: {} },
			{
				stopReason: "toolUse",
			},
		),
		fauxAssistantMessage("Done."),
	]);
	const session = await f.open();
	await session.submit("probe", "Run the probe", "followUp");
	await settled.promise;
	assert.deepEqual(busy, [true, true, true, true]);
	assert.equal(f.a.state.callCount, 2);
	assert.equal(settlements, 1, "an intermediate tool-use round is not a settlement");
});

test("native idle checks read committed compaction/inbox activity before async event delivery", {
	timeout: 15_000,
}, async (t) => {
	let ctx!: ExtensionContext;
	let settlements = 0;
	const settled = deferred();
	const f = await fixture(t, [
		(pi) => {
			pi.on("session_start", (_event, context) => {
				ctx = context;
			});
			pi.on("agent_settled", () => {
				settlements++;
				settled.resolve();
			});
		},
	]);
	const session = await f.open();
	const idleAtCommit: boolean[] = [];
	const stop = session.harness.subscribeCommits((publication) => {
		if (
			publication.changes.some(
				(change) =>
					change.type === "document" &&
					[LiveDoc.definition.kind, InboxDoc.definition.kind].includes(change.record.kind),
			)
		)
			idleAtCommit.push(ctx.isIdle());
	});
	t.after(stop);
	await session.conversation.commit(async (tx) => {
		(await tx.doc(LiveDoc, session.conversation.id)).compactions = [
			{ taskId: 999 as never, reason: "manual", blocking: false, attempt: 0 },
		];
	}, context);
	assert.equal(ctx.isIdle(), false);
	await session.conversation.commit(async (tx) => {
		delete (await tx.doc(LiveDoc, session.conversation.id)).compactions;
		(await tx.doc(InboxDoc, session.conversation.id)).items = [
			{ id: 999 as never, mode: "followUp", content: "retained after failure" },
		];
	}, context);
	assert.equal(ctx.isIdle(), false);
	assert.equal(settlements, 0, "compaction ending with a queued continuation is not idle");
	await session.conversation.commit(async (tx) => {
		(await tx.doc(InboxDoc, session.conversation.id)).items = [];
	}, context);
	await settled.promise;
	assert.deepEqual(idleAtCommit, [false, false, true], "no independently mutable adapter working flag");
	assert.equal(settlements, 1);
	assert.equal(f.a.state.callCount, 0, "checking activity never runs the dormant SDK loop");
});

test("current activity and later settlements advance while an earlier settlement handler is blocked", {
	timeout: 15_000,
}, async (t) => {
	const firstSettled = deferred();
	const laterSettled = deferred();
	const releaseHandler = deferred();
	const entered = deferred();
	const response = deferred<ReturnType<typeof fauxAssistantMessage>>();
	t.after(() => {
		releaseHandler.resolve();
		response.resolve(fauxAssistantMessage("Second done."));
	});
	let ctx!: ExtensionContext;
	let settlements = 0;
	const f = await fixture(t, [
		(pi) => {
			pi.on("session_start", (_event, context) => {
				ctx = context;
			});
			pi.on("agent_settled", async () => {
				assert.equal(ctx.isIdle(), true);
				if (++settlements === 1) {
					firstSettled.resolve();
					await releaseHandler.promise;
				} else laterSettled.resolve();
			});
		},
	]);
	f.a.setResponses([
		fauxAssistantMessage("First done."),
		() => {
			entered.resolve();
			return response.promise;
		},
	]);
	const session = await f.open();
	await session.submit("first", "First", "followUp");
	await firstSettled.promise;
	await session.submit("second", "Second", "followUp");
	assert.equal(session.working, true, "current activity must not wait for an extension handler");
	assert.equal(ctx.isIdle(), false);
	await entered.promise;
	response.resolve(fauxAssistantMessage("Second done."));
	await session.conversation.waitForIdle(context);
	assert.equal(session.working, false);
	assert.equal(ctx.isIdle(), true, "the source advances before coalesced notification delivery");
	releaseHandler.resolve();
	await laterSettled.promise;
	assert.equal(settlements, 2, "the coalesced busy/idle interval still produces a later settlement");
});

test("model selection updates native and durable choices, context usage and thinking, and survives reopen", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	const adapter = f.adapters[0]!;
	const globalSettings = adapter.session.settingsManager.getGlobalSettings();
	await session.changeModel(second);
	assert.equal(session.model, second);
	assert.equal(adapter.session.model?.id, "two");
	assert.equal(session.thinkingLevel, "high");
	assert.equal((await session.conversation.agent(context)).thinkingLevel, "high");
	assert.equal(session.usage.context?.contextWindow, 64_000);
	assert.equal(session.usage.provider, "pilot-model-a");
	assert.equal(
		adapter.session.sessionManager.getEntries().findLast((entry) => entry.type === "model_change")?.modelId,
		"two",
	);
	await session.changeModel(third);
	assert.equal(session.model, third);
	assert.equal(session.thinkingLevel, "low");
	assert.deepEqual((await session.conversation.agent(context)).model, { provider: "pilot-model-b", modelId: "three" });
	assert.equal(session.usage.provider, "pilot-model-b", "usage reports the selected provider for subscription lookup");
	assert.deepEqual(f.changes.at(-1), session.usage);
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

test("slash commands list prompt templates and skills, expand on input, and queue a manual compaction", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t, [], async (root) => {
		const prompt = join(root, "review.md");
		await writeFile(
			prompt,
			"---\ndescription: Review the diff\nargument-hint: <focus>\n---\nReview with focus on $1.\n",
		);
		const skill = join(root, "skills", "commit");
		await mkdir(skill, { recursive: true });
		await writeFile(
			join(skill, "SKILL.md"),
			"---\nname: commit\ndescription: Create a commit\n---\nCommit the work.\n",
		);
		return { additionalPromptTemplatePaths: [prompt], additionalSkillPaths: [skill] };
	});
	const session = await f.open();
	assert.deepEqual(session.commands, [
		{ name: "review", source: "prompt", description: "Review the diff", argumentHint: "<focus>" },
		{ name: "skill:commit", source: "skill", description: "Create a commit" },
	]);
	const adapter = f.adapters[0]!;
	assert.equal(await adapter.prepareInput("/review tests"), "Review with focus on tests.");
	assert.match(
		await adapter.prepareInput("/skill:commit now"),
		/^<skill name="commit"[\s\S]*Commit the work\.\n<\/skill>\n\nnow$/,
	);
	await session.compact("  keep test names  ");
});

test("a rejected provider switch keeps the previous provider's usage", async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	const adapter = f.adapters[0]!;
	t.mock.method(adapter.session, "setModel", async () => {
		throw new Error("authentication unavailable");
	});
	await assert.rejects(session.changeModel(third), /authentication unavailable/);
	assert.equal(session.model, first);
	assert.equal(session.usage.provider, "pilot-model-a");
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
	// Stop hands the user's queued message back for the composer.
	assert.deepEqual(await session.abort(), [{ requestId: "queued", content: "Then do more" }]);
	response.resolve(fauxAssistantMessage("done"));
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

test("retry, edit and restore continue from earlier points in attempts that survive reopening", {
	timeout: 30_000,
}, async (t) => {
	const f = await fixture(t);
	const failure = (message = "Invalid request") =>
		fauxAssistantMessage("", { stopReason: "error", errorMessage: message });
	const entries = async (session: KernelSession) =>
		(await session.conversation.entries({}, 100, undefined, context)).items.toReversed();
	const texts = async (session: KernelSession) =>
		(await entries(session))
			.filter((entry) => entry.kind !== "pi.system")
			.map((entry) =>
				entry.kind === "pi.user"
					? `user:${userText(entry)}`
					: `${entry.kind}:${(entry.model ?? [])
							.map((message) =>
								message.role === "assistant"
									? (message.errorMessage ??
										message.content.map((part) => (part.type === "text" ? part.text : "")).join(""))
									: "",
							)
							.join("")}`,
			);
	const run = async (
		session: KernelSession,
		content: string,
		...responses: ReturnType<typeof fauxAssistantMessage>[]
	) => {
		f.a.setResponses(responses);
		await session.submit(randomUUID(), content, "followUp");
		await session.conversation.waitForIdle(context);
	};

	let session = await f.open();
	await run(session, "first", fauxAssistantMessage("Answer one"));
	await run(session, "second", failure());
	assert.deepEqual(await texts(session), [
		"user:first",
		"pi.assistant:Answer one",
		"user:second",
		"pi.assistant:Invalid request",
	]);
	// The user switches model to get past the failure; the retry keeps that choice.
	await session.changeModel(second);
	const failed = (await entries(session)).at(-1)!;
	const retried = await session.rewind("retry", failed.id);
	assert.equal(retried.content, "second");
	assert.equal(retried.switched, true);
	assert.deepEqual(
		retried.attempts?.map((attempt) => [attempt.reason, attempt.active ?? false]),
		[
			[undefined, false],
			["retry", true],
		],
	);
	await assert.rejects(
		session.submit(randomUUID(), "late", "followUp"),
		ConversationBusy,
		"a retired kernel takes no input",
	);
	await session.close();

	session = await f.open();
	assert.equal(session.model, second);
	assert.deepEqual(await texts(session), ["user:first", "pi.assistant:Answer one"]);
	await run(session, "second", failure());
	const retriedAgain = await session.rewind("retry", (await entries(session)).at(-1)!.id);
	assert.deepEqual(
		retriedAgain.attempts?.map((attempt) => attempt.reason),
		[undefined, "retry"],
		"an attempt holding only a failed turn is replaced, not listed",
	);
	await session.close();

	session = await f.open();
	await run(session, "second", fauxAssistantMessage("Answer two"));
	const kept = session.conversation.id;
	const answer = (await entries(session)).find((entry) => entry.kind === "pi.assistant")!;
	const restored = await session.rewind("restore", answer.id);
	assert.equal(restored.content, undefined);
	assert.deepEqual(
		restored.attempts?.map((attempt) => attempt.reason),
		[undefined, "retry", "restore"],
	);
	await session.close();

	session = await f.open();
	assert.deepEqual(await texts(session), ["user:first", "pi.assistant:Answer one"]);
	await assert.rejects(session.activateAttempt(424242), /Unknown attempt/);
	assert.equal((await session.activateAttempt(Number(session.conversation.id))).switched, false);
	const activated = await session.activateAttempt(Number(kept));
	assert.equal(activated.switched, true);
	assert.deepEqual(
		activated.attempts?.map((attempt) => [attempt.reason, attempt.active ?? false]),
		[
			[undefined, false],
			["retry", true],
		],
		"the empty restore attempt is hidden once left",
	);
	await session.close();

	session = await f.open();
	assert.equal(session.conversation.id, kept);
	assert.deepEqual((await texts(session)).slice(-2), ["user:second", "pi.assistant:Answer two"]);
	const firstMessage = (await entries(session))[0]!;
	const edited = await session.rewind("edit", firstMessage.id);
	assert.equal(edited.content, "first");
	await session.close();

	session = await f.open();
	assert.deepEqual(await texts(session), [], "editing the first message starts from an empty conversation");
	assert.equal(session.model, second);
	assert.deepEqual(session.attempts?.at(-1)?.preview, "first");
	await session.close();
	const cold = await readSessionSnapshot(f.spec.storageDir, f.spec.cwd, false);
	const snapshot = cold.events[0];
	assert.equal(
		snapshot?.type === "snapshot" ? snapshot.entries.length : -1,
		0,
		"cold views follow the active attempt",
	);
	assert.equal(f.a.state.callCount + f.b.state.callCount, 4, "rewinding and switching never run a model");
});

test("rewinding rejects unknown entries and points that cannot be resent", { timeout: 15_000 }, async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	f.a.setResponses([fauxAssistantMessage("Answer")]);
	await session.submit(randomUUID(), "only", "followUp");
	await session.conversation.waitForIdle(context);
	const listed = (await session.conversation.entries({}, 10, undefined, context)).items;
	const user = listed.find((entry) => entry.kind === "pi.user");
	const assistant = listed.find((entry) => entry.kind === "pi.assistant");
	await assert.rejects(session.rewind("edit", 999_999), /not part of this conversation/);
	await assert.rejects(session.rewind("edit", assistant!.id), /Only a user message/);
	await assert.rejects(session.rewind("restore", user!.id), /Only an agent message/);
	await assert.rejects(session.rewind("restore", assistant!.id), /already the latest point/);
	assert.equal(session.attempts, undefined);
	await session.submit(randomUUID(), "still usable", "followUp");
});
