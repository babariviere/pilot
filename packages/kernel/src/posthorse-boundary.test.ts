import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	defineTool,
	type GenerationHooks,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	ResetEntry,
	type Storage,
	ToolResultEntry,
	type UserInput,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function open(t: TestContext, storage: Storage = new MemoryStorage()) {
	const faux = fauxProvider({ tokensPerSecond: 0, models: [{ id: "main", contextWindow: 32_000 }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const state = {
		effects: 0,
		hooks: 0,
		laterHooks: 0,
		fail: false,
		legacy: false,
		decide: true,
		fences: 0,
		canReset: (_pending: readonly UserInput[]) => true,
		prepare: async () => {},
	};
	const registry = createRegistry();
	registry.install({
		name: "posthorse-boundary",
		tools: [
			defineTool({
				name: "effect",
				description: "Count an irreversible effect",
				parameters: Type.Object({}),
				execute: async () => {
					state.effects++;
					return {
						output: [{ type: "text", text: "Effect completed" }],
						...(state.legacy ? { control: { handoff: "Legacy handoff" } } : {}),
					};
				},
			}),
			defineTool({
				name: "sibling",
				description: "Return a sibling result",
				parameters: Type.Object({}),
				execute: async () => ({ output: [{ type: "text", text: "Sibling" }], isError: state.fail }),
			}),
		],
		hooks: [
			hook(GenerationTask, {
				afterTools: async () => {
					state.hooks++;
					await state.prepare();
					return state.decide
						? {
								handoff: "Posthorse historical handoff",
								canReset: (pending: readonly UserInput[]) => {
									state.fences++;
									return state.canReset(pending);
								},
							}
						: undefined;
				},
			}),
			hook(GenerationTask, {
				afterTools: () => {
					state.laterHooks++;
					return state.decide ? { handoff: "Must not win" } : undefined;
				},
			}),
		],
	});
	const harness = await Harness.open(
		storage,
		{ models, registry, settings: { compaction: { enabled: false }, retry: { enabled: false } } },
		context,
	);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, {
		agent: { model: { provider: faux.getModel().provider, modelId: "main" } },
	});
	return { harness, conversation, faux, state };
}

type Chat = Awaited<ReturnType<typeof open>>;
const round = (sibling = false) =>
	fauxAssistantMessage([fauxToolCall("effect", {}), ...(sibling ? [fauxToolCall("sibling", {})] : [])], {
		stopReason: "toolUse",
	});
const run = async (chat: Chat, content = "Original task") =>
	(await chat.conversation.submit({ type: "input", content }, context)).wait(context);
const entries = async (chat: Chat) =>
	(await chat.conversation.entries({ order: "ascending" }, 1000, undefined, context)).items;

// Compile-time public API check, independent of the bridge implementation.
const decision: GenerationHooks["afterTools"] = () => ({ handoff: "Historical handoff" });
void decision;

test("posthorse reset preserves one effect and the active run across SQLite reopen", { timeout: 15_000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-posthorse-boundary-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "harness.sqlite");
	const first = await open(t, await openNodeSqliteStorage(file));
	first.faux.setResponses([
		round(),
		(request) => {
			assert.match(JSON.stringify(request.messages), /Posthorse historical handoff/);
			assert.doesNotMatch(JSON.stringify(request.messages), /Original task|Effect completed|Must not win/);
			return fauxAssistantMessage("Continued same run");
		},
	]);
	const result = await run(first);
	assert.equal(result.status, "done", JSON.stringify(result));
	assert.equal(first.state.effects, 1);
	assert.equal(first.faux.state.callCount, 2);
	assert.equal(first.state.hooks, 1);
	assert.equal(first.state.laterHooks, 0);
	const saved = await entries(first);
	assert.equal(saved.filter((entry) => entry.kind === ToolResultEntry.kind).length, 1);
	const resets = saved.filter((entry) => entry.kind === ResetEntry.kind);
	assert.equal(resets.length, 1);
	assert.deepEqual(resets[0]!.data, { mode: "posthorse" });
	await first.harness.close(context);
	const next = await open(t, await openNodeSqliteStorage(file));
	next.faux.setResponses([
		(request) => {
			assert.match(JSON.stringify(request.messages), /Posthorse historical handoff/);
			assert.doesNotMatch(JSON.stringify(request.messages), /Original task|Effect completed/);
			return fauxAssistantMessage("After reopen");
		},
	]);
	assert.equal((await run(next, "Continue after reopen")).status, "done");
	assert.equal(next.state.effects, 0, "a committed effect must not replay");
	assert.equal(next.state.hooks, 0);
	assert.equal((await entries(next)).filter((entry) => entry.kind === ResetEntry.kind).length, 1);
});

test("failed sibling prevents a partial posthorse reset", { timeout: 15_000 }, async (t) => {
	const chat = await open(t);
	chat.state.fail = true;
	chat.state.legacy = true;
	chat.faux.setResponses([
		round(true),
		(request) => {
			assert.match(JSON.stringify(request.messages), /Original task/);
			assert.doesNotMatch(JSON.stringify(request.messages), /Posthorse historical handoff/);
			return fauxAssistantMessage("Recover from sibling error");
		},
	]);
	assert.equal((await run(chat)).status, "done");
	assert.equal(chat.state.effects, 1);
	assert.equal(chat.state.fences, 0, "failed results must not reach the admission fence");
	assert.equal((await entries(chat)).filter((entry) => entry.kind === ResetEntry.kind).length, 0);
});

test("Stop while preparing posthorse never places a reset", { timeout: 15_000 }, async (t) => {
	const chat = await open(t);
	const started = gate();
	const finish = gate();
	t.after(finish.resolve);
	chat.state.prepare = async () => {
		started.resolve();
		await finish.promise;
	};
	chat.faux.setResponses([round()]);
	const pending = run(chat);
	await started.promise;
	const stopped = chat.conversation.abort(context);
	finish.resolve();
	await stopped;
	assert.equal((await pending).status, "unanswered");
	assert.equal(chat.state.effects, 1);
	assert.equal((await entries(chat)).filter((entry) => entry.kind === ResetEntry.kind).length, 0);
	assert.equal(chat.faux.state.callCount, 1);
});

test("queued steer follows posthorse reset and joins its existing run", { timeout: 15_000 }, async (t) => {
	const chat = await open(t);
	const started = gate();
	const finish = gate();
	t.after(finish.resolve);
	chat.state.prepare = async () => {
		started.resolve();
		await finish.promise;
	};
	chat.faux.setResponses([
		round(),
		(request) => {
			const text = JSON.stringify(request.messages);
			assert.ok(text.indexOf("Posthorse historical handoff") < text.indexOf("Queued correction"));
			assert.doesNotMatch(text, /Original task/);
			return fauxAssistantMessage("Done with correction");
		},
	]);
	const pending = run(chat);
	await started.promise;
	const steer = await chat.conversation.submit(
		{ type: "input", content: "Queued correction", whenBusy: "steer" },
		context,
	);
	finish.resolve();
	assert.equal((await pending).status, "done");
	assert.equal((await steer.wait(context)).status, "done");
	assert.equal(chat.faux.state.callCount, 2);
	assert.equal(chat.state.effects, 1);
	assert.equal((await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))?.run, undefined);
});

test("no hook decision preserves legacy tool handoff", { timeout: 15_000 }, async (t) => {
	const chat = await open(t);
	chat.state.decide = false;
	chat.state.legacy = true;
	chat.faux.setResponses([
		round(),
		(request) => {
			assert.match(JSON.stringify(request.messages), /Legacy handoff/);
			assert.doesNotMatch(JSON.stringify(request.messages), /Original task/);
			return fauxAssistantMessage("Legacy continuation");
		},
	]);
	assert.equal((await run(chat)).status, "done");
	const resets = (await entries(chat)).filter((entry) => entry.kind === ResetEntry.kind);
	assert.equal(resets.length, 1);
	assert.equal(resets[0]!.data, undefined);
	assert.equal(chat.state.laterHooks, 1);
});

test("late admission refusal preserves context without trying the next hook", { timeout: 15_000 }, async (t) => {
	const chat = await open(t);
	const started = gate();
	const finish = gate();
	t.after(finish.resolve);
	let admitted = true;
	chat.state.canReset = () => admitted;
	chat.state.prepare = async () => {
		started.resolve();
		await finish.promise;
	};
	chat.faux.setResponses([
		round(),
		(request) => {
			assert.match(JSON.stringify(request.messages), /Original task/);
			assert.doesNotMatch(JSON.stringify(request.messages), /Posthorse historical handoff|Must not win/);
			return fauxAssistantMessage("Continue original context");
		},
	]);
	const pending = run(chat);
	await started.promise;
	admitted = false;
	finish.resolve();
	assert.equal((await pending).status, "done");
	assert.equal(chat.state.fences, 1);
	assert.equal(chat.state.laterHooks, 0);
	assert.equal((await entries(chat)).filter((entry) => entry.kind === ResetEntry.kind).length, 0);
});

test("placement fence sees late queued follow-ups and image writes", { timeout: 15_000 }, async (t) => {
	const chat = await open(t);
	const started = gate();
	const finish = gate();
	t.after(finish.resolve);
	const image: UserInput = [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }];
	chat.state.prepare = async () => {
		started.resolve();
		await finish.promise;
	};
	chat.state.canReset = (pending) => {
		assert.deepEqual(pending, ["Late follow-up", image]);
		return false;
	};
	chat.faux.setResponses([round(), fauxAssistantMessage("Original answer"), fauxAssistantMessage("Follow-up answer")]);
	const pending = run(chat);
	await started.promise;
	const followUp = await chat.conversation.submit(
		{ type: "input", content: "Late follow-up", whenBusy: "followUp" },
		context,
	);
	const write = await chat.conversation.submit(
		{
			type: "write",
			entry: { kind: "test.image", model: [{ role: "user", content: image, timestamp: 1 }] },
		},
		context,
	);
	finish.resolve();
	assert.equal((await pending).status, "done");
	assert.equal((await followUp.wait(context)).status, "done");
	assert.equal((await write.wait(context)).status, "done");
	assert.equal(chat.state.fences, 1);
	assert.equal((await entries(chat)).filter((entry) => entry.kind === ResetEntry.kind).length, 0);
});

test("non-user model writes block fenced resets", { timeout: 15_000 }, async (t) => {
	const chat = await open(t);
	const started = gate();
	const finish = gate();
	t.after(finish.resolve);
	chat.state.prepare = async () => {
		started.resolve();
		await finish.promise;
	};
	chat.faux.setResponses([round(), fauxAssistantMessage("Continue with queued evidence")]);
	const pending = run(chat);
	await started.promise;
	const write = await chat.conversation.submit(
		{ type: "write", entry: { kind: "test.evidence", model: [fauxAssistantMessage("Queued evidence")] } },
		context,
	);
	finish.resolve();
	// The queued assistant answer ends the need for another provider request.
	assert.equal((await pending).status, "unanswered");
	assert.equal((await write.wait(context)).status, "done");
	assert.equal(chat.state.fences, 0);
	assert.equal((await entries(chat)).filter((entry) => entry.kind === ResetEntry.kind).length, 0);
});
