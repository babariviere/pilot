import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createEventBus, type ExtensionFactory, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type ExtensionInput, NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import type { KernelSubagent } from "./protocol.ts";
import { KernelSession } from "./session.ts";
import { SubagentBridge } from "./subagents.ts";

const context = BACKGROUND_CONTEXT;
const entry = {
	name: "review",
	state: "working",
	task: "Review the protocol",
	createdAt: 1,
	cwd: "/work",
	model: "test/model",
	storage: "/sessions/x/durable/subagent-runs/x/1/review.durable",
	conversationId: "8",
};
const answer = {
	customType: "subagent.result",
	content: '[subagent "review" answered, no reply needed] Found two gaps.',
	display: true,
	details: { name: "review", conversationId: "8", answerId: "10" },
};

async function fixture(t: TestContext, extensions: ExtensionFactory[]) {
	const root = await mkdtemp(join(tmpdir(), "pilot-subagents-"));
	const cleanup: Array<() => Promise<void>> = [];
	t.after(async () => {
		try {
			for (const close of cleanup.reverse()) await close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	t.mock.method(globalThis, "fetch", () => {
		assert.fail("offline subagent integration must not access the network");
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "pilot-subagents-test", models: [{ id: "offline", contextWindow: 32_000 }] });
	modelRuntime.registerNativeProvider(faux.provider);
	const options: NativeAdapterOptions = {
		cwd: root,
		agentDir: join(root, "agent"),
		projectTrusted: false,
		settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
		sessionOptions: { modelRuntime, model: faux.getModel() },
		loaderOptions: {
			cwd: root,
			agentDir: join(root, "agent"),
			eventBus: createEventBus(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Offline subagent integration fixture.",
			appendSystemPrompt: [],
			extensionFactories: extensions,
		},
	};
	return { root, options, faux, cleanup };
}

test("extension turn requests become ordered extension input; other custom messages stay native", async (t) => {
	const f = await fixture(t, [
		(pi) => {
			pi.on("session_start", () => {
				pi.sendMessage(answer, { deliverAs: "followUp", triggerTurn: true });
				pi.sendMessage({ customType: "note", content: "passive", display: false }, {});
				pi.sendMessage(
					{ customType: "later", content: "next turn", display: false },
					{ deliverAs: "nextTurn", triggerTurn: true },
				);
				pi.sendUserMessage([{ type: "text", text: "steer me" }], { deliverAs: "steer" });
				pi.sendMessage(answer, { deliverAs: "followUp", triggerTurn: true });
			});
		},
	]);
	const adapter = await NativeAdapter.open(f.options);
	f.cleanup.push(() => adapter.close());
	const inputs: ExtensionInput[] = [];
	adapter.onExtensionInput = (input) => inputs.push(input);
	assert.equal(inputs.length, 3, "buffered until a handler exists, in order");
	assert.deepEqual(inputs[0]!.content, answer.content);
	assert.equal(inputs[0]!.mode, "followUp");
	assert.match(inputs[0]!.requestId, /^native:subagent\.result:[0-9a-f]{32}$/);
	assert.equal(inputs[2]!.requestId, inputs[0]!.requestId, "identical notifications share one admission ID");
	assert.deepEqual(inputs[1]!.content, [{ type: "text", text: "steer me" }]);
	assert.equal(inputs[1]!.mode, "steer");
	assert.match(inputs[1]!.requestId, /^native:user:/);
});

test("KernelSession admits subagent answers as durable input and bridges subagent snapshots and commands", {
	timeout: 15_000,
}, async (t) => {
	const commands: unknown[] = [];
	const f = await fixture(t, [
		(pi) => {
			pi.events.on("subagents:command", (data) => {
				const command = data as { requestId: string; name: string };
				commands.push(data);
				pi.events.emit("subagents:command-result", {
					requestId: command.requestId,
					ok: command.name === "review",
					...(command.name === "review" ? {} : { error: "boom" }),
				});
			});
			pi.events.on("subagents:request-snapshot", () =>
				pi.events.emit("subagents:snapshot", { agents: [entry, { name: "broken" }] }),
			);
			pi.on("session_start", () => {
				pi.sendMessage(answer, { deliverAs: "followUp", triggerTurn: true });
			});
		},
	]);
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", async (options: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, {
			...options,
			...f.options,
			sessionId: options.sessionId,
			sessionFile: options.sessionFile,
			subagents: options.subagents,
		}),
	);
	f.faux.setResponses([fauxAssistantMessage("Noted.")]);
	const changes: KernelSubagent[][] = [];
	let settle!: () => void;
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const session = await KernelSession.open(
		{
			sessionId: "offline-subagents",
			cwd: f.root,
			agentDir: f.options.agentDir,
			storageDir: join(f.root, "storage"),
		},
		{
			onWorking: (working) => {
				if (!working) settle();
			},
			onSubagentsChanged: (subagents) => changes.push(subagents),
		},
	);
	f.cleanup.push(() => session.close());
	await settled;
	const view = await session.conversation.context(context);
	const users = view.messages.filter((message) => message.role === "user");
	assert.deepEqual(
		users.map((message) => message.content),
		[answer.content],
	);
	assert.equal(view.messages.at(-1)?.role, "assistant");
	assert.equal(f.faux.state.callCount, 1);

	assert.deepEqual(changes, [[entry]], "malformed entries are dropped");
	assert.deepEqual(session.subagentList, [entry]);
	await session.subagentCommand({ action: "send", name: "review", message: "focus", requestId: "r1" });
	await session.subagentCommand({ action: "send", name: "review", message: "then", mode: "followUp" });
	await session.subagentCommand({ action: "stop", name: "review", requestId: "r3" });
	await assert.rejects(session.subagentCommand({ action: "stop", name: "missing" }), /No subagent named missing/);
	assert.deepEqual(commands[0], {
		requestId: "r1",
		action: "send",
		name: "review",
		message: "focus",
		followUp: false,
	});
	assert.equal((commands[1] as { followUp: boolean }).followUp, true);
	assert.deepEqual(commands[2], { requestId: "r3", action: "stop", name: "review" });
	assert.equal(commands.length, 3);
});

test("the bridge rejects commands before the extension reports and when the extension refuses", async () => {
	const bus = createEventBus();
	const bridge = new SubagentBridge();
	await assert.rejects(bridge.command({ action: "stop", name: "review" }), /not loaded/);
	bridge.attach(bus);
	await assert.rejects(bridge.command({ action: "stop", name: "review" }), /not loaded/);
	bus.emit("subagents:snapshot", { agents: [{ ...entry, name: "other" }] });
	bus.on("subagents:command", (data) =>
		bus.emit("subagents:command-result", {
			requestId: (data as { requestId: string }).requestId,
			ok: false,
			error: "nope",
		}),
	);
	await assert.rejects(bridge.command({ action: "stop", name: "review" }), /No subagent named review/);
	await assert.rejects(bridge.command({ action: "stop", name: "other" }), /nope/);
	bridge.detach();
	await assert.rejects(bridge.command({ action: "stop", name: "other" }), /not loaded/);
});
