import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { HISTORY_RECALL_TOOL } from "./history-recall.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

test("history recall is an ordinary chat tool reachable through codemode and returns untrusted, source-linked quotes", {
	timeout: 30_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-history-recall-"));
	const cwd = join(root, "workspace");
	await mkdir(cwd, { recursive: true });
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider();
	runtime.registerNativeProvider(faux.provider);
	let native!: NativeAdapter;
	const open = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) => {
		native = await open.call(NativeAdapter, {
			...options,
			agentDir: root,
			projectTrusted: false,
			bundledExtensions: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
			loaderOptions: {
				cwd,
				agentDir: root,
				noSkills: true,
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			sessionOptions: { ...options.sessionOptions, modelRuntime: runtime, model: faux.getModel() },
		});
		return native;
	});
	let session: KernelSession | undefined;
	t.after(async () => {
		await session?.close();
		await rm(root, { recursive: true, force: true });
	});
	session = await KernelSession.open(
		{ sessionId: "chat", storageDir: join(root, "durable"), cwd },
		{ onWorking: () => {} },
	);
	const names = native.session.getAllTools().map((tool) => tool.name);
	assert.ok(names.includes(HISTORY_RECALL_TOOL));

	faux.setResponses([fauxAssistantMessage("Noted: the staging bucket is acme-staging-7.")]);
	await session.submit("first", "Remember the staging bucket acme-staging-7", "followUp");
	await session.harness.waitForIdle(context);
	let recalled = "";
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'return await tools.history_recall({action: "search", query: "staging bucket"});',
			}),
			{ stopReason: "toolUse" },
		),
		(context) => {
			const last = context.messages.at(-1);
			recalled = last?.role === "toolResult" ? JSON.stringify(last.content) : "";
			return fauxAssistantMessage("Found it.");
		},
	]);
	await session.submit("second", "Which bucket?", "followUp");
	await session.harness.waitForIdle(context);
	assert.match(recalled, /acme-staging-7/);
	assert.match(recalled, /Untrusted quotes from this chat/);
	assert.match(recalled, /entryId/);
});
