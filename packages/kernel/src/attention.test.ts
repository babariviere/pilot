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
import { AttentionDoc, classifyCompletion, reconcileCompletion, normalizeCompletion } from "./attention.ts";

async function fixture(storage = new MemoryStorage()) {
	const faux = fauxProvider({ tokensPerSecond: 0 });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install({ name: "native" });
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

test("questions settle automatically, and a reply creates a new completion version", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([
			fauxAssistantMessage("Which database should I use?"),
			fauxAssistantMessage("Implemented using SQLite."),
		]);
		const first = await f.conversation.submit({ type: "input", content: "implement storage" }, context);
		await first.wait(context);
		// Older persisted signals are ignored even when they match the settled input.
		await f.conversation.commit(async (tx) => {
			Object.assign(await tx.doc(AttentionDoc, f.conversation.id), {
				signal: { input: first.id, outcome: "needs_input", reason: "Choose a database" },
			});
		}, context);
		const question = await reconcileCompletion(f.storage, f.harness, f.conversation, context);
		assert.equal(question?.outcome, "done");
		assert.equal(question?.outcomeReason, undefined);
		assert.equal((await f.harness.snapshot(LiveDoc, f.conversation.id, context))?.run, undefined);
		assert.equal((await f.harness.inspect(context)).tasks.length, 0);
		const reply = await f.conversation.submit({ type: "input", content: "SQLite" }, context);
		await reply.wait(context);
		const done = await reconcileCompletion(f.storage, f.harness, f.conversation, context);
		assert.equal(done?.outcome, "done");
		assert.ok(done!.outcomeAt > question!.outcomeAt);
	} finally {
		await f.harness.close(context);
	}
});

test("legacy needs-input completions normalize without changing their version", () => {
	assert.deepEqual(
		normalizeCompletion({ input: 1, entry: 2, outcome: "needs_input", outcomeAt: 42, outcomeReason: "Approve?" }),
		{ input: 1, entry: 2, outcome: "done", outcomeAt: 42 },
	);
});

test("persisted legacy completions normalize on reconciliation", async () => {
	const f = await fixture();
	try {
		await f.conversation.commit(async (tx) => {
			(await tx.doc(AttentionDoc, f.conversation.id)).completion = {
				input: 1,
				entry: 2,
				outcome: "needs_input",
				outcomeAt: 42,
				outcomeReason: "Approve?",
			};
		}, context);
		assert.deepEqual(await reconcileCompletion(f.storage, f.harness, f.conversation, context), {
			input: 1,
			entry: 2,
			outcome: "done",
			outcomeAt: 42,
		});
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

test("stops and errors are classified automatically", () => {
	const record = { id: 1, type: "input", status: "unanswered", reason: "aborted" } as SubmissionRecord;
	assert.deepEqual(classifyCompletion(record), { outcome: "stopped" });
	assert.deepEqual(classifyCompletion({ ...record, reason: "model_error", detail: "Offline" } as SubmissionRecord), {
		outcome: "failed",
		outcomeReason: "Offline",
	});
});

test("recovery after run settles but before publication, and outcome version survives reopen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-attention-"));
	const file = join(dir, "session.sqlite");
	const faux = fauxProvider({ tokensPerSecond: 0 });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install({ name: "native" });
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
		faux.setResponses([fauxAssistantMessage("Please provide credentials.")]);
		await (await f.conversation.submit({ type: "input", content: "connect" }, context)).wait(context);
		assert.equal((await f.harness.snapshot(AttentionDoc, f.conversation.id, context))?.completion, undefined);
		await f.harness.close(context);
		f = await open();
		const recovered = await reconcileCompletion(f.storage, f.harness, f.conversation, context);
		assert.equal(recovered?.outcome, "done");
		await f.harness.close(context);
		f = await open();
		assert.deepEqual(await reconcileCompletion(f.storage, f.harness, f.conversation, context), recovered);
		await f.harness.close(context);
	} finally {
		await rm(dir, { recursive: true, force: true });
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
			return { followUp, steer };
		}, context);
		const firstCompletion = await reconcileCompletion(f.storage, f.harness, f.conversation, context, [steer.id]);
		assert.equal(firstCompletion?.outcome, "done");
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
		assert.ok(completed!.outcomeAt > firstCompletion!.outcomeAt);
	} finally {
		await f.harness.close(context);
	}
});

test("an old session with status-tool history reopens without the retired declaration", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-legacy-status-"));
	const file = join(dir, "session.sqlite");
	const faux = fauxProvider({ tokensPerSecond: 0 });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	const retired = defineTool({
		name: "pilot_report_status",
		description: "Legacy status reporter",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api) => {
			await api.commit(async (tx) => {
				const inputs = (await tx.doc(LiveDoc, api.conversationId)).run!.inputs;
				Object.assign(await tx.doc(AttentionDoc, api.conversationId), {
					signal: { input: inputs.at(-1), outcome: "needs_input", reason: "Need approval" },
				});
			}, context);
			return { content: [{ type: "text", text: "Status recorded" }] };
		},
	});
	registry.install({ name: "native", tools: [retired] });
	let harness: Harness | undefined;
	try {
		const open = async () => {
			const storage = await openNodeSqliteStorage(file);
			harness = await Harness.open(storage, { models, registry }, context);
			const model = faux.getModel();
			const conversation = await harness.root(context, {
				agent: { model: { provider: model.provider, modelId: model.id }, extensions: [{ name: "native" }] },
			});
			return { storage, harness, conversation };
		};
		let f = await open();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall(retired.name, {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("May I proceed?"),
		]);
		await (await f.conversation.submit({ type: "input", content: "implement" }, context)).wait(context);
		await f.harness.close(context);
		registry.install({ name: "native" });
		f = await open();
		assert.ok(!(await f.conversation.agent(context)).tools.some((tool) => tool.name === retired.name));
		const recovered = await reconcileCompletion(f.storage, f.harness, f.conversation, context);
		assert.equal(recovered?.outcome, "done");
		assert.equal(recovered?.outcomeReason, undefined);
		faux.setResponses([fauxAssistantMessage("Implemented.")]);
		await (await f.conversation.submit({ type: "input", content: "go ahead" }, context)).wait(context);
		const completed = await reconcileCompletion(f.storage, f.harness, f.conversation, context);
		assert.equal(completed?.outcome, "done");
		assert.ok(completed!.outcomeAt > recovered!.outcomeAt);
	} finally {
		await harness?.close(context);
		await rm(dir, { recursive: true, force: true });
	}
});
