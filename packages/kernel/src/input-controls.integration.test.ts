import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	Type,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { HeldInputsDoc } from "./held-inputs.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "input-controls-"));
	const started = gate(),
		finish = gate();
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "input-controls-test", models: [{ id: "offline" }] });
	runtime.registerNativeProvider(faux.provider);
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, {
			...options,
			bundledExtensions: false,
			projectTrusted: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["control_gate"] }),
			sessionOptions: {
				...options.sessionOptions,
				modelRuntime: runtime,
				model: faux.getModel(),
				customTools: [
					{
						name: "control_gate",
						label: "Gate",
						description: "Offline gate",
						parameters: Type.Object({}),
						execute: async (_id, _args, signal) => {
							started.resolve();
							if (!signal?.aborted)
								await Promise.race([
									finish.promise,
									new Promise<void>((resolve) =>
										signal?.addEventListener("abort", () => resolve(), { once: true }),
									),
								]);
							return { content: [{ type: "text", text: "finished tool" }], details: {} };
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
	const open = () =>
		KernelSession.open(
			{ sessionId: "controls", cwd: root, storageDir: join(root, "durable"), agentDir: join(root, "agent") },
			{ onWorking: () => {} },
		);
	let session = await open();
	t.after(async () => {
		finish.resolve();
		await session.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		faux,
		started,
		finish,
		get session() {
			return session;
		},
		async reopen() {
			await session.close();
			session = await open();
		},
	};
}

test("pause lets the current run finish, holds future input across reopen, and resume releases it once", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	f.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("control_gate", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("current run finished"),
		fauxAssistantMessage("resumed queue"),
	]);
	await f.session.submit("user:first", "First", "followUp");
	await f.started.promise;
	await f.session.submit("user:queued", "Queued user", "followUp");
	await f.session.pauseInputs();
	assert.deepEqual(await f.session.submit("control:send:paused", "Queued control", "followUp", false, true), {
		delivery: "queued",
	});
	f.finish.resolve();
	await f.session.conversation.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 2, "active run finishes without consuming held follow-ups");
	await f.reopen();
	assert.equal(f.faux.state.callCount, 2);
	assert.deepEqual(await f.session.submit("user:after-reopen", "Still paused", "steer", false, true), {
		delivery: "queued",
	});
	await f.session.resumeInputs();
	await f.session.conversation.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 3);
	const held = await f.session.harness.snapshot(HeldInputsDoc, f.session.conversation.id, context);
	assert.equal(held?.paused, false);
	assert.equal(held?.items.length, 0);
	await f.session.resumeInputs();
	assert.equal(f.faux.state.callCount, 3);
	const text = JSON.stringify((await f.session.conversation.context(context)).messages);
	for (const content of ["Queued user", "Queued control", "Still paused"]) assert.ok(text.includes(content));
});

test("Stop aborts before redirect's new instruction starts and keeps its automatic request identity", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	f.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("control_gate", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("new direction completed"),
	]);
	await f.session.submit("user:first", "First", "followUp");
	await f.started.promise;
	await f.session.submit("user:withdraw", "Do not run this", "followUp");
	assert.deepEqual(
		(await f.session.abort()).map((item) => item.content),
		["Do not run this"],
	);
	assert.equal(f.faux.state.callCount, 1);
	const report = await f.session.submit(
		"control:redirect:stable",
		"New direction",
		"followUp",
		false,
		true,
		undefined,
		undefined,
		true,
	);
	assert.equal(report?.delivery, "delivered");
	await f.session.conversation.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 2);
	const entries = (await f.session.conversation.context(context)).entries;
	const text = JSON.stringify(entries);
	assert.ok(text.includes("New direction"));
	assert.ok(!text.includes("Do not run this"));
	await f.session.submit(
		"control:redirect:stable",
		"New direction",
		"followUp",
		false,
		true,
		undefined,
		undefined,
		true,
	);
	assert.equal(f.faux.state.callCount, 2, "accepted redirect input is deduplicated");
});
