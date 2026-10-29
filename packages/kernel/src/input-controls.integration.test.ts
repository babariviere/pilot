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
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { HeldInputsDoc } from "./held-inputs.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import type { MissionContext } from "./policy.ts";
import { QUESTION_ENTRY } from "./question-entry.ts";
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
	let adapter!: NativeAdapter;
	t.mock.method(
		NativeAdapter,
		"open",
		async (options: NativeAdapterOptions) =>
			(adapter = await openAdapter.call(NativeAdapter, {
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
			})),
	);
	const awaited: (string | undefined)[] = [];
	const open = () =>
		KernelSession.open(
			{ sessionId: "controls", cwd: root, storageDir: join(root, "durable"), agentDir: join(root, "agent") },
			{ onWorking: () => {}, onQuestionAwaited: (question) => awaited.push(question) },
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
		awaited,
		get session() {
			return session;
		},
		get native() {
			return adapter.session;
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

async function waitingQuestion(f: Awaited<ReturnType<typeof fixture>>, count = 1) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const entries = (await f.session.conversation.context(context)).entries;
		if (
			entries.filter((e) => e.kind === QUESTION_ENTRY).length >= count &&
			(await f.session.harness.snapshot(HeldInputsDoc, f.session.conversation.id, context))?.questionPending
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("question did not become pending");
}

test("automatic input preserves a pending question across reconnect and runs FIFO only after its answer", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	const requests: string[] = [];
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "Which checks?" }), { stopReason: "toolUse" }),
		...Array.from({ length: 3 }, () => (view: { messages: unknown[] }) => {
			requests.push(JSON.stringify(view.messages));
			return fauxAssistantMessage("Finished.");
		}),
	]);
	await f.session.submit("user:ask", "Ask me", "followUp");
	await waitingQuestion(f);
	const before = (await f.session.conversation.context(context)).entries;
	assert.ok(before.some((entry) => entry.kind === QUESTION_ENTRY));
	for (const [requestId, content, mode] of [
		["mission:send:first", "first automatic", "followUp"],
		["native:jobs.result:second", "second automatic", "steer"],
	] as const) {
		assert.deepEqual(await f.session.submit(requestId, content, mode, false, true), { delivery: "queued" });
		assert.deepEqual(await f.session.submit(requestId, content, mode, false, true), { delivery: "queued" });
	}
	assert.equal(f.faux.state.callCount, 1, "no automatic answer or model request");
	assert.deepEqual((await f.session.conversation.context(context)).entries, before);
	await f.reopen();
	assert.equal(f.faux.state.callCount, 1);
	await f.session.sendHeldMessages();
	await f.session.resumeInputs();
	assert.equal(f.faux.state.callCount, 1, "queue controls cannot answer a question");
	assert.equal((await f.session.harness.snapshot(InboxDoc, f.session.conversation.id, context))?.items.length, 0);
	assert.equal((await f.session.harness.snapshot(LiveDoc, f.session.conversation.id, context))?.run, undefined);
	await f.session.submit("user:answer", "Tests please", "followUp");
	await f.session.conversation.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 4);
	assert.doesNotMatch(requests[0]!, /first automatic|second automatic/);
	assert.match(requests[0]!, /Tests please/);
	assert.match(requests[1]!, /first automatic/);
	assert.doesNotMatch(requests[1]!, /second automatic/);
	assert.match(requests[2]!, /second automatic/);
	await f.reopen();
	await f.session.submit("user:answer", "Tests please", "followUp");
	await f.session.submit("mission:send:first", "first automatic", "followUp");
	assert.equal(f.faux.state.callCount, 4, "lost ACK retries never repeat accepted work");
});

test("question publication fences already queued automatic input, including native notifications", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("control_gate", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "Where?" }), { stopReason: "toolUse" }),
	]);
	await f.session.submit("user:ask", "Ask me after the tool", "followUp");
	await f.started.promise;
	await f.session.submit("mission:send:before", "Before publication", "followUp");
	f.finish.resolve();
	await waitingQuestion(f);
	assert.equal(f.faux.state.callCount, 2, "final boundary cannot consume automatic input as an answer");
	await f.native.sendCustomMessage(
		{ customType: "jobs.result", content: "Native result", display: true },
		{ triggerTurn: true },
	);
	// Idempotent admission is a barrier for the native callback on the same input line.
	await f.session.submit("user:ask", "Ask me after the tool", "followUp");
	const held = await f.session.harness.snapshot(HeldInputsDoc, f.session.conversation.id, context);
	assert.deepEqual(
		held?.items.map((item) => item.content),
		["Before publication", "Native result"],
	);
	assert.equal(f.faux.state.callCount, 2);
	assert.equal(held?.questionPending, true);
});

test("Stop cancels the question gate without losing deferred work or starting it on reconnect", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "Proceed?" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Explicitly resumed."),
	]);
	await f.session.submit("user:ask", "Ask", "followUp");
	await waitingQuestion(f);
	const deadline = Date.now() + 5000;
	while (f.awaited.at(-1) !== "Proceed?" && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(f.awaited.at(-1), "Proceed?");
	await f.session.submit("watch-notice:first", "Retain this", "followUp");
	assert.deepEqual(await f.session.abort(), []);
	assert.equal(f.awaited.at(-1), undefined, "Stop clears the awaited question");
	await f.session.submit("control:send:late", "Retain late input", "steer");
	await f.reopen();
	const held = await f.session.harness.snapshot(HeldInputsDoc, f.session.conversation.id, context);
	assert.equal(held?.questionPending, false);
	assert.equal(held?.stopped, true);
	assert.equal(held?.items.length, 2);
	assert.equal(f.faux.state.callCount, 1);
	await f.session.resumeInputs();
	await f.session.conversation.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 2);
	assert.match(JSON.stringify((await f.session.conversation.context(context)).messages), /Retain this/);
});

test("passive mission decisions do not dismiss a question and survive recovery without waking it", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	const mission: MissionContext = {
		id: "fixture",
		title: "Fixture",
		goal: "Test",
		status: "active",
		coordinator: "other",
		tasks: [],
		decisions: [],
		decisionVersion: "1",
	};
	f.session.setMission(mission);
	let answerContext = "";
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "Which?" }), { stopReason: "toolUse" }),
		(view) => {
			answerContext = JSON.stringify(view.messages);
			return fauxAssistantMessage("Answered.");
		},
	]);
	await f.session.submit("user:ask", "Ask", "followUp");
	await waitingQuestion(f);
	const before = (await f.session.conversation.context(context)).entries;
	f.session.setMission({ ...mission, decisionVersion: "2", decisions: ["New binding rule"] });
	await f.session.submit("user:ask", "Ask", "followUp");
	assert.deepEqual((await f.session.conversation.context(context)).entries, before);
	await f.reopen();
	assert.equal(f.faux.state.callCount, 1);
	await f.session.submit("user:answer", "My answer", "followUp");
	await f.session.conversation.waitForIdle(context);
	assert.match(answerContext, /Mission decisions changed/);
	assert.match(answerContext, /My answer/);
	assert.equal(f.faux.state.callCount, 2);
});

test("idle-only automatic origins wait while an explicit user steer can answer", { timeout: 20_000 }, async (t) => {
	const f = await fixture(t);
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "Choose?" }), { stopReason: "toolUse" }),
		...Array.from({ length: 8 }, () => fauxAssistantMessage("Done.")),
	]);
	await f.session.submit("user:ask", "Ask", "followUp");
	await waitingQuestion(f);
	for (const prefix of [
		"mission-notice:",
		"watch-notice:",
		"control:",
		"mission:send:",
		"pr-follow-up:",
		"slack-reply:",
		"native:subagent:",
	]) {
		assert.deepEqual(await f.session.submit(`${prefix}fixture`, prefix, "followUp", true, true), {
			delivery: "queued",
		});
	}
	assert.equal(f.faux.state.callCount, 1);
	await f.session.submit("native:user:answer", "User steer", "steer");
	await f.session.conversation.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 9);
});

test("a second question keeps deferred automatic input waiting instead of treating it as a reply", {
	timeout: 20_000,
}, async (t) => {
	const f = await fixture(t);
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "First choice?" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("ask_user", { question: "Second choice?" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Answered both."),
		fauxAssistantMessage("Processed notice."),
	]);
	await f.session.submit("user:ask", "Ask", "followUp");
	await waitingQuestion(f);
	const event = { kind: "mission_updated" as const, text: "Fixture task changed" };
	await f.session.submit("mission-notice:fixture", "Deferred notice", "followUp", true, true, event);
	await f.session.submit("user:first-answer", "First answer", "steer");
	await waitingQuestion(f, 2);
	assert.equal(f.faux.state.callCount, 2);
	assert.deepEqual(await f.session.submit("user:first-answer", "First answer", "steer", false, true), {
		delivery: "delivered",
	});
	assert.equal(
		(await f.session.harness.snapshot(HeldInputsDoc, f.session.conversation.id, context))?.questionPending,
		true,
		"a lost ACK retry cannot answer a different question",
	);
	assert.equal((await f.session.harness.snapshot(HeldInputsDoc, f.session.conversation.id, context))?.items.length, 1);
	assert.doesNotMatch(JSON.stringify((await f.session.conversation.context(context)).messages), /Deferred notice/);
	await f.session.submit("user:second-answer", "Second answer", "steer");
	await f.session.conversation.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 4);
	const entries = (await f.session.conversation.context(context)).entries;
	assert.deepEqual(
		entries.find((entry) => entry.model?.some((m) => m.role === "user" && m.content === "Deferred notice"))?.data,
		{ event },
	);
});
