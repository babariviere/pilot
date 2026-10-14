import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
} from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SessionCompletion } from "@pilot/protocol";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { QUESTION_ENTRY } from "./question-tool.ts";
import { KernelSession } from "./session.ts";

async function open(t: TestContext, name: string) {
	const root = await mkdtemp(join(tmpdir(), "pilot-question-"));
	const cleanup: Array<() => Promise<void>> = [];
	t.after(async () => {
		try {
			for (const close of cleanup.reverse()) await close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "pilot-question-test", models: [{ id: "offline" }] });
	modelRuntime.registerNativeProvider(faux.provider);
	const options: Partial<NativeAdapterOptions> = {
		agentDir: join(root, "agent"),
		projectTrusted: false,
		settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "codemode"] }),
		sessionOptions: { modelRuntime, model: faux.getModel() },
		loaderOptions: {
			cwd: root,
			agentDir: join(root, "agent"),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Offline question integration.",
			extensionFactories: [createCodemodeExtension({ models: false, mode: "on" })],
		},
	};
	const openAdapter = NativeAdapter.open;
	const refreshUsage = NativeAdapter.prototype.refreshUsage;
	const refreshes: Promise<void>[] = [];
	t.mock.method(
		NativeAdapter.prototype,
		"refreshUsage",
		function (this: NativeAdapter, ...args: Parameters<typeof refreshUsage>) {
			const refresh = refreshUsage.apply(this, args);
			refreshes.push(refresh);
			return refresh;
		},
	);
	t.mock.method(NativeAdapter, "open", (adapterOptions: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, {
			...adapterOptions,
			...options,
			sessionOptions: { ...adapterOptions.sessionOptions, ...options.sessionOptions },
		}),
	);
	const completions: SessionCompletion[] = [];
	const session = await KernelSession.open(
		{ sessionId: name, cwd: root, storageDir: join(root, "storage") },
		{
			onWorking: (working, completion) => {
				if (!working && completion && completion.outcomeAt !== completions.at(-1)?.outcomeAt)
					completions.push(completion);
			},
		},
	);
	cleanup.push(async () => {
		await Promise.all(refreshes);
		await session.close();
	});
	return { session, faux, completions };
}

async function questions(session: KernelSession) {
	const view = await session.conversation.context(BACKGROUND_CONTEXT);
	return view.entries.filter((entry) => entry.kind === QUESTION_ENTRY).map((entry) => entry.data);
}

async function settled(completions: SessionCompletion[], count: number) {
	const deadline = Date.now() + 10_000;
	while (completions.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	return completions[count - 1];
}

test("a direct ask_user call records the question, ends the run and waits for the user", {
	timeout: 20_000,
}, async (t) => {
	const { session, faux, completions } = await open(t, "direct-question");
	let requests = 0;
	faux.setResponses([
		() => {
			requests++;
			return fauxAssistantMessage(
				fauxToolCall("ask_user", {
					question: "Where should retries live?",
					options: [{ label: "Shared client", suggested: true }, { label: "Sync worker" }],
				}),
				{ stopReason: "toolUse" },
			);
		},
		() => {
			requests++;
			return fauxAssistantMessage("Retries now live in the sync worker.");
		},
	]);
	await session.submit("ask", "Add retries", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(requests, 1);
	assert.deepEqual(await questions(session), [
		{
			question: "Where should retries live?",
			options: [{ label: "Shared client", suggested: true }, { label: "Sync worker" }],
		},
	]);
	const asked = await settled(completions, 1);
	assert.equal(asked?.outcome, "question");
	assert.equal(asked?.outcomeReason, "Where should retries live?");

	// The reply is an ordinary user message; its run settles as done.
	await session.submit("reply", "Sync worker", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	const answered = await settled(completions, 2);
	assert.equal(answered?.outcome, "done");
	assert.ok(answered!.outcomeAt > asked!.outcomeAt);
});

test("ask_user through codemode still records the question", { timeout: 20_000 }, async (t) => {
	const { session, faux, completions } = await open(t, "codemode-question");
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'text(await tools.ask_user({question:"Which checks?",options:[{label:"Typecheck"},{label:"Tests"}],multiSelect:true}));',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Waiting for your answer."),
	]);
	await session.submit("ask", "Open the PR", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(await questions(session), [
		{ question: "Which checks?", options: [{ label: "Typecheck" }, { label: "Tests" }], multiSelect: true },
	]);
	assert.equal((await settled(completions, 1))?.outcome, "question");
});
