import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
} from "@earendil-works/pi-ai";
import {
	createCodemodeExtension,
	ModelRuntime,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, type JsonObject, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { NativeAdapter } from "./native-adapter.ts";
import { PosthorseDoc } from "./posthorse.ts";

async function fixture(
	t: TestContext,
	options: {
		root?: string;
		storage?: Storage;
		enabled?: boolean;
		eligible?: boolean;
		reserve?: number;
		keepRecent?: number;
	} = {},
) {
	const root = options.root ?? (await mkdtemp(join(tmpdir(), "pilot-posthorse-")));
	if (!options.root) t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	const faux = fauxProvider({
		provider: "posthorse-test",
		tokensPerSecond: 0,
		models: [{ id: "main", contextWindow: 100_000 }],
	});
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runtime.registerNativeProvider(faux.provider);
	t.mock.method(globalThis, "fetch", async () => assert.fail("Posthorse fixtures must stay offline"));
	const state = { eligible: options.eligible ?? true };
	const failing: ToolDefinition = {
		name: "failed_sibling",
		label: "Failed sibling",
		description: "Offline failure",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: "Failed synthetic sibling" }],
			details: undefined,
			isError: true,
		}),
	};
	const adapter = await NativeAdapter.open({
		cwd: root,
		agentDir,
		projectTrusted: false,
		sessionId: "posthorse-test",
		sessionFile: join(root, "native.session"),
		posthorseEligible: () => state.eligible,
		settingsManager: SettingsManager.inMemory({
			defaultTools: ["+codemode"],
			compaction: {
				enabled: options.enabled ?? true,
				reserveTokens: options.reserve ?? 16_384,
				keepRecentTokens: options.keepRecent ?? 20_000,
			},
		}),
		sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
		bundledExtensions: false,
		loaderOptions: {
			cwd: root,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Offline Posthorse integration fixture.",
			appendSystemPrompt: [],
			extensionFactories: [
				createCodemodeExtension(),
				(pi) => {
					pi.registerTool(failing);
				},
			],
		},
	});
	const registry = createRegistry();
	registry.install(adapter.extension);
	adapter.onToolsChanged = (extension) => registry.install(extension);
	const settings = Object.defineProperty({ retry: { enabled: false } }, "compaction", {
		enumerable: true,
		get: () => adapter.posthorsePolicy() ?? { enabled: false },
	});
	const harness = await Harness.open(
		options.storage ?? new MemoryStorage(),
		{ models: adapter.models, registry, settings },
		context,
	);
	const conversation = await harness.root(context, {
		agent: { model: adapter.model, extensions: [{ name: "native" }], tools: null },
	});
	await adapter.bindHarness(harness, conversation.id);
	const close = async () => {
		await adapter.close();
		await harness.close(context);
	};
	t.after(close);
	return { root, faux, adapter, harness, conversation, state, close };
}
type Chat = Awaited<ReturnType<typeof fixture>>;
const call = (name: string, args: JsonObject) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const entries = async (chat: Chat) =>
	(await chat.conversation.entries({ order: "ascending" }, 1000, undefined, context)).items;
const run = async (chat: Chat, input: string, responses: Parameters<Chat["faux"]["setResponses"]>[0]) => {
	chat.faux.setResponses(responses);
	const receipt = await (await chat.conversation.submit({ type: "input", content: input }, context)).wait(context);
	assert.equal(receipt.status, "done", JSON.stringify(receipt));
	await chat.conversation.waitForIdle(context);
	return entries(chat);
};
const toolResults = async (chat: Chat) =>
	(await entries(chat)).flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");

test("Posthorse explicit reset commits once and continues the same durable run", { timeout: 15_000 }, async (t) => {
	const chat = await fixture(t);
	const saved = await run(chat, "ORIGINAL_CONTEXT_CANARY", [
		call("new_context", { handoff: "Continue with verification. No push is approved." }),
		(request) => {
			assert.doesNotMatch(JSON.stringify(request.messages), /ORIGINAL_CONTEXT_CANARY/);
			assert.match(JSON.stringify(request.messages), /Continue with verification/);
			assert.match(JSON.stringify(request), /history uses Pilot's word-prefix search/);
			assert.doesNotMatch(JSON.stringify(request), /notes and history search match literal text/);
			return fauxAssistantMessage("Finished verification");
		},
	]);
	assert.equal(saved.filter((entry) => entry.kind === "pi.reset").length, 1);
	assert.ok(saved.some((entry) => JSON.stringify(entry).includes("ORIGINAL_CONTEXT_CANARY")));
	assert.equal(chat.faux.state.callCount, 2);
});

for (const nested of [false, true])
	test(`Posthorse ${nested ? "nested" : "direct"} reset requires successful foreground siblings`, {
		timeout: 15_000,
	}, async (t) => {
		const chat = await fixture(t);
		const request = nested
			? call("codemode", {
					code: 'await tools.new_context({handoff:"Do not lose original context"}); throw new Error("Outer tool failed");',
				})
			: fauxAssistantMessage(
					[
						fauxToolCall("new_context", { handoff: "Do not lose original context" }),
						fauxToolCall("failed_sibling", {}),
					],
					{ stopReason: "toolUse" },
				);
		const saved = await run(chat, "KEEP_ORIGINAL_CANARY", [
			request,
			(request) => {
				assert.match(JSON.stringify(request.messages), /KEEP_ORIGINAL_CANARY/);
				return fauxAssistantMessage("Recovering from failed tool");
			},
		]);
		assert.equal(saved.filter((entry) => entry.kind === "pi.reset").length, 0);
	});

test("Posthorse nested reset survives its outer successful codemode result", { timeout: 15_000 }, async (t) => {
	const chat = await fixture(t);
	const saved = await run(chat, "NESTED_ORIGINAL_CANARY", [
		call("codemode", { code: 'await tools.new_context({handoff:"Nested continuation"});' }),
		(request) => {
			assert.doesNotMatch(JSON.stringify(request.messages), /NESTED_ORIGINAL_CANARY/);
			assert.match(JSON.stringify(request.messages), /Nested continuation/);
			return fauxAssistantMessage("Continued");
		},
	]);
	assert.equal(saved.filter((entry) => entry.kind === "pi.reset").length, 1);
});

for (const keepRecent of [20_000, 0])
	test(`automatic Posthorse rollover uses its real policy without summary calls (tail=${keepRecent})`, {
		timeout: 15_000,
	}, async (t) => {
		const chat = await fixture(t, { keepRecent });
		await chat.conversation.commit(async (tx) => {
			for (let index = 0; index < 30; index++) {
				await tx.appendEntry(chat.conversation.id, {
					kind: "pi.user",
					model: [
						{
							role: "user",
							content: `Older input ${index}. ${"Historical tool evidence. ".repeat(400)}`,
							timestamp: index + 1,
						},
					],
				});
				const answer = fauxAssistantMessage("Recorded earlier result.");
				if (index === 29) answer.usage = { ...answer.usage, input: 95_000, totalTokens: 95_000 };
				await tx.appendEntry(chat.conversation.id, { kind: "pi.assistant", model: [answer] });
			}
		}, context);
		const saved = await run(chat, "UNCONSUMED_INPUT_CANARY", [
			(request) => {
				assert.match(JSON.stringify(request.messages), /Automatic context rollover recovery record/);
				assert.match(JSON.stringify(request.messages), /UNCONSUMED_INPUT_CANARY/);
				return fauxAssistantMessage("Continued without summarization");
			},
		]);
		assert.equal(chat.faux.state.callCount, 1);
		assert.equal(saved.filter((entry) => entry.kind === "pi.compaction").length, 1);
	});

test("retain-none rollover keeps an unseen tool image round without replay", { timeout: 15_000 }, async (t) => {
	const chat = await fixture(t, { keepRecent: 0 });
	let effects = 1;
	const pixels = Buffer.from("UNSEEN_TOOL_IMAGE_CANARY").toString("base64");
	chat.adapter.registerHostTool({
		name: "picture",
		label: "Picture",
		description: "Offline image",
		parameters: Type.Object({}),
		execute: async () => {
			effects++;
			return { content: [{ type: "image", mimeType: "image/png", data: pixels }], details: undefined };
		},
	});
	chat.adapter.setToolActive("picture", true);
	const imageRound = call("picture", {});
	imageRound.usage = { ...imageRound.usage, input: 95_000, totalTokens: 95_000 };
	const toolCall = imageRound.content.find((block) => block.type === "toolCall")!;
	assert.equal(toolCall.type, "toolCall");
	// Seed a completed effect with reported usage. Faux recomputes usage for newly dispatched responses.
	await chat.conversation.commit(async (tx) => {
		await tx.appendEntry(chat.conversation.id, {
			kind: "pi.user",
			model: [{ role: "user", content: "Earlier picture request", timestamp: 1 }],
		});
		await tx.appendEntry(chat.conversation.id, { kind: "pi.assistant", model: [imageRound] });
		await tx.appendEntry(chat.conversation.id, {
			kind: "pi.tool-result",
			model: [
				{
					role: "toolResult",
					toolName: "picture",
					toolCallId: toolCall.id,
					content: [{ type: "image", mimeType: "image/png", data: pixels }],
					isError: false,
					timestamp: 2,
				},
			],
		});
	}, context);
	const saved = await run(chat, "Inspect the new picture", [
		(request) => {
			assert.match(JSON.stringify(request.messages), /Automatic context rollover recovery record/);
			assert.ok(JSON.stringify(request.messages).includes(pixels));
			return fauxAssistantMessage("Viewed the retained image");
		},
	]);
	assert.equal(effects, 1);
	assert.equal(saved.filter((entry) => entry.kind === "pi.compaction").length, 1);
});

test("a lost nested intent acknowledgement cannot reset through a successful outer catch", {
	timeout: 15_000,
}, async (t) => {
	const chat = await fixture(t);
	let dropped = false;
	const commit = chat.harness.commit.bind(chat.harness);
	t.mock.method(chat.harness, "commit", async (...args: Parameters<typeof chat.harness.commit>) => {
		const result = await commit(...args);
		const saved = await chat.harness.snapshot(PosthorseDoc, chat.conversation.id, context);
		if (!dropped && saved?.reset?.requests.some((request) => request.id !== request.root && !request.completed)) {
			dropped = true;
			throw new Error("Lost intent acknowledgement");
		}
		return result;
	});
	const saved = await run(chat, "KEEP_UNKNOWN_NESTED_ORIGINAL", [
		call("codemode", {
			code: 'try { await tools.new_context({handoff:"Unconfirmed reset"}); } catch { text("Caught failed nested request"); }',
		}),
		(request) => {
			assert.match(JSON.stringify(request.messages), /KEEP_UNKNOWN_NESTED_ORIGINAL/);
			return fauxAssistantMessage("Original preserved");
		},
	]);
	assert.equal(dropped, true);
	assert.equal(saved.filter((entry) => entry.kind === "pi.reset").length, 0);
});

test("queued input is checked against fresh reset capacity at placement", { timeout: 15_000 }, async (t) => {
	const chat = await fixture(t, { enabled: false });
	let entered!: () => void;
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	t.after(() => release());
	const after = chat.adapter.session.agent.afterToolCall!;
	chat.adapter.session.agent.afterToolCall = async (...args: Parameters<typeof after>) => {
		const result = await after(...args);
		if (args[0].toolCall.name === "new_context") {
			entered();
			await held;
		}
		return result;
	};
	t.after(() => {
		chat.adapter.session.agent.afterToolCall = after;
	});
	const running = run(chat, "KEEP_CAPACITY_ORIGINAL", [
		call("new_context", { handoff: "Short handoff" }),
		(request) => {
			assert.match(JSON.stringify(request.messages), /KEEP_CAPACITY_ORIGINAL/);
			return fauxAssistantMessage("Kept the original context");
		},
	]);
	await waiting;
	const steer = await chat.conversation.submit(
		{ type: "input", whenBusy: "steer", content: `Late queued input: ${"x".repeat(400_000)}` },
		context,
	);
	release();
	const saved = await running;
	await steer.wait(context);
	assert.equal(saved.filter((entry) => entry.kind === "pi.reset").length, 0);
});

test("Posthorse history reads compacted originals but denies cross-chat scopes and private reasoning", {
	timeout: 15_000,
}, async (t) => {
	const chat = await fixture(t);
	await chat.conversation.commit(async (tx) => {
		await tx.appendEntry(chat.conversation.id, {
			kind: "pi.user",
			model: [{ role: "user", content: "KEPT_HISTORY_CANARY", timestamp: 1 }],
		});
		await tx.appendEntry(chat.conversation.id, {
			kind: "pi.assistant",
			model: [
				fauxAssistantMessage([
					{ type: "thinking", thinking: "PRIVATE_REASONING_CANARY" },
					{ type: "text", text: "Visible prior evidence" },
				]),
			],
		});
		await tx.appendEntry(chat.conversation.id, {
			kind: "pi.reset",
			head: "self",
			model: [{ role: "user", content: "Replacement context", timestamp: 2 }],
		});
	}, context);
	await run(chat, "Recover older evidence", [
		call("history", { op: "search", query: "KEPT_HISTORY_CANARY" }),
		call("history", { op: "search", query: "PRIVATE_REASONING_CANARY" }),
		call("history", { op: "search", query: "KEPT_HISTORY_CANARY", all: true }),
		fauxAssistantMessage("Done"),
	]);
	const results = await toolResults(chat);
	assert.match(JSON.stringify(results[0]), /KEPT_HISTORY_CANARY/);
	assert.equal(
		(JSON.parse((results[1]!.content[0] as { text: string }).text) as { results?: unknown[] }).results?.length ?? 0,
		0,
	);
	assert.equal(results[2]!.isError, true);
	assert.match(JSON.stringify(results[2]), /Cross-chat search is unavailable/);
});

test("notes keep stable ownership across reopen, outside the workspace, without replaying resets", {
	timeout: 15_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-posthorse-reopen-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "harness.sqlite");
	let chat = await fixture(t, { root, storage: await openNodeSqliteStorage(file) });
	await run(chat, "Save current task state", [
		call("notes", { op: "write", path: "task.md", content: "Checkpoint: verify before delivery." }),
		call("new_context", { handoff: "Read task.md and continue." }),
		fauxAssistantMessage("Saved"),
	]);
	const before = await chat.harness.snapshot(PosthorseDoc, chat.conversation.id, context);
	await chat.close();
	chat = await fixture(t, { root, storage: await openNodeSqliteStorage(file) });
	await run(chat, "Continue the same task", [
		call("notes", { op: "read", path: "task.md" }),
		fauxAssistantMessage("Restored notes"),
	]);
	const after = await chat.harness.snapshot(PosthorseDoc, chat.conversation.id, context);
	assert.deepEqual(after?.header, before?.header);
	assert.match(JSON.stringify((await toolResults(chat)).at(-1)), /verify before delivery/);
	assert.equal((await entries(chat)).filter((entry) => entry.kind === "pi.reset").length, 1);
	assert.equal(
		await readFile(join(root, "posthorse", String(chat.conversation.id), ".pi", "notes", "task.md"), "utf8"),
		"Checkpoint: verify before delivery.",
	);
	await assert.rejects(readFile(join(root, ".pi", "notes", "task.md")), { code: "ENOENT" });
});

test("notes reject oversized reads and links escaping the private chat store", { timeout: 15_000 }, async (t) => {
	const chat = await fixture(t);
	await run(chat, "Create checkpoint", [
		call("notes", { op: "write", path: "task.md", content: "State" }),
		fauxAssistantMessage("Created"),
	]);
	const directory = join(chat.root, "posthorse", String(chat.conversation.id), ".pi", "notes");
	await writeFile(join(directory, "large.md"), "x".repeat(1024 * 1024 + 1));
	await writeFile(join(chat.root, "outside.md"), "OUTSIDE_STORE_CANARY");
	await symlink(join(chat.root, "outside.md"), join(directory, "escape.md"));
	await run(chat, "Read notes", [
		call("notes", { op: "read", path: "large.md" }),
		call("notes", { op: "read", path: "escape.md" }),
		fauxAssistantMessage("Limits respected"),
	]);
	const results = (await toolResults(chat)).slice(-2);
	assert.ok(results.every((result) => result.isError));
	assert.doesNotMatch(JSON.stringify(results), /OUTSIDE_STORE_CANARY/);
});

test("coordinator role denies Posthorse reset and private note tools", { timeout: 15_000 }, async (t) => {
	const chat = await fixture(t, { eligible: false });
	await run(chat, "Keep coordinator memory", [
		call("new_context", { handoff: "Must not replace coordinator memory" }),
		call("notes", { op: "list" }),
		fauxAssistantMessage("Denied"),
	]);
	assert.ok((await toolResults(chat)).every((result) => result.isError));
	assert.equal((await entries(chat)).filter((entry) => entry.kind === "pi.reset").length, 0);
	assert.equal(await chat.harness.snapshot(PosthorseDoc, chat.conversation.id, context), undefined);
});
