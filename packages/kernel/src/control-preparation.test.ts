import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type ConversationId,
	type GenerationHooks,
	type Harness,
	type Storage,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { ControlPreparationRecord } from "./control-preparation.ts";
import { ControlTurn } from "./control-turn.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import { KernelSession } from "./session.ts";

test("cancellation and a broken diagnostic sink preserve abort handling without a failed outcome", async () => {
	const controller = new AbortController();
	const events: ControlPreparationRecord[] = [];
	const error = new Error("private abort reason");
	const host = { snapshot: async () => ({ run: { inputs: [1] } }) } as unknown as Harness;
	const storage = {
		submission: async () => ({ entry: 1 }),
		scanEntries: async () => ({ items: [] }),
	} as unknown as Storage;
	const turn = new ControlTurn(
		async () => {
			controller.abort(error);
			throw error;
		},
		() => host,
		storage,
		() => 1 as ConversationId,
		(event) => {
			events.push(event);
			throw new Error("private sink failure");
		},
	);
	const extension = turn.prepare({ name: "test" }, () => assert.fail("must not prepare"));
	const handler = extension.hooks![0]!.handlers as GenerationHooks;
	await assert.rejects(
		async () =>
			handler.beforeRequest!(
				{ messages: [] },
				{} as Parameters<NonNullable<GenerationHooks["beforeRequest"]>>[1],
				withAbortSignal(controller.signal, context),
			),
		(caught: unknown) => caught === error,
	);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.outcome, "cancelled");
	assert.equal(events[0]?.reason, undefined);
	assert.doesNotMatch(JSON.stringify(events), /private/);
});

for (const fail of [true, false])
	test(`Control preparation ${fail ? "failure" : "success"} has a content-free correlated outcome without replay`, {
		timeout: 30_000,
	}, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "control-preparation-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		t.mock.method(globalThis, "fetch", () => assert.fail("fixture must remain offline"));
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const faux = fauxProvider();
		runtime.registerNativeProvider(faux.provider);
		const open = NativeAdapter.open;
		t.mock.method(NativeAdapter, "open", (options: NativeAdapterOptions) =>
			open.call(NativeAdapter, {
				...options,
				settingsManager: SettingsManager.inMemory(),
				sessionOptions: { modelRuntime: runtime, model: faux.getModel() },
			}),
		);
		let calls = 0,
			actions = 0,
			publish!: () => void;
		const published = new Promise<void>((resolve) => {
			publish = resolve;
		});
		const session = await KernelSession.open(
			{
				sessionId: "synthetic-control",
				cwd: root,
				storageDir: join(root, "durable"),
				control: true,
			},
			{
				onWorking: (_working, completion) => {
					if (completion) publish();
				},
				callPilot: async () => {
					actions++;
					return null;
				},
				callControl: async (action) => {
					if (action !== "prepare") return null;
					calls++;
					if (fail) throw new Error("PRIVATE_RAW_ERROR: PRIVATE_MESSAGE_CONTENT");
					return { lines: [] };
				},
			},
		);
		t.after(() => session.close());
		const retained = await session.conversation.commit(
			async (tx) =>
				tx.appendEntry(UserEntry, session.conversation.id, {
					model: [{ role: "user", content: "PRIVATE_RETAINED_HISTORY", timestamp: 1 }],
				}),
			context,
		);
		faux.setResponses([
			fail
				? fauxAssistantMessage(
						{
							type: "toolCall",
							name: "codemode",
							id: "must-not-run",
							arguments: { code: 'await tools.pilot({action:"status"});' },
						},
						{ stopReason: "toolUse" },
					)
				: fauxAssistantMessage("prepared request answered"),
		]);
		await session.submit("PRIVATE_REQUEST_ID", "PRIVATE_MESSAGE_CONTENT", "followUp");
		await session.conversation.waitForIdle(context);
		await published;
		assert.equal(session.completion?.outcome, fail ? "failed" : "done");
		assert.equal(calls, 1, "no automatic prepare retry");
		assert.equal(faux.state.callCount, fail ? 0 : 1, "failed preparation cannot dispatch or replay the action");
		assert.equal(actions, 0);
		const history = await session.conversation.context(context);
		assert.deepEqual(
			history.entries.find((entry) => entry.id === retained.id),
			retained,
			"existing history stays unchanged",
		);
		assert.equal(
			history.entries.some((entry) => entry.edits?.length),
			false,
		);
		// The existing UI failure row is appended, never used to replace or summarize retained history.
		assert.equal(
			history.messages.filter((message) => message.role === "user" && message.content === "PRIVATE_MESSAGE_CONTENT")
				.length,
			1,
		);
		const reason = session.completion?.outcomeReason;
		await session.close(); // drain the local log, without reopening, retrying or resubmitting
		const text = await readFile(join(root, "durable", "performance.jsonl"), "utf8");
		const records = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const events = records.filter((record) => record.source === "control_preparation");
		assert.equal(events.length, 1);
		const event = events[0]!;
		assert.equal(event.outcome, fail ? "failed" : "prepared");
		assert.equal(event.stage, fail ? "history_summarization" : "request_projection");
		assert.equal(event.reason, fail ? "preparation_failure" : undefined);
		assert.ok(Number.isFinite(event.at) && event.durationMs >= 0);
		if (fail) assert.ok(reason?.includes(event.attemptRef), "the failed outcome correlates to the diagnostic event");
		assert.doesNotMatch(text, /PRIVATE|RAW_ERROR|MESSAGE_CONTENT|RETAINED_HISTORY|REQUEST_ID/);
		assert.doesNotMatch(JSON.stringify(session.completion), /PRIVATE/);
	});
