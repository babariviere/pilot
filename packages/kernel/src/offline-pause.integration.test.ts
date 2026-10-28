import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
import { setToolActivityCollectionEnabled } from "./tool-activity.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function until(check: () => boolean) {
	const end = Date.now() + 5000;
	while (!check()) {
		assert.ok(Date.now() < end, "timed out");
		await delay(2);
	}
}
async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pilot-offline-kernel-"));
	const policy = join(root, "connectivity.json");
	const quota = join(root, "subscription-policy.json");
	const online = async (online: boolean) => {
		await writeFile(`${policy}.tmp`, JSON.stringify({ version: 1, online, checkedAt: Date.now() }));
		await rename(`${policy}.tmp`, policy);
	};
	await online(false);
	await writeFile(quota, JSON.stringify({ version: 1, windows: [] }));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "offline" }] });
	runtime.registerNativeProvider(faux.provider);
	let effects = 0;
	const toolsRunning: boolean[] = [];
	const entered = deferred();
	const finish = deferred();
	let adapter: NativeAdapter | undefined;
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
		openAdapter
			.call(NativeAdapter, {
				...options,
				bundledExtensions: false,
				projectTrusted: false,
				settingsManager: SettingsManager.inMemory({ defaultTools: ["effect", "codemode"] }),
				sessionOptions: {
					modelRuntime: runtime,
					model: faux.getModel(),
					customTools: [
						{
							name: "effect",
							label: "effect",
							description: "Test side effect",
							parameters: Type.Object({}),
							execute: async (_id, _args, signal) => {
								effects++;
								entered.resolve();
								await finish.promise;
								assert.equal(signal?.aborted, false, "offline does not kill a running native tool");
								return { content: [{ type: "text", text: "saved" }], details: {} };
							},
						},
					],
				},
				loaderOptions: {
					cwd: root,
					agentDir: join(root, "agent"),
					noExtensions: false,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			})
			.then((opened) => {
				adapter = opened;
				return opened;
			}),
	);
	let session: KernelSession | undefined;
	const open = async () =>
		(session = await KernelSession.open(
			{
				sessionId: "offline-test",
				cwd: root,
				storageDir: join(root, "durable"),
				agentDir: join(root, "agent"),
				connectivityPolicy: policy,
				subscriptionPolicy: quota,
			},
			{ onWorking: () => {}, onToolsRunningChanged: (running) => toolsRunning.push(running) },
		));
	t.after(async () => {
		finish.resolve();
		await session?.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		policy,
		quota,
		faux,
		online,
		open,
		entered,
		finish,
		toolsRunning,
		effects: () => effects,
		adapter: () => adapter!,
	};
}

for (const reason of ["offline", "usage"] as const) {
	test(`${reason} auto-pause lets an entire codemode call finish, including subsequent nested tools`, {
		timeout: 20_000,
	}, async (t) => {
		const f = await fixture(t);
		// Execution reporting must keep working when the user disables evidence collection.
		setToolActivityCollectionEnabled(false);
		t.after(() => setToolActivityCollectionEnabled(true));
		await f.online(true);
		f.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: "text(await tools.effect({})); text(await tools.effect({}));",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const session = await f.open();
		await session.submit("auto-pause", "work", "followUp");
		await until(() => f.effects() > 0);
		assert.deepEqual(f.toolsRunning, [true]);
		if (reason === "offline") await f.online(false);
		else
			await writeFile(
				f.quota,
				JSON.stringify({
					version: 1,
					windows: [{ provider: "openai", label: "5h", usedPercent: 95 }],
				}),
			);
		assert.equal(session.toolsRunning, true);
		f.finish.resolve();
		await until(() => f.toolsRunning.length === 2);
		assert.deepEqual(f.toolsRunning, [true, false], "nested calls do not end the outer call early");
		await session.pauseForUpdate();
		assert.equal(f.effects(), 2, "both nested effects finish while auto-paused");
		assert.equal(f.faux.state.callCount, 1, "the next model request stays held");
		const entries = (await session.conversation.context(BACKGROUND_CONTEXT)).entries;
		assert.equal(entries.filter((entry) => entry.kind === "pi.tool-result").length, 1);
		assert.ok(!JSON.stringify(entries).includes("interrupted"));
		await f.online(true);
		await writeFile(f.quota, JSON.stringify({ version: 1, windows: [] }));
		session.resumeAfterUpdate();
		await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal(f.effects(), 2, "resuming never replays completed effects");
		assert.equal(f.faux.state.callCount, 2);
	});
}

test("offline queued input survives kernel restart, is admitted once, and completed effects are not replayed", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	f.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("effect", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	let session = await f.open();
	await session.submit("stable-input", "work", "followUp");
	await delay(25);
	assert.equal(f.faux.state.callCount, 0);
	assert.equal(session.working, true);
	await session.close();
	session = await f.open();
	await session.submit("stable-input", "work", "followUp");
	await f.online(true);
	await f.entered.promise;
	await f.online(false);
	f.finish.resolve();
	await until(() => f.effects() === 1);
	await session.pauseForUpdate();
	await session.close();
	session = await f.open();
	await delay(25);
	assert.equal(f.faux.state.callCount, 1);
	assert.equal(f.effects(), 1);
	await f.online(true);
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	const entries = (await session.conversation.context(BACKGROUND_CONTEXT)).entries;
	assert.equal(entries.filter((entry) => entry.kind === "pi.user").length, 1);
	assert.equal(entries.filter((entry) => entry.kind === "pi.tool-result").length, 1);
	assert.equal(f.effects(), 1);
	assert.equal(f.faux.state.callCount, 2);
	assert.ok(!JSON.stringify(entries).includes("interrupted"));
});

test("online alone cannot bypass a subscription pause, update tool drain or a manual Stop", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	const window = {
		provider: "openai",
		label: "5h",
		usedPercent: 95,
		resetsAt: new Date(Date.now() + 60_000).toISOString(),
	};
	await writeFile(f.quota, JSON.stringify({ version: 1, windows: [window] }));
	f.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("effect", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const session = await f.open();
	await session.submit("stable-input", "work", "followUp");
	await f.online(true);
	await delay(40);
	assert.equal(f.faux.state.callCount, 0, "subscription gate remains independent");
	await session.pauseForUpdate();
	await writeFile(f.quota, JSON.stringify({ version: 1, windows: [] }));
	await delay(40);
	assert.equal(f.effects(), 0);
	await session.abort();
	session.resumeAfterUpdate();
	await f.online(false);
	await f.online(true);
	await delay(40);
	assert.equal(f.effects(), 0, "online does not resubmit stopped work");
});

test("loss during a provider request holds its checkpoint and queued input through restart", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	const started = deferred(),
		cancelled = deferred();
	f.faux.setResponses([
		async (_context, options) => {
			started.resolve();
			await new Promise<void>((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
			);
			cancelled.resolve();
			return fauxAssistantMessage("discarded", { stopReason: "aborted" });
		},
		fauxAssistantMessage("first answer"),
		fauxAssistantMessage("second answer"),
	]);
	let session = await f.open();
	await f.online(true);
	await session.submit("first", "first input", "followUp");
	await started.promise;
	await f.online(false);
	await cancelled.promise;
	await session.submit("second", "queued input", "followUp");
	await delay(25);
	assert.equal(session.working, true);
	assert.equal(f.faux.state.callCount, 1);
	await session.close();
	session = await f.open();
	await session.submit("second", "queued input", "followUp");
	await f.online(true);
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	const entries = (await session.conversation.context(BACKGROUND_CONTEXT)).entries;
	assert.equal(entries.filter((entry) => entry.kind === "pi.user").length, 2);
	assert.equal(f.faux.state.callCount, 3);
	assert.ok(!JSON.stringify(entries).includes("discarded"));
});

test("deferred provider retrieval waits offline without submitting a second generation", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	await f.open();
	await f.online(true);
	f.faux.setResponses([fauxAssistantMessage("deferred answer")]);
	const adapter = f.adapter(),
		model = f.faux.getModel();
	const pending = await adapter.models
		.streamSimple(model, { messages: [{ role: "user", content: "work", timestamp: Date.now() }] }, { deferred: true })
		.result();
	assert.ok(pending.deferred);
	await f.online(false);
	const result = adapter.models.fetchDeferred(model, pending.deferred);
	await delay(25);
	assert.equal(f.faux.state.deferredFetchCount, 0);
	await f.online(true);
	assert.equal((await result).stopReason, "stop");
	assert.equal(f.faux.state.callCount, 1);
	assert.equal(f.faux.state.deferredFetchCount, 1);
});
