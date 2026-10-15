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
	Type,
} from "@earendil-works/pi-ai";
import { createEventBus, type ExtensionFactory, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AssistantEntry, Harness, InboxDoc, ToolTask } from "@earendil-works/pi-durable";
import type { QueueUpdateEvent } from "@pilot/protocol";
import { type ExtensionInput, NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import type { KernelSubagent } from "./protocol.ts";
import { KernelSession } from "./session.ts";
import { SubagentBridge } from "./subagents.ts";

const context = BACKGROUND_CONTEXT;

test("a queued Stop fences parked recovery until abort, preserving drafts and held automatic input", async (t) => {
	let effects = 0;
	const f = await fixture(t, [
		(pi) => {
			pi.registerTool({
				name: "stop_effect",
				label: "Offline effect",
				description: "Must not run during cancellation",
				parameters: Type.Object({}),
				async execute() {
					effects++;
					return { content: [{ type: "text", text: "effect" }], details: {} };
				},
			});
			pi.on("session_start", () => {
				pi.setActiveTools(["stop_effect"]);
			});
		},
	]);
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, { ...options, ...f.options }),
	);
	f.faux.setResponses([fauxAssistantMessage("New work only")]);
	const spec = { sessionId: "stopped-recovery", cwd: f.root, storageDir: join(f.root, "storage") };
	let session = await KernelSession.open(spec, { onWorking: () => {} });
	f.cleanup.push(() => session.close());
	await session.pauseForUpdate();
	await session.submit("first", "Unfinished work", "followUp");
	await session.submit("queued", "My unsent message", "followUp");
	await session.submit("mission:send:held", "Automatic work", "followUp");
	await session.conversation.commit(async (tx) => {
		const call = fauxToolCall("stop_effect", {});
		const entry = await tx.appendEntry(AssistantEntry, session.conversation.id, {
			model: [fauxAssistantMessage([call], { stopReason: "toolUse" })],
		});
		await tx.createTask(ToolTask, { assistant: entry.id, callId: call.id }, { ownership: { kind: "conversation" } });
	}, context);
	assert.equal(f.faux.state.callCount, 0);
	await session.close();
	session = await KernelSession.open({ ...spec, stopOnOpen: true }, { onWorking: () => {} });
	assert.equal((await session.harness.inspect(context)).scheduling, "paused");
	await session.pauseForUpdate();
	session.resumeAfterUpdate();
	assert.equal(f.faux.state.callCount, 0);
	await session.pauseForUpdate();
	assert.deepEqual(await session.abort(), [{ requestId: "queued", content: "My unsent message" }]);
	assert.equal(f.faux.state.callCount, 0, "cancellation cannot dispatch a recovered model request");
	assert.equal(effects, 0, "cancellation cannot execute a recovered tool");
	await session.submit("next", "Explicit new work", "followUp");
	await session.harness.inspect(context);
	assert.equal(f.faux.state.callCount, 0, "Stop cannot release an independent update pause");
	session.resumeAfterUpdate();
	await session.harness.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 1, "Stop releases its fences for the next user input");
});

for (const paused of [false, true]) {
	test(`follow-up delivery starts an ${paused ? "initially paused" : "idle"} kernel and busy input is queued`, async (t) => {
		const f = await fixture(t, []);
		const openAdapter = NativeAdapter.open;
		t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
			openAdapter.call(NativeAdapter, { ...options, ...f.options }),
		);
		if (paused) {
			const openHarness = Harness.open;
			t.mock.method(Harness, "open", async (...args: Parameters<typeof openHarness>) => {
				const harness = await openHarness(...args);
				t.mock.method(harness, "resume", () => {});
				return harness;
			});
		}
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		t.after(() => release());
		let started!: () => void;
		const generating = new Promise<void>((resolve) => {
			started = resolve;
		});
		f.faux.setResponses([
			async () => {
				started();
				await gate;
				return fauxAssistantMessage("First answer");
			},
			fauxAssistantMessage("Queued answer"),
		]);
		const session = await KernelSession.open(
			{ sessionId: "delivery", cwd: f.root, storageDir: join(f.root, "storage") },
			{ onWorking: () => {} },
		);
		f.cleanup.push(() => session.close());
		if (paused) assert.equal((await session.harness.inspect(context)).scheduling, "paused");
		assert.deepEqual(await session.submit("first", "Start a turn", "followUp", false, true), {
			delivery: "delivered",
		});
		await generating;
		assert.equal((await session.harness.inspect(context)).scheduling, "running");
		assert.deepEqual(await session.submit("second", "Run next", "followUp", false, true), { delivery: "queued" });
		release();
		await session.harness.waitForIdle(context);
		assert.equal((await session.harness.snapshot(InboxDoc, session.conversation.id, context))?.items.length, 0);
	});
}
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
		bundledExtensions: false,
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

test("live composer queue lists jobs separately initially, on updates and after reconnect without withdrawing them", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t, []);
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, { ...options, ...f.options }),
	);
	const session = await KernelSession.open(
		{ sessionId: "offline-job-queue", cwd: f.root, storageDir: join(f.root, "storage") },
		{ onWorking: () => {} },
	);
	f.cleanup.push(() => session.close());
	const enqueue = (requestId: string, content: string) =>
		session.conversation.commit(async (tx) => {
			const input = await tx.createSubmission({
				conversationId: session.conversation.id,
				requestId,
				type: "input",
				status: "queued",
			});
			(await tx.doc(InboxDoc, session.conversation.id)).items.push({ id: input.id, mode: "followUp", content });
			return input.id;
		}, context);
	const job = await enqueue("native:jobs.result:first", "Background job tests done");
	await enqueue("user:first", "User follow-up");
	const frames: QueueUpdateEvent[] = [];
	let updated!: () => void;
	const update = new Promise<void>((resolve) => {
		updated = resolve;
	});
	await session.watch(
		"queue",
		(events) => {
			for (const event of events) {
				if (event.type !== "queue_update") continue;
				frames.push(event);
				if (event.items.length === 2) updated();
			}
		},
		false,
	);
	assert.deepEqual(
		frames.at(-1)?.items.map((item) => item.content),
		["User follow-up"],
	);
	assert.deepEqual(
		frames.at(-1)?.automatic?.map(({ id, origin, mode, preview }) => ({ id, origin, mode, preview })),
		[{ id: job, origin: "job", mode: "followUp", preview: "Background job tests done" }],
	);
	await enqueue("native:jobs.result:second", "Another job done");
	await enqueue("user:second", "Another follow-up");
	await update;
	assert.deepEqual(
		frames.at(-1)?.items.map((item) => item.content),
		["User follow-up", "Another follow-up"],
	);
	assert.deepEqual(
		frames.at(-1)?.automatic?.map((item) => item.preview),
		["Background job tests done", "Another job done"],
	);
	await session.unwatch("queue");
	const beforeReconnect = frames.at(-1);
	await session.watch(
		"queue",
		(events) => {
			for (const event of events) if (event.type === "queue_update") frames.push(event);
		},
		false,
	);
	assert.deepEqual(frames.at(-1), beforeReconnect, "a reconnect reports the same waiting times");
	const receipt = await session.harness.submission(job, context);
	assert.equal((await receipt?.status(context))?.status, "queued", "hidden notification is still admitted");
	assert.equal((await session.harness.snapshot(InboxDoc, session.conversation.id, context))?.items.length, 4);
});

for (const nextUser of [false, true]) {
	test(`Stop holds both automatic modes across reopen, then ${nextUser ? "user input" : "Send now"} starts one run`, {
		timeout: 15_000,
	}, async (t) => {
		const f = await fixture(t, []);
		const openAdapter = NativeAdapter.open;
		t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
			openAdapter.call(NativeAdapter, { ...options, ...f.options }),
		);
		let started!: () => void;
		const generating = new Promise<void>((resolve) => {
			started = resolve;
		});
		f.faux.setResponses([
			async (_context, options) => {
				started();
				await new Promise<void>((resolve) =>
					options!.signal!.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("Interrupted");
			},
			fauxAssistantMessage("Resumed"),
		]);
		const storageDir = join(f.root, "storage");
		const spec = { sessionId: "held", cwd: f.root, storageDir };
		const events: import("./held-inputs.ts").SystemMessageStateEvent[] = [];
		let session = await KernelSession.open(spec, {
			onWorking: () => {},
			onSystemMessageState: (event) => events.push(event),
		});
		f.cleanup.push(() => session.close());
		assert.deepEqual(await session.submit("first", "Start", "steer", false, true), { delivery: "delivered" });
		await generating;
		assert.deepEqual(await session.submit("mission:send:follow", "Follow-up", "followUp", false, true), {
			delivery: "queued",
		});
		assert.deepEqual(await session.submit("mission:send:steer", "Correction", "steer", false, true), {
			delivery: "queued",
		});
		await session.submit("user-queued", "My unsent message", "followUp");
		assert.deepEqual(await session.abort(), [{ requestId: "user-queued", content: "My unsent message" }]);
		assert.equal(session.working, false);
		assert.equal(f.faux.state.callCount, 1);
		assert.deepEqual(
			events.map((event) => event.state),
			["held", "held"],
		);
		await session.close();
		session = await KernelSession.open(spec, {
			onWorking: () => {},
			onSystemMessageState: (event) => events.push(event),
		});
		const frames: QueueUpdateEvent[] = [];
		await session.watch(
			"held",
			(batch) => {
				for (const event of batch) if (event.type === "queue_update") frames.push(event);
			},
			false,
		);
		assert.equal(frames.at(-1)?.automatic?.length, 2);
		assert.ok(frames.at(-1)?.automatic?.every((item) => item.held));
		assert.equal(f.faux.state.callCount, 1, "reopen must not deliver held input");
		if (nextUser) await session.submit("next-user", "Next", "steer");
		else await session.sendHeldMessages();
		await session.harness.waitForIdle(context);
		assert.equal(f.faux.state.callCount, 2, "all held messages use one run");
		const view = await session.conversation.context(context);
		const text = view.entries
			.flatMap((entry) => entry.model ?? [])
			.filter((message) => message.role === "user")
			.map((message) => message.content);
		assert.deepEqual(text, ["Start", "Correction", "Follow-up", ...(nextUser ? ["Next"] : [])]);
		await session.sendHeldMessages();
		assert.equal(f.faux.state.callCount, 2, "repeat Send now is a no-op");
	});
}

test("busy steering joins the current turn at its next tool boundary, while follow-up waits", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t, []);
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, { ...options, ...f.options }),
	);
	let release!: () => void;
	let started!: () => void;
	const generating = new Promise<void>((resolve) => {
		started = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	t.after(() => release());
	f.faux.setResponses([
		async () => {
			started();
			await gate;
			return fauxAssistantMessage(
				{ type: "toolCall", id: "missing", name: "missing", arguments: {} },
				{ stopReason: "toolUse" },
			);
		},
		(transcript) => {
			const users = transcript.messages.filter((message) => message.role === "user");
			assert.deepEqual(
				users.map((message) => message.content),
				["Start", "Correction"],
			);
			return fauxAssistantMessage("Current answer");
		},
		(transcript) => {
			const users = transcript.messages.filter((message) => message.role === "user");
			assert.deepEqual(
				users.map((message) => message.content),
				["Start", "Correction", "Later"],
			);
			return fauxAssistantMessage("Follow-up answer");
		},
	]);
	const session = await KernelSession.open(
		{ sessionId: "steering", cwd: f.root, storageDir: join(f.root, "storage") },
		{ onWorking: () => {} },
	);
	f.cleanup.push(() => session.close());
	await session.submit("first", "Start", "steer");
	await generating;
	assert.deepEqual(await session.submit("mission:send:later", "Later", "followUp", false, true), {
		delivery: "queued",
	});
	assert.deepEqual(await session.submit("mission:send:correction", "Correction", "steer", false, true), {
		delivery: "queued",
	});
	release();
	await session.harness.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 3);
});

test("discard held actions keep the kernel stopped, emit per-message events, and leave waiting input read-only", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t, []);
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, { ...options, ...f.options }),
	);
	const states: import("./held-inputs.ts").SystemMessageStateEvent[] = [];
	const session = await KernelSession.open(
		{ sessionId: "discard", cwd: f.root, storageDir: join(f.root, "storage") },
		{
			onWorking: () => {},
			onSystemMessageState: (event) => states.push(event),
		},
	);
	f.cleanup.push(() => session.close());
	const ids = await session.harness.commit(async (tx) => {
		const inbox = await tx.doc(InboxDoc, session.conversation.id);
		const ids: number[] = [];
		for (const suffix of ["first", "second"]) {
			const input = await tx.createSubmission({
				conversationId: session.conversation.id,
				requestId: `mission:send:${suffix}`,
				type: "input",
				status: "queued",
			});
			inbox.items.push({ id: input.id, mode: "followUp", content: suffix });
			ids.push(input.id);
		}
		return ids;
	}, context);
	await assert.rejects(session.editQueuedMessage(ids[0]!, "Changed"), /read-only/);
	await assert.rejects(session.removeQueuedMessage(ids[0]!), /read-only/);
	await session.abort();
	await session.discardHeldMessages(ids[0]);
	await session.discardHeldMessages();
	const unique = new Map(states.map((event) => [event.id, event]));
	assert.deepEqual(
		[...unique.values()].map((event) => event.state),
		["held", "held", "discarded", "discarded"],
	);
	for (const id of ids) {
		const submission = await session.harness.submission(
			id as import("@earendil-works/pi-durable").SubmissionId,
			context,
		);
		assert.equal((await submission!.status(context)).status, "unanswered");
	}
	for (const event of unique.values()) await session.acknowledgeSystemMessageState(event.id);
	const published = states.length;
	await session.publishSystemMessageStates();
	assert.equal(states.length, published, "acknowledged events leave the durable outbox");
	assert.equal(session.working, false);
	assert.equal(f.faux.state.callCount, 0);
});
