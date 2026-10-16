import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	contentText,
	fauxAssistantMessage,
	fauxProvider,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CONTROL_SYSTEM_PROMPT } from "./control-context.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

test("control turns are fresh, tool rounds stay intact, log excludes thoughts and recovery deduplicates", {
	timeout: 30_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "control-session-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	t.mock.method(globalThis, "fetch", () => assert.fail("fixture must remain offline"));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "control-faux", models: [{ id: "first" }, { id: "second" }] });
	runtime.registerNativeProvider(faux.provider);
	const open = NativeAdapter.open;
	let adapter!: NativeAdapter;
	t.mock.method(
		NativeAdapter,
		"open",
		async (options: NativeAdapterOptions) =>
			(adapter = await open.call(NativeAdapter, {
				...options,
				settingsManager: SettingsManager.inMemory({ defaultTools: ["bash", "read"] }),
				sessionOptions: {
					modelRuntime: runtime,
					model: faux.getModel(options.model?.endsWith("second") ? "second" : "first"),
				},
			})),
	);
	const log: Array<Record<string, JsonValue>> = [],
		keys = new Set<string>(),
		prefixes = new Map<string, JsonValue>();
	let preparations = 0,
		fail = false;
	const hooks = {
		onWorking: () => {},
		callControl: async (action: string, args: Record<string, JsonValue>): Promise<JsonValue> => {
			if (action === "record") {
				const message = args.message as Record<string, JsonValue>;
				if (!keys.has(String(message.key))) {
					keys.add(String(message.key));
					log.push(message);
				}
				return null;
			}
			if (action === "date") return { at: "2026-01-01T00:00:00.000Z" };
			if (action !== "prepare") throw new Error("unexpected action");
			if (fail) throw new Error("summary unavailable");
			preparations++;
			const key = String(args.key);
			if (!prefixes.has(key))
				prefixes.set(key, { lines: log.map((m, id) => ({ id, n: 1, text: `${m.kind}: ${m.text}` })) });
			return prefixes.get(key)!;
		},
	};
	let session = await KernelSession.open(
		{ sessionId: "control", cwd: root, storageDir: join(root, "durable"), control: true },
		hooks,
	);
	t.after(() => session.close());
	assert.ok(adapter.session.getCallableToolNames().includes("zoom"));
	for (const denied of ["bash", "read", "find", "grep", "ls", "mission", "db", "todo", "slack_status"])
		assert.ok(!adapter.session.getCallableToolNames().includes(denied), denied);
	let checked = 0;
	faux.setResponses([
		async (ctx) => {
			assert.equal(getCurrentSystemPrompt(ctx.messages), CONTROL_SYSTEM_PROMPT);
			assert.deepEqual(
				ctx.messages.filter((m) => m.role !== "system").map((m) => m.role),
				["user", "user"],
			);
			assert.equal(contentText(ctx.messages.at(-1)!.content), "first request");
			checked++;
			return fauxAssistantMessage([
				{ type: "thinking", thinking: "private thought" },
				{ type: "text", text: "first reply" },
			]);
		},
		async (ctx) => {
			assert.equal(ctx.messages.filter((m) => m.role === "assistant").length, 0, "previous turn is not replayed");
			assert.match(contentText(ctx.messages[1]!.content), /first reply/);
			assert.equal(contentText(ctx.messages.at(-1)!.content), "second request");
			assert.deepEqual(
				getCurrentTools(ctx.messages).map((tool) => tool.name),
				["codemode"],
			);
			checked++;
			return fauxAssistantMessage(
				{
					type: "toolCall",
					id: "date",
					name: "codemode",
					arguments: { code: "text(await tools.date({id:0}));" },
				},
				{ stopReason: "toolUse" },
			);
		},
		async (ctx) => {
			assert.ok(ctx.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall")));
			assert.ok(ctx.messages.some((m) => m.role === "toolResult"));
			checked++;
			return fauxAssistantMessage("second reply");
		},
	]);
	await session.submit("first", "first request", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	await session.submit("second", "second request", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(
		checked,
		3,
		JSON.stringify({
			completion: session.completion,
			context: await session.conversation.context(BACKGROUND_CONTEXT),
			log,
		}),
	);
	assert.ok(log.some((m) => m.kind === "tool"));
	assert.ok(log.some((m) => m.kind === "echo"));
	assert.doesNotMatch(JSON.stringify(log), /private thought/);
	assert.equal(prefixes.size, 2);
	assert.ok(preparations >= 3);
	await session.close();
	const before = log.length;
	session = await KernelSession.open(
		{ sessionId: "control", cwd: root, storageDir: join(root, "durable"), control: true },
		hooks,
	);
	await session.changeModel("control-faux/second");
	faux.setResponses([
		async (ctx) => {
			assert.equal(ctx.messages.filter((m) => m.role === "assistant").length, 0);
			checked++;
			return fauxAssistantMessage("third reply");
		},
	]);
	await session.submit("third", "third request", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(session.model, "control-faux/second");
	assert.ok(log.length >= before);
	assert.equal(new Set(log.map((m) => m.key)).size, log.length);
	fail = true;
	faux.setResponses([async () => assert.fail("a failed projection must never send old Harness history")]);
	await session.submit("failure", "must fail closed", "followUp");
	await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(checked, 4);
});
