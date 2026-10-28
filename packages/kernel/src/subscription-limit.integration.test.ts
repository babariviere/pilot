import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	Type,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-limit-kernel-"));
	const policy = join(root, "subscription-policy.json");
	const physical: { provider: "openai" | "anthropic" } = { provider: "openai" };
	const save = async (blocked: boolean) => {
		await writeFile(
			`${policy}.tmp`,
			JSON.stringify({
				version: 1,
				windows: blocked ? [{ provider: physical.provider, label: "Usage limit", usedPercent: 100 }] : [],
			}),
		);
		await rename(`${policy}.tmp`, policy);
	};
	await save(false);
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "offline" }] });
	runtime.registerNativeProvider(faux.provider);
	const completed = deferred(),
		entered = deferred(),
		finish = deferred(),
		reported = deferred();
	let effects = 0,
		session: KernelSession | undefined;
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, {
			...options,
			bundledExtensions: false,
			projectTrusted: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["effect"] }),
			sessionOptions: {
				modelRuntime: runtime,
				model: faux.getModel(),
				customTools: [
					{
						name: "effect",
						label: "effect",
						description: "Effect",
						parameters: Type.Object({}),
						execute: async (_id, _args, signal) => {
							effects++;
							entered.resolve();
							await finish.promise;
							assert.equal(signal?.aborted, false, "a usage pause never aborts a running tool");
							return { content: [{ type: "text", text: "saved" }], details: {} };
						},
					},
				],
			},
			loaderOptions: {
				cwd: root,
				agentDir: join(root, "agent"),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		}),
	);
	const open = async () =>
		(session = await KernelSession.open(
			{
				sessionId: "limit-test",
				cwd: root,
				storageDir: join(root, "durable"),
				agentDir: join(root, "agent"),
				subscriptionPolicy: policy,
			},
			{
				onWorking: (working, completion) => {
					if (!working && completion) completed.resolve();
				},
				reportSubscriptionLimit: async (limit) => {
					assert.equal(limit.provider, physical.provider);
					const entries = (await session!.conversation.context(BACKGROUND_CONTEXT)).entries;
					assert.equal(
						entries.filter((entry) => entry.kind === "pi.tool-result").length,
						1,
						"the tool result is committed before the usage pause",
					);
					await save(true);
					reported.resolve();
				},
			},
		));
	t.after(async () => {
		finish.resolve();
		await session?.close();
		await rm(root, { recursive: true, force: true });
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("effect", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." }),
		fauxAssistantMessage("finished"),
	]);
	return { open, save, faux, entered, finish, reported, completed, physical, effects: () => effects };
}

test("a late provider limit pauses after saving the active tool and survives restart without replay or a failed turn", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	let session = await f.open();
	await session.submit("stable", "work", "followUp");
	await f.entered.promise;
	assert.equal(f.faux.state.callCount, 1);
	f.finish.resolve();
	await f.reported.promise;
	assert.equal(session.working, true);
	assert.equal(session.completion, undefined);
	assert.equal(f.faux.state.callCount, 2);
	await session.pauseForUpdate();
	await session.close();
	session = await f.open();
	assert.equal(f.effects(), 1);
	await f.save(false);
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	await f.completed.promise;
	assert.equal(f.effects(), 1, "completed tool effects are never replayed");
	assert.equal(f.faux.state.callCount, 3, "only the rejected model request is retried");
	assert.equal(session.completion?.outcome, "done");
	const entries = (await session.conversation.context(BACKGROUND_CONTEXT)).entries;
	assert.equal(entries.filter((entry) => entry.kind === "pi.user").length, 1);
	assert.equal(entries.filter((entry) => entry.kind === "pi.tool-result").length, 1);
	assert.ok(!JSON.stringify(entries).includes("usage limit"), "the rejection never becomes a failed assistant entry");
	assert.ok(!JSON.stringify(entries).includes("interrupted"));
});

test("Stop during a usage pause cancels the pending request without replaying its tool on release", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	const session = await f.open();
	await session.submit("stable", "work", "followUp");
	await f.entered.promise;
	f.finish.resolve();
	await f.reported.promise;
	await session.abort();
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	await f.completed.promise;
	await f.save(false);
	assert.equal(f.effects(), 1);
	assert.equal(f.faux.state.callCount, 2);
	assert.equal(session.completion?.outcome, "stopped");
});

test("a routed request pauses its physical subscription, not a stale or virtual provider", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	f.physical.provider = "anthropic";
	f.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("effect", {})], { stopReason: "toolUse" }),
		async (_context, options) => {
			await options?.onPayload?.({}, { ...f.faux.getModel(), provider: "anthropic" });
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Claude AI usage limit reached" });
		},
		fauxAssistantMessage("finished"),
	]);
	const session = await f.open();
	await session.submit("stable", "work", "followUp");
	await f.entered.promise;
	f.finish.resolve();
	await f.reported.promise;
	assert.equal(session.completion, undefined);
	await f.save(false);
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	await f.completed.promise;
	assert.equal(f.effects(), 1);
	assert.equal(f.faux.state.callCount, 3);
});
