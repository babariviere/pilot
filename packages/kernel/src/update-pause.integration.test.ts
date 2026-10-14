import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

const gate = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

test("native update pause preserves finished effects and queued calls across kernel replacement", {
	timeout: 20_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-native-update-"));
	const started = gate(),
		finish = gate();
	let calls = 0;
	let session: KernelSession | undefined;
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "pilot-update-test", models: [{ id: "offline" }] });
	runtime.registerNativeProvider(faux.provider);
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, {
			...options,
			projectTrusted: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["update_effect"] }),
			sessionOptions: {
				...options.sessionOptions,
				modelRuntime: runtime,
				model: faux.getModel(),
				customTools: [
					{
						name: "update_effect",
						label: "Test effect",
						description: "Offline effect",
						parameters: Type.Object({}),
						execute: async () => {
							calls++;
							if (calls === 1) {
								started.resolve();
								await finish.promise;
							}
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
	const open = () =>
		KernelSession.open(
			{ sessionId: "update-test", cwd: root, storageDir: join(root, "durable"), agentDir: join(root, "agent") },
			{ onWorking: () => {} },
		);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("update_effect", {}), fauxToolCall("update_effect", {})], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("finished"),
	]);
	try {
		session = await open();
		await session.submit("stable", "work", "followUp");
		await started.promise;
		const pause = session.pauseForUpdate();
		finish.resolve();
		await pause;
		assert.equal(calls, 1);
		assert.equal(faux.state.callCount, 1);
		await session.close();
		session = await open();
		await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal(calls, 2);
		const entries = (await session.conversation.context(BACKGROUND_CONTEXT)).entries;
		assert.equal(entries.filter((entry) => entry.kind === "pi.tool-result").length, 2);
		assert.ok(!JSON.stringify(entries).includes("interrupted"));
	} finally {
		finish.resolve();
		await session?.close();
		await rm(root, { recursive: true, force: true });
	}
});
