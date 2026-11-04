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
} from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

const gate = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

for (const nested of [false, true]) {
	test(`native update pause drains ${nested ? "nested scripts" : "direct calls"} across kernel replacement`, {
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
		let adapter: NativeAdapter;
		const openAdapter = NativeAdapter.open;
		t.mock.method(
			NativeAdapter,
			"open",
			async (options: NativeAdapterOptions) =>
				(adapter = await openAdapter.call(NativeAdapter, {
					...options,
					bundledExtensions: false,
					projectTrusted: false,
					settingsManager: SettingsManager.inMemory({
						defaultTools: ["update_effect", ...(nested ? ["codemode"] : [])],
					}),
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
						extensionFactories: nested ? [createCodemodeExtension({ mode: "on" })] : [],
						cwd: root,
						agentDir: join(root, "agent"),
						noExtensions: true,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
					},
				})),
		);
		const open = () =>
			KernelSession.open(
				{ sessionId: "update-test", cwd: root, storageDir: join(root, "durable"), agentDir: join(root, "agent") },
				{ onWorking: () => {} },
			);
		faux.setResponses([
			fauxAssistantMessage(
				nested
					? [fauxToolCall("codemode", { code: "await tools.update_effect({}); await tools.update_effect({});" })]
					: [fauxToolCall("update_effect", {}), fauxToolCall("update_effect", {})],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("finished"),
		]);
		try {
			session = await open();
			if (nested) adapter!.setToolActive("codemode", true);
			await session.submit("stable", "work", "followUp");
			await started.promise;
			const pause = session.pauseForUpdate();
			finish.resolve();
			await pause;
			assert.equal(calls, nested ? 2 : 1);
			assert.equal(faux.state.callCount, 1);
			await session.close();
			session = await open();
			await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
			assert.equal(calls, 2);
			const entries = (await session.conversation.context(BACKGROUND_CONTEXT)).entries;
			assert.equal(entries.filter((entry) => entry.kind === "pi.tool-result").length, nested ? 1 : 2);
			assert.ok(!JSON.stringify(entries).includes("interrupted"));
		} finally {
			finish.resolve();
			await session?.close();
			await rm(root, { recursive: true, force: true });
		}
	});
}
