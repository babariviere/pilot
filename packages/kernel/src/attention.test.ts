import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineTool,
	Harness,
	LiveDoc,
	MemoryStorage,
	type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AttentionDoc, classifyCompletion, reconcileCompletion, reportStatus, withAttention } from "./attention.ts";

async function fixture(storage = new MemoryStorage()) {
	const faux = fauxProvider({ tokensPerSecond: 0 });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(withAttention({ name: "native" }));
	const harness = await Harness.open(storage, { models, registry, settings: { retry: { maxRetries: 0 } } }, context);
	const model = faux.getModel();
	const conversation = await harness.root(context, {
		agent: { model: { provider: model.provider, modelId: model.id } },
	});
	return { faux, harness, conversation, storage, registry };
}

test("an ordinary final response is done, including an optional question", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([fauxAssistantMessage("Done. Would you like anything else?")]);
		const submission = await f.conversation.submit({ type: "input", content: "do something" }, context);
		assert.equal((await submission.wait(context)).status, "done");
		const result = await reconcileCompletion(f.storage, f.harness, f.conversation, context);
		assert.equal(result?.outcome, "done");
		assert.deepEqual(await reconcileCompletion(f.storage, f.harness, f.conversation, context), result);
	} finally {
		await f.harness.close(context);
	}
});

test("explicit blocking signal is needs_input, a new run does not inherit it", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(reportStatus.name, { status: "needs_input", reason: "Choose which database to use" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Which database should I use?"),
			fauxAssistantMessage("Implemented using SQLite."),
		]);
		const first = await f.conversation.submit({ type: "input", content: "implement storage" }, context);
		await first.wait(context);
		const blocked = await reconcileCompletion(f.storage, f.harness, f.conversation, context);
		assert.equal(blocked?.outcome, "needs_input");
		assert.equal(blocked?.outcomeReason, "Choose which database to use");
		const reply = await f.conversation.submit({ type: "input", content: "SQLite" }, context);
		await reply.wait(context);
		const done = await reconcileCompletion(f.storage, f.harness, f.conversation, context);
		assert.equal(done?.outcome, "done");
		assert.ok(done!.outcomeAt > blocked!.outcomeAt);
	} finally {
		await f.harness.close(context);
	}
});

test("failed generations are not completed successfully", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider unavailable" })]);
		const submission = await f.conversation.submit({ type: "input", content: "hello" }, context);
		assert.equal((await submission.wait(context)).status, "unanswered");
		const outcome = await reconcileCompletion(f.storage, f.harness, f.conversation, context);
		assert.equal(outcome?.outcome, "failed");
		assert.match(outcome?.outcomeReason ?? "", /Provider unavailable/);
	} finally {
		await f.harness.close(context);
	}
});

test("stops and errors override earlier needs_input signals", () => {
	const signal = { input: 1, outcome: "needs_input", reason: "Please approve" } as const;
	const record = { id: 1, type: "input", status: "unanswered", reason: "aborted" } as SubmissionRecord;
	assert.deepEqual(classifyCompletion(record, signal), { outcome: "stopped" });
	assert.deepEqual(
		classifyCompletion({ ...record, reason: "model_error", detail: "Offline" } as SubmissionRecord, signal),
		{ outcome: "failed", outcomeReason: "Offline" },
	);
});

test("recovery after run settles but before publication, and outcome version survives reopen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-attention-"));
	const file = join(dir, "session.sqlite");
	const faux = fauxProvider({ tokensPerSecond: 0 });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(withAttention({ name: "native" }));
	const open = async () => {
		const storage = await openNodeSqliteStorage(file);
		const harness = await Harness.open(storage, { models, registry }, context);
		const model = faux.getModel();
		const conversation = await harness.root(context, {
			agent: { model: { provider: model.provider, modelId: model.id } },
		});
		return { storage, harness, conversation };
	};
	try {
		let f = await open();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall(reportStatus.name, { status: "needs_input", reason: "Need credentials" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Please provide credentials."),
		]);
		await (await f.conversation.submit({ type: "input", content: "connect" }, context)).wait(context);
		assert.equal((await f.harness.snapshot(AttentionDoc, f.conversation.id, context))?.completion, undefined);
		await f.harness.close(context);
		f = await open();
		const recovered = await reconcileCompletion(f.storage, f.harness, f.conversation, context);
		assert.equal(recovered?.outcome, "needs_input");
		await f.harness.close(context);
		f = await open();
		assert.deepEqual(await reconcileCompletion(f.storage, f.harness, f.conversation, context), recovered);
		await f.harness.close(context);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("reporting records state without keeping a live run or a blocked tool", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall(reportStatus.name, { status: "needs_input", reason: "Need approval" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("May I proceed?"),
		]);
		await (await f.conversation.submit({ type: "input", content: "do it" }, context)).wait(context);
		assert.equal((await f.harness.snapshot(LiveDoc, f.conversation.id, context))?.run, undefined);
		assert.equal((await f.harness.inspect(context)).tasks.length, 0);
		assert.equal(reportStatus.replay, "safe");
	} finally {
		await f.harness.close(context);
	}
});

test("a later explicit done report supersedes a blocking signal in the same run", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall(reportStatus.name, { status: "needs_input", reason: "Need a directory" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall(reportStatus.name, { status: "done", reason: "Found the configured directory" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done."),
		]);
		await (await f.conversation.submit({ type: "input", content: "find the directory" }, context)).wait(context);
		assert.equal((await reconcileCompletion(f.storage, f.harness, f.conversation, context))?.outcome, "done");
	} finally {
		await f.harness.close(context);
	}
});

test("recovery orders completed work by placement, not admission, and ignores withdrawn queued inputs", async () => {
	const f = await fixture();
	try {
		// A follow-up can be admitted before a steer but placed after the steered run finishes.
		const { followUp, steer } = await f.conversation.commit(async (tx) => {
			const followUp = await tx.createSubmission({
				conversationId: f.conversation.id,
				type: "input",
				status: "queued",
			});
			const steer = await tx.createSubmission({
				conversationId: f.conversation.id,
				type: "input",
				status: "queued",
			});
			const entry = await tx.appendEntry(f.conversation.id, { kind: "test.input" });
			tx.placeSubmission(steer.id, entry.id);
			const answer = await tx.appendEntry(f.conversation.id, { kind: "test.answer" });
			tx.settleSubmission(steer.id, { status: "done", answer: answer.id });
			const attention = await tx.doc(AttentionDoc, f.conversation.id);
			attention.signal = { input: steer.id, outcome: "needs_input", reason: "Need an answer" };
			return { followUp, steer };
		}, context);
		const blocked = await reconcileCompletion(f.storage, f.harness, f.conversation, context, [steer.id]);
		assert.equal(blocked?.outcome, "needs_input");
		await f.conversation.commit(async (tx) => {
			const entry = await tx.appendEntry(f.conversation.id, { kind: "test.input" });
			tx.placeSubmission(followUp.id, entry.id);
			const answer = await tx.appendEntry(f.conversation.id, { kind: "test.answer" });
			tx.settleSubmission(followUp.id, { status: "done", answer: answer.id });
			const withdrawn = await tx.createSubmission({
				conversationId: f.conversation.id,
				type: "input",
				status: "queued",
			});
			tx.settleSubmission(withdrawn.id, { status: "unanswered", reason: "aborted" });
		}, context);
		const completed = await reconcileCompletion(f.storage, f.harness, f.conversation, context);
		assert.equal(completed?.outcome, "done");
		assert.ok(completed!.outcomeAt > blocked!.outcomeAt);
	} finally {
		await f.harness.close(context);
	}
});

test("blocking report follows placement order when an older queued steer joins a later follow-up", async () => {
	const f = await fixture();
	const probe = defineTool({
		name: "probe",
		description: "A no-op test tool",
		parameters: Type.Object({}),
		execute: async () => ({}),
	});
	f.registry.install(withAttention({ name: "native", tools: [probe] }));
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	try {
		f.faux.setResponses([
			async () => {
				started();
				await gate;
				return fauxAssistantMessage("Initial work done.");
			},
			fauxAssistantMessage(fauxToolCall(probe.name, {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall(reportStatus.name, { status: "needs_input", reason: "Need approval" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("May I proceed?"),
		]);
		const initial = await f.conversation.submit({ type: "input", content: "initial task" }, context);
		await ready;
		const steerA = await f.conversation.submit({ type: "input", content: "steer A", whenBusy: "steer" }, context);
		const steerB = await f.conversation.submit({ type: "input", content: "steer B", whenBusy: "steer" }, context);
		const followUp = await f.conversation.submit(
			{ type: "input", content: "follow-up", whenBusy: "followUp" },
			context,
		);
		release();
		await Promise.all([initial.wait(context), steerA.wait(context), steerB.wait(context), followUp.wait(context)]);
		const state = await f.harness.snapshot(AttentionDoc, f.conversation.id, context);
		assert.equal(state?.signal?.input, steerB.id);
		assert.equal((await reconcileCompletion(f.storage, f.harness, f.conversation, context))?.outcome, "needs_input");
	} finally {
		release();
		await f.harness.close(context);
	}
});
