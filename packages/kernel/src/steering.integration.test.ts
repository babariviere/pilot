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
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ConversationBusy, Harness, InboxDoc } from "@earendil-works/pi-durable";
import { HeldInputsDoc } from "./held-inputs.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { QUESTION_ENTRY } from "./question-tool.ts";
import { queueGuardToken } from "./queue.ts";
import { KernelSession } from "./session.ts";
import { openSessionReader } from "./storage.ts";

const users = (transcript: { messages: readonly { role: string; content: unknown }[] }) =>
	transcript.messages.filter((message) => message.role === "user").map((message) => message.content);
const boundary = () => fauxAssistantMessage([fauxToolCall("missing", {})], { stopReason: "toolUse" });

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Hold a real provider request without timers, and join it on Stop/close/test failure. */
function blocked(t: TestContext, result = boundary()) {
	const started = gate();
	const finish = gate();
	t.after(finish.resolve);
	return {
		started: started.promise,
		release: finish.resolve,
		async respond(_transcript: unknown, options?: { signal?: AbortSignal }) {
			const aborted = gate();
			const signal = options?.signal;
			signal?.addEventListener("abort", aborted.resolve, { once: true });
			started.resolve();
			try {
				if (!signal?.aborted) await Promise.race([finish.promise, aborted.promise]);
				return signal?.aborted ? fauxAssistantMessage("", { stopReason: "aborted" }) : result;
			} finally {
				signal?.removeEventListener("abort", aborted.resolve);
			}
		},
	};
}

async function fixture(
	t: TestContext,
	modes: { steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time" } = {},
) {
	const root = await mkdtemp(join(tmpdir(), "pilot-steering-"));
	t.mock.method(globalThis, "fetch", () => assert.fail("steering fixture must stay offline"));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "steering-test", models: [{ id: "offline", contextWindow: 32_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const openAdapter = NativeAdapter.open;
	t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
		openAdapter.call(NativeAdapter, {
			...options,
			projectTrusted: false,
			bundledExtensions: false,
			settingsManager: SettingsManager.inMemory({ defaultTools: [], steeringMode: "all" }),
			sessionOptions: { ...options.sessionOptions, modelRuntime: runtime, model: faux.getModel() },
			loaderOptions: {
				cwd: root,
				agentDir: join(root, "agent"),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: "Offline steering fixture.",
			},
		}),
	);
	const spec = { sessionId: "steering", cwd: root, agentDir: join(root, "agent"), storageDir: join(root, "store") };
	if (Object.keys(modes).length) {
		const open = Harness.open;
		t.mock.method(Harness, "open", (...[storage, options, ctx]: Parameters<typeof open>) =>
			open.call(Harness, storage, { ...options, settings: { ...options.settings, ...modes } }, ctx),
		);
	}
	const open = () => KernelSession.open(spec, { onWorking: () => {} });
	let session = await open();
	t.after(async () => {
		await session.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		faux,
		storageDir: spec.storageDir,
		get session() {
			return session;
		},
		async record(requestId: string) {
			const record = await session.conversation.commit(
				(tx) => tx.submissionByRequest(session.conversation.id, requestId),
				context,
			);
			assert.ok(record);
			return record;
		},
		async reopen() {
			await session.close();
			session = await open();
		},
	};
}

for (const count of [0, 1, 3]) {
	for (const oneAtATime of count === 3 ? [true, false] : [false]) {
		test(`${oneAtATime ? "SDK one-at-a-time reproduction" : "kernel all mode"}: ${count} queued steers`, {
			timeout: 15_000,
		}, async (t) => {
			// Reproduce the SDK default explicitly, without changing production or user settings.
			const f = await fixture(t, oneAtATime ? { steeringMode: "one-at-a-time" } : {});
			const first = blocked(t);
			const corrections = Array.from({ length: count }, (_, i) => `Correction ${i}`);
			const rounds = oneAtATime ? count : 1;
			f.faux.setResponses([
				first.respond,
				...Array.from({ length: rounds }, (_, i) => (transcript: Parameters<typeof users>[0]) => {
					assert.deepEqual(users(transcript), ["Start", ...corrections.slice(0, oneAtATime ? i + 1 : count)]);
					return i + 1 === rounds ? fauxAssistantMessage("Done") : boundary();
				}),
			]);
			await f.session.submit("start", "Start", "steer");
			await first.started;
			for (const text of corrections)
				assert.deepEqual(await f.session.submit(text, text, "steer", false, true), { delivery: "queued" });
			first.release();
			await f.session.harness.waitForIdle(context);
			assert.equal(f.faux.state.callCount, rounds + 1);
			const records = await Promise.all(corrections.map((text) => f.record(text)));
			assert.ok(records.every((r) => r.status === "done"));
			assert.equal(new Set(records.map((r) => r.entry)).size, count, "each message keeps its own entry");
		});
	}
}

test("arrival during drain waits for the next boundary; duplicate request IDs never replace or repeat", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const first = blocked(t);
	const second = blocked(t);
	f.faux.setResponses([
		first.respond,
		async (transcript, options) => {
			assert.deepEqual(users(transcript), ["Start", "Same", "Same"]);
			return second.respond(transcript, options);
		},
		(transcript) => {
			assert.deepEqual(users(transcript), ["Start", "Same", "Same", "Late 1", "Late 2"]);
			return fauxAssistantMessage("Done");
		},
	]);
	const placements: string[][] = [];
	let arrival: ReturnType<KernelSession["submit"]> | undefined;
	const unsubscribe = f.session.harness.subscribeCommits(({ changes }) => {
		const placed = changes.flatMap((change) =>
			change.type === "submission" && change.value.status === "placed" && change.value.requestId !== "start"
				? [change.value.requestId!]
				: [],
		);
		if (placed.length) placements.push(placed.sort());
		// Admission arriving at the drain's committed publication cannot enter that captured batch.
		if (placed.includes("a")) arrival = f.session.submit("c", "Late 1", "steer", false, true);
	});
	t.after(unsubscribe);
	await f.session.submit("start", "Start", "steer");
	await first.started;
	for (const id of ["a", "b"]) await f.session.submit(id, "Same", "steer");
	const original = await f.record("a");
	assert.deepEqual(await f.session.submit("a", "Must not replace", "followUp", false, true), { delivery: "queued" });
	const reader = await openSessionReader(f.storageDir);
	assert.ok(reader);
	try {
		assert.deepEqual(await reader.submissionByRequest(f.session.conversation.id, "a", context), original);
	} finally {
		await reader.close(context);
	}
	first.release();
	await second.started;
	assert.ok(arrival);
	assert.deepEqual(await arrival, { delivery: "queued" });
	for (const id of ["a", "b"]) assert.equal((await f.record(id)).status, "placed");
	await f.session.submit("d", "Late 2", "steer");
	assert.deepEqual(await f.session.submit("a", "Must not resend", "steer", false, true), { delivery: "delivered" });
	second.release();
	await f.session.harness.waitForIdle(context);
	assert.deepEqual(
		placements,
		[
			["a", "b"],
			["c", "d"],
		],
		"placement is one committed batch per boundary",
	);
	assert.equal((await f.record("a")).id, original.id);
	await f.reopen();
	assert.deepEqual(await f.session.submit("a", "No replay after reopen", "steer", false, true), {
		delivery: "delivered",
	});
	await f.session.harness.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 3);
});

for (const final of [false, true]) {
	for (const oneAtATime of final ? [false, true] : [false]) {
		test(`${final ? "final" : "tool"} boundary, ${oneAtATime ? "one-at-a-time" : "all"}: separate follow-ups and captured edits/removals`, {
			timeout: 15_000,
		}, async (t) => {
			const f = await fixture(t, oneAtATime ? { steeringMode: "one-at-a-time" } : {});
			const first = blocked(t, final ? fauxAssistantMessage("Initial answer") : boundary());
			const received: unknown[][] = [];
			const expected = [
				...(oneAtATime ? [["Start", "Edited"]] : []),
				["Start", "Edited", "Keep"],
				["Start", "Edited", "Keep", "Later 1"],
				["Start", "Edited", "Keep", "Later 1", "Later 2"],
			];
			f.faux.setResponses([
				first.respond,
				...expected.map((_, i) => (transcript: Parameters<typeof users>[0]) => {
					received.push(users(transcript));
					return fauxAssistantMessage(`Answer ${i}`);
				}),
			]);
			await f.session.submit("start", "Start", "steer");
			await first.started;
			for (const [id, text, mode] of [
				["later1", "Later 1", "followUp"],
				["edit", "Original", "steer"],
				["remove", "Remove", "steer"],
				["later2", "Later 2", "followUp"],
				["keep", "Keep", "steer"],
			] as const)
				await f.session.submit(id, text, mode);
			const inbox = await f.session.harness.snapshot(InboxDoc, f.session.conversation.id, context);
			const edit = inbox!.items[1]!;
			const remove = inbox!.items[2]!;
			await f.session.editQueuedMessage(edit.id, "Edited", undefined, queueGuardToken(edit));
			await assert.rejects(f.session.removeQueuedMessage(edit.id, queueGuardToken(edit)), /changed/);
			await f.session.removeQueuedMessage(remove.id, queueGuardToken(remove));
			await assert.rejects(f.session.changeModel("steering-test/offline"), ConversationBusy);
			first.release();
			await f.session.harness.waitForIdle(context);
			assert.deepEqual(received, expected);
			assert.equal((await f.record("remove")).status, "unanswered");
			await assert.rejects(
				f.session.editQueuedMessage(edit.id, "Too late", undefined, queueGuardToken(edit)),
				/no longer queued/,
			);
			await assert.rejects(f.session.removeQueuedMessage(edit.id, queueGuardToken(edit)), /no longer queued/);
			const records = await Promise.all(["edit", "keep", "later1", "later2"].map((id) => f.record(id)));
			assert.ok(records.every((record) => record.status === "done"));
			assert.equal(new Set(records.map((record) => record.entry)).size, 4);
			assert.equal(f.faux.state.callCount, expected.length + 1);
		});
	}
}

test("reset boundary prioritizes steers while retaining explicit all-at-once follow-ups", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t, { followUpMode: "all" });
	const first = blocked(t);
	const second = blocked(t, fauxAssistantMessage("Steered answer"));
	const received: unknown[][] = [];
	f.faux.setResponses([
		first.respond,
		(transcript, options) => {
			received.push(users(transcript));
			return second.respond(transcript, options);
		},
		(transcript) => {
			received.push(users(transcript));
			return fauxAssistantMessage("Follow-up answer");
		},
	]);
	await f.session.submit("start", "Start", "steer");
	await first.started;
	await f.session.submit("later1", "Later 1", "followUp");
	for (const id of ["a", "b"]) await f.session.submit(id, id, "steer");
	await f.session.submit("later2", "Later 2", "followUp");
	await f.session.conversation.reset(undefined, context);
	first.release();
	await second.started;
	for (const id of ["a", "b"]) assert.equal((await f.record(id)).status, "placed");
	for (const id of ["later1", "later2"]) assert.equal((await f.record(id)).status, "queued");
	second.release();
	await f.session.harness.waitForIdle(context);
	assert.deepEqual(received, [
		["a", "b"],
		["a", "b", "Later 1", "Later 2"],
	]);
	const ids = ["a", "b", "later1", "later2"];
	const records = await Promise.all(ids.map((id) => f.record(id)));
	assert.ok(records.every((record) => record.status === "done"));
	await f.reopen();
	for (const id of ids)
		assert.deepEqual(await f.session.submit(id, "No replay", "steer", false, true), { delivery: "delivered" });
	assert.deepEqual(await Promise.all(ids.map((id) => f.record(id))), records);
	assert.equal(f.faux.state.callCount, 3);
});

for (const stop of [false, true]) {
	test(`${stop ? "Stop" : "model failure"} before the boundary never silently delivers or repeats queued steers`, {
		timeout: 15_000,
	}, async (t) => {
		const f = await fixture(t);
		const first = blocked(t, fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid request" }));
		f.faux.setResponses([first.respond]);
		await f.session.submit("start", "Start", "steer");
		await first.started;
		for (const id of ["a", "b"]) await f.session.submit(id, id, "steer");
		if (stop)
			assert.deepEqual(await f.session.abort(), [
				{ requestId: "a", content: "a" },
				{ requestId: "b", content: "b" },
			]);
		else first.release();
		await f.session.harness.waitForIdle(context);
		for (const id of ["a", "b"]) assert.equal((await f.record(id)).status, stop ? "unanswered" : "queued");
		await f.reopen();
		assert.equal(f.faux.state.callCount, 1, "reopen does not replay the failed request or consume waiting input");
		f.faux.setResponses([
			(transcript) => {
				assert.deepEqual(users(transcript), ["Start", ...(stop ? [] : ["a", "b"]), "Next"]);
				return fauxAssistantMessage("Recovered");
			},
		]);
		assert.deepEqual(
			await f.session.submit("a", "Retry must not replace", "steer", false, true),
			stop ? { delivery: "not_started", reason: "stopped" } : { delivery: "queued" },
		);
		await f.session.submit("next", "Next", "followUp");
		await f.session.harness.waitForIdle(context);
		assert.equal(f.faux.state.callCount, 2);
	});
}

test("paused steers survive recovery and cannot bypass an input-control revision", { timeout: 15_000 }, async (t) => {
	const f = await fixture(t);
	await f.session.pauseInputs(10);
	const ids = ["mission:send:a", "native:jobs.result:b", "user:c"];
	for (const id of ids) assert.deepEqual(await f.session.submit(id, id, "steer", false, true), { delivery: "queued" });
	await f.reopen();
	await f.session.resumeInputs(9);
	assert.equal(f.faux.state.callCount, 0);
	assert.equal(
		(await f.session.harness.snapshot(HeldInputsDoc, f.session.conversation.id, context))!.items.length,
		ids.length,
	);
	f.faux.setResponses([
		(transcript) => {
			assert.deepEqual(users(transcript), ids);
			return fauxAssistantMessage("Resumed");
		},
	]);
	await f.session.resumeInputs(11);
	await f.session.harness.waitForIdle(context);
	await f.session.resumeInputs(11);
	assert.equal(f.faux.state.callCount, 1);
	assert.deepEqual(users(await f.session.conversation.context(context)), ids);
	assert.ok((await Promise.all(ids.map((id) => f.record(id)))).every((record) => record.status === "done"));
});

test("model failure after batch placement keeps exact per-message failure evidence across recovery", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const first = blocked(t);
	let received: unknown[] | undefined;
	f.faux.setResponses([
		first.respond,
		(transcript) => {
			received = users(transcript);
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid request" });
		},
	]);
	await f.session.submit("start", "Start", "steer");
	await first.started;
	for (const id of ["a", "b"]) await f.session.submit(id, id, "steer");
	first.release();
	await f.session.harness.waitForIdle(context);
	assert.deepEqual(received, ["Start", "a", "b"]);
	const records = await Promise.all(["a", "b"].map((id) => f.record(id)));
	for (const record of records) {
		assert.equal(record.status, "unanswered");
		if (record.status === "unanswered") assert.equal(record.reason, "model_error");
		assert.ok(record.entry, "failed input keeps its original placed entry");
	}
	assert.notEqual(records[0]!.entry, records[1]!.entry);
	await f.reopen();
	assert.deepEqual(await f.session.submit("a", "No replay", "steer", false, true), {
		delivery: "not_started",
		reason: "failed",
	});
	assert.deepEqual(await Promise.all(["a", "b"].map((id) => f.record(id))), records);
	assert.equal(f.faux.state.callCount, 2);
});

test("all-mode automatic steers cannot answer a pending question at publication or after reopen", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const first = blocked(
		t,
		fauxAssistantMessage(
			[fauxToolCall("ask_user", { question: "Which option?", options: [{ label: "A" }, { label: "B" }] })],
			{ stopReason: "toolUse" },
		),
	);
	f.faux.setResponses([first.respond]);
	await f.session.submit("start", "Start", "steer");
	await first.started;
	for (const id of ["mission:send:a", "mission:send:b"]) await f.session.submit(id, id, "steer");
	first.release();
	await f.session.harness.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 1, "automatic steers must wait rather than answering the question");
	const view = await f.session.conversation.context(context);
	assert.deepEqual(users(view), ["Start"]);
	assert.equal(view.entries.filter((e) => e.kind === QUESTION_ENTRY).length, 1);
	for (const id of ["mission:send:a", "mission:send:b"]) assert.equal((await f.record(id)).status, "queued");
	await f.reopen();
	assert.deepEqual(await f.session.submit("native:jobs.result:c", "Job finished", "steer", false, true), {
		delivery: "queued",
	});
	await f.session.harness.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 1);
	assert.deepEqual(users(await f.session.conversation.context(context)), ["Start"]);
	await f.session.resumeInputs();
	await f.session.sendHeldMessages();
	await f.session.harness.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 1, "queue controls cannot answer the question either");
	const afterAnswer = ["Start", "B", "mission:send:a", "mission:send:b", "Job finished"];
	f.faux.setResponses(
		Array.from({ length: 4 }, (_, i) => (transcript: Parameters<typeof users>[0]) => {
			assert.deepEqual(
				users(transcript),
				afterAnswer.slice(0, i + 2),
				"the explicit answer runs alone, then FIFO follow-ups",
			);
			return fauxAssistantMessage("Done");
		}),
	);
	await f.session.submit("answer", "B", "steer");
	await f.session.harness.waitForIdle(context);
	assert.equal(f.faux.state.callCount, 5);
	assert.deepEqual(users(await f.session.conversation.context(context)), afterAnswer);
	const ids = ["answer", "mission:send:a", "mission:send:b", "native:jobs.result:c"];
	const records = await Promise.all(ids.map((id) => f.record(id)));
	assert.ok(records.every((record) => record.status === "done"));
	await f.reopen();
	for (const id of ids)
		assert.deepEqual(await f.session.submit(id, "No replay", "steer", false, true), { delivery: "delivered" });
	assert.deepEqual(await Promise.all(ids.map((id) => f.record(id))), records);
	assert.equal(f.faux.state.callCount, 5);
});
