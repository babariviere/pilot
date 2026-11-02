import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SubscriptionGate } from "@babariviere/pi-extensions/subscription-gate";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	Type,
} from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
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
	test(`subscription pause drains ${nested ? "nested scripts" : "direct calls"} and survives reopen without replay`, {
		timeout: 20_000,
	}, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pilot-quota-"));
		const policyPath = join(root, "subscription-policy.json");
		const window = {
			provider: "openai",
			label: "5h",
			usedPercent: 95,
			resetsAt: new Date(Date.now() + 60_000).toISOString(),
		};
		const save = (windows: unknown[], force?: string[]) =>
			writeFile(policyPath, JSON.stringify({ version: 1, windows, ...(force ? { force } : {}) }));
		await save([window]);
		const entered = gate(),
			started = gate(),
			finish = gate(),
			heldTool = gate();
		let holdingTool = false,
			calls = 0;
		const originalWait = SubscriptionGate.prototype.wait;
		t.mock.method(
			SubscriptionGate.prototype,
			"wait",
			function (this: SubscriptionGate, provider: string | undefined, signal?: AbortSignal) {
				if (provider === "openai-codex") {
					if (holdingTool) heldTool.resolve();
					else entered.resolve();
				}
				return originalWait.call(this, provider, signal);
			},
		);
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "offline" }] });
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
						defaultTools: ["quota_effect", ...(nested ? ["codemode"] : [])],
					}),
					sessionOptions: {
						modelRuntime: runtime,
						model: faux.getModel(),
						customTools: [
							{
								name: "quota_effect",
								label: "effect",
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
				{
					sessionId: "quota-test",
					cwd: root,
					storageDir: join(root, "durable"),
					agentDir: join(root, "agent"),
					subscriptionPolicy: policyPath,
				},
				{ onWorking: () => {} },
			);
		let session: KernelSession | undefined;
		faux.setResponses([
			fauxAssistantMessage(
				nested
					? [fauxToolCall("codemode", { code: "await tools.quota_effect({}); await tools.quota_effect({});" })]
					: [fauxToolCall("quota_effect", {}), fauxToolCall("quota_effect", {})],
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
			await entered.promise;
			assert.equal(faux.state.callCount, 0, "a paused request cannot dispatch to the model");
			await save([window], ["openai"]);
			await started.promise;
			await save([window]);
			holdingTool = true;
			finish.resolve();
			await heldTool.promise;
			await session.pauseForUpdate();
			assert.equal(calls, nested ? 2 : 1, "active scripts drain; new top-level tools wait before unsafe intent");
			await session.close();
			await save([]); // A fresh lower reading releases work, with no new input required.
			session = await open();
			await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
			assert.equal(calls, 2, "completed native effects are not replayed");
			assert.equal(faux.state.callCount, 2);
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
