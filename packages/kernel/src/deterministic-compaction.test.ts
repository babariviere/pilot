import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	AssistantEntry,
	type Conversation,
	createRegistry,
	defineTool,
	Harness,
	LiveDoc,
	MemoryStorage,
	UserEntry,
} from "@earendil-works/pi-durable";
import { reconcileCompletion } from "./attention.ts";
import { COMPACTION_TARGETS, compactionPolicy } from "./compaction-policy.ts";
import { DIGEST_MARK, DigestCompiler } from "./context-digest.ts";
import {
	type CompactionRecord,
	compactionLine,
	DeterministicCompaction,
	deterministicCompactionEnabled,
} from "./deterministic-compaction.ts";
import { QUESTION_ENTRY } from "./question-entry.ts";

test("the policy compacts at 100k total input, earlier only for window safety, with backoff capped by safety", () => {
	const big = compactionPolicy(200_000);
	assert.deepEqual(
		{ trigger: big.trigger, safety: big.safety, keep: big.keepRecentTokens, digest: big.digestTokens },
		{ trigger: 100_000, safety: 183_616, keep: 20_000, digest: 5_000 },
	);
	assert.deepEqual(big.harness, {
		enabled: true,
		reserveTokens: 100_000,
		keepRecentTokens: 20_000,
		backgroundTokens: 0,
	});
	assert.equal(compactionPolicy(1_000_000).trigger, 100_000);
	assert.equal(compactionPolicy(128_000).trigger, 100_000);
	const small = compactionPolicy(32_000);
	assert.equal(small.trigger, 25_600);
	assert.equal(small.trigger, small.safety, "small windows compact only for window safety");
	assert.equal(small.keepRecentTokens, 6_400);
	assert.equal(small.digestTokens, 1_536);
	assert.equal(compactionPolicy(8_000).trigger, 5_952);
	assert.equal(compactionPolicy(0).harness.enabled, false);
	assert.equal(compactionPolicy(200_000, 110_000).trigger, 130_000, "backoff waits for growth");
	assert.equal(compactionPolicy(200_000, 175_000).trigger, 183_616, "backoff never passes window safety");
	assert.equal(COMPACTION_TARGETS.maxAfterRatio, 0.6);
});

test("compaction log lines are content-free", () => {
	const line = compactionLine({
		v: 1,
		source: "compaction",
		at: 1,
		regime: "target",
		outcome: "digest",
		why: "secret text",
		beforeTokens: 120_000,
		note: "password=hunter2",
		nested: { text: "x" },
	});
	assert.deepEqual(JSON.parse(line!), {
		v: 1,
		source: "compaction",
		at: 1,
		regime: "target",
		outcome: "digest",
		beforeTokens: 120_000,
	});
	assert.equal(compactionLine({ v: 1, source: "other" }), undefined);
});

type Chat = Awaited<ReturnType<typeof open>>;
async function open(t: TestContext, model = "big", targets = COMPACTION_TARGETS) {
	const faux = fauxProvider({
		tokensPerSecond: 0,
		models: [
			{ id: "big", contextWindow: 200_000 },
			{ id: "small", contextWindow: 32_000 },
		],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	let conversation: Conversation | undefined;
	// About 48 KB (about 13.8k estimated tokens): under the Harness tool-output limit of 50 KB.
	const dump = defineTool({
		name: "dump",
		description: "Print a long log",
		parameters: Type.Object({ fact: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async (args) => ({
			output: [{ type: "text", text: `${`${"log line ok ".repeat(33)}\n`.repeat(120)}${args.fact ?? ""}` }],
		}),
	});
	const ask = defineTool({
		name: "ask_user",
		description: "Ask the user",
		parameters: Type.Object({ question: Type.String() }),
		replay: "safe",
		execute: async (args, api) => {
			await conversation!.submit(
				{
					type: "write",
					requestId: `question:${api.callId}`,
					entry: { kind: QUESTION_ENTRY, data: { question: args.question, options: [] }, model: [] },
				},
				context,
			);
			return { output: [{ type: "text", text: "End your turn now." }] };
		},
	});
	const records: CompactionRecord[] = [];
	let harness: Harness | undefined;
	const state = { model };
	const compaction = new DeterministicCompaction({
		harness: () => harness,
		recall: true,
		log: { record: (r) => records.push(r) },
		targets,
	});
	registry.install(compaction.extension({ name: "native", tools: [dump, ask] }));
	const settings = Object.defineProperty({ retry: { maxRetries: 0 } }, "compaction", {
		enumerable: true,
		get: () => compaction.policy(faux.getModel(state.model)!.contextWindow, conversation?.id).harness,
	});
	harness = await Harness.open(new MemoryStorage(), { models, registry, settings }, context);
	t.after(() => harness!.close(context));
	conversation = await harness.root(context, {
		agent: { model: { provider: faux.getModel().provider, modelId: model }, extensions: [{ name: "native" }] },
	});
	return { faux, harness, conversation, records, compaction, state };
}

async function turn(chat: Chat, input: string, ...responses: Parameters<Chat["faux"]["setResponses"]>[0]) {
	chat.faux.setResponses(responses);
	return (await chat.conversation.submit({ type: "input", content: input }, context)).wait(context);
}
const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
const dumps = (count: number) => Array.from({ length: count }, () => call("dump", {}));
async function digests(chat: Chat): Promise<string[]> {
	const items = (await chat.conversation.entries({}, 1_000, undefined, context)).items.toReversed();
	return items
		.filter((item) => item.kind === "pi.compaction")
		.map((item) => (item.model![0] as Message & { content: { text: string }[] }).content[0]!.text);
}
const compactions = (chat: Chat) =>
	chat.records.filter((r): r is Extract<CompactionRecord, { source: "compaction" }> => r.source === "compaction");

test("beyond 100k total input inside a tool loop, the next request compacts to a digest without a model call", async (t) => {
	const chat = await open(t);
	let lastRequestChars = 0;
	const settled = await turn(
		chat,
		"Investigate the export failure. Always use pnpm, never npm.",
		...dumps(7),
		call("dump", { fact: "migration checksum ab12 applied to ledger_db" }),
		(ctx) => {
			lastRequestChars = JSON.stringify(ctx.messages).length;
			return fauxAssistantMessage("Found it.");
		},
	);
	assert.equal(settled.status, "done");
	assert.equal(chat.faux.getPendingResponseCount(), 0, "no summarization request consumed a response");
	const [summary] = await digests(chat);
	assert.ok(summary?.includes(DIGEST_MARK), summary);
	assert.match(summary!, /Always use pnpm, never npm\./);
	assert.ok(lastRequestChars < 200_000, `compacted request: ${lastRequestChars} chars`);
	const [record] = compactions(chat);
	assert.equal(record?.regime, "target");
	assert.equal(record?.outcome, "digest");
	assert.ok(
		record!.beforeTokens > 100_000 && record!.afterTokens! < record!.beforeTokens * 0.6,
		JSON.stringify(record),
	);
	assert.ok(record!.digestTokens! <= 5_500);
	const usage = chat.records.find((r) => r.source === "compaction_usage");
	assert.ok(usage && usage.source === "compaction_usage" && usage.actualTokens > 0 && usage.estimatedTokens > 0);
	assert.equal((await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))?.compactionFailure, undefined);
});

test("a smaller window after a model switch compacts earlier, for window safety only", async (t) => {
	const chat = await open(t);
	await turn(chat, "Read the large report.", ...dumps(3), fauxAssistantMessage("done"));
	await turn(chat, "Thanks, keep going.", fauxAssistantMessage("ok"));
	assert.equal(compactions(chat).length, 0, "about 42k tokens stays below the 100k target on a 200k window");
	await chat.conversation.configure({ model: { provider: chat.faux.getModel().provider, modelId: "small" } }, context);
	chat.state.model = "small";
	assert.equal((await turn(chat, "Continue on the small model.", fauxAssistantMessage("continuing"))).status, "done");
	const [record] = compactions(chat);
	assert.equal(record?.regime, "window");
	assert.equal(record?.outcome, "digest");
	assert.equal(record?.window, 32_000);
	assert.equal(record?.trigger, 25_600);
	assert.ok(record!.afterTokens! < 25_600, JSON.stringify(record));
	assert.match((await digests(chat))[0]!, /Read the large report\./);
});

test("repeated cycles rebuild each digest from the original entries and keep the first goal", async (t) => {
	const chat = await open(t);
	await turn(
		chat,
		"Goal: migrate the ledger to tenant scoping. Always run pnpm typecheck.",
		...dumps(4),
		fauxAssistantMessage("step 1"),
	);
	for (let cycle = 2; cycle <= 5; cycle++)
		await turn(chat, `Continue with step ${cycle}.`, ...dumps(6), fauxAssistantMessage(`step ${cycle}`));
	const all = await digests(chat);
	assert.ok(all.length >= 3, `${all.length} compactions`);
	for (const summary of all) {
		assert.match(summary, /## Goal \(first request\)\n- #\d+ Goal: migrate the ledger to tenant scoping\./);
		assert.match(summary, /Always run pnpm typecheck\./);
		assert.equal(summary.split(DIGEST_MARK).length, 2, "a digest never nests an earlier digest");
	}
	const records = compactions(chat).filter((r) => r.outcome === "digest");
	assert.ok(
		records.slice(1).every((r) => r.folded! <= 30),
		`later cycles fold only new entries: ${records.map((r) => r.folded)}`,
	);
});

test("an open question survives compaction in the digest and stays pending in Pilot's state", async (t) => {
	// A short verbatim tail, so the question itself is compacted.
	const chat = await open(t, "big", { ...COMPACTION_TARGETS, keepRecentTokens: 1_000 });
	await turn(chat, "Implement storage for the export.", ...dumps(3), fauxAssistantMessage("read it"));
	await turn(
		chat,
		"Pick a database.",
		call("ask_user", { question: "Which database?" }),
		call("dump", {}),
		fauxAssistantMessage("Waiting for your choice."),
	);
	await chat.harness.waitForTask(await chat.conversation.compact(undefined, context), context);
	const [summary] = await digests(chat);
	assert.match(summary!, /## Questions\n- #\d+ assistant asked, no reply before #\d+: Which database\?/);
	const storage = (chat.harness as unknown as { storage: never }).storage;
	const completion = await reconcileCompletion(storage, chat.harness, chat.conversation, context);
	assert.equal(completion?.outcome, "question");
	assert.equal(completion?.outcomeReason, "Which database?");
});

test("a target compaction that would not shrink enough is declined with backoff; the request proceeds", async (t) => {
	const chat = await open(t);
	// One assistant message with eight calls: the cut cannot separate its results, so little would be saved.
	const parallel = fauxAssistantMessage(
		Array.from({ length: 8 }, (_, index) => fauxToolCall("dump", {}, { id: `parallel-${index}` })),
		{ stopReason: "toolUse" },
	);
	const settled = await turn(chat, "Dump everything at once.", parallel, fauxAssistantMessage("done"));
	assert.equal(settled.status, "done");
	const records = compactions(chat);
	assert.equal(records.length, 1, "the next boundary waits for growth instead of retrying");
	assert.equal(records[0]!.outcome, "declined");
	assert.equal(records[0]!.why, "insufficient_reduction");
	assert.deepEqual(await digests(chat), []);
	const trigger = chat.compaction.policy(200_000, chat.conversation.id).trigger;
	assert.equal(trigger, Math.min(records[0]!.beforeTokens + 20_000, 183_616));
});

test("an unusable digest falls back to the model summary when compaction is required", async (t) => {
	const chat = await open(t);
	await turn(chat, "Read the logs.", ...dumps(3), fauxAssistantMessage("read"));
	t.mock.method(DigestCompiler.prototype, "fold", () => Promise.reject(new Error("fold failed")));
	chat.faux.setResponses([fauxAssistantMessage("## Goal\nModel fallback summary")]);
	await chat.harness.waitForTask(await chat.conversation.compact(undefined, context), context);
	assert.match((await digests(chat))[0]!, /Model fallback summary/);
	assert.deepEqual(
		compactions(chat).map((r) => [r.regime, r.outcome, r.why]),
		[["manual", "model", "error"]],
	);
});

test("manual compaction with explicit instructions uses the model unless its summary already failed", async (t) => {
	const chat = await open(t);
	await turn(chat, "Read the logs.", ...dumps(3), fauxAssistantMessage("read"));
	chat.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "context_length_exceeded" })]);
	await chat.harness.waitForTask(await chat.conversation.compact("focus on the auth code", context), context);
	assert.deepEqual(await digests(chat), []);
	assert.ok((await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))?.compactionFailure);
	await chat.harness.waitForTask(await chat.conversation.compact("focus on the auth code", context), context);
	const [summary] = await digests(chat);
	assert.match(summary!, /\[Pilot context digest\]/);
	assert.deepEqual(
		compactions(chat).map((r) => [r.outcome, r.why ?? null, !!r.priorFailure]),
		[
			["model", "instructions", false],
			["digest", null, true],
		],
	);
});

test("budgets scale by the chat's measured provider-to-estimate ratio, never by a fixed constant", () => {
	const compaction = new DeterministicCompaction({ harness: () => undefined, recall: false });
	assert.deepEqual(
		[
			compaction.ratio("c"),
			compaction.policy(1_000_000, "c").keepRecentTokens,
			compaction.policy(1_000_000, "c").digestTokens,
		],
		[1, 20_000, 5_000],
	);
	compaction.calibrate("c", 166_000, 100_000);
	assert.equal(compaction.ratio("c"), 1.66);
	assert.deepEqual(
		[compaction.policy(1_000_000, "c").keepRecentTokens, compaction.policy(1_000_000, "c").digestTokens],
		[12_048, 3_012],
	);
	assert.equal(
		compaction.policy(1_000_000, "c").trigger,
		100_000,
		"the trigger stays in provider-measured total input",
	);
	compaction.calibrate("c", 900_000, 100_000);
	assert.equal(compaction.ratio("c"), 2.5, "clamped");
	compaction.calibrate("d", 50, 100_000);
	assert.equal(compaction.ratio("d"), 1, "never shrinks budgets below their nominal size");
	compaction.calibrate("e", 5_000, 500);
	assert.equal(compaction.ratio("e"), 1, "too small a sample is ignored");
	assert.equal(compaction.ratio("other"), 1);
});

test("a provider-measured boundary in a code-heavy chat compacts instead of declining: before and after share one unit", async (t) => {
	const chat = await open(t);
	const id = chat.conversation.id;
	const big = "const value = compute(item); // ".repeat(1_500);
	const messages: Message[] = [{ role: "user", content: "Refactor the ledger.", timestamp: 1 }];
	for (let i = 0; i < 5; i++) messages.push(fauxAssistantMessage(big));
	// Providers count about 1.6 tokens per character-estimated token for code like this.
	const provider = Math.round(1.6 * messages.reduce((total, message) => total + estimateMessageTokens(message), 0));
	const last = messages.at(-1) as Message & { usage: object };
	messages[messages.length - 1] = {
		...last,
		usage: {
			input: provider,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: provider,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as Message;
	await chat.conversation.commit(async (tx) => {
		for (const message of messages)
			await tx.appendEntry(id, {
				kind: message.role === "user" ? UserEntry.kind : AssistantEntry.kind,
				model: [message],
			});
	}, context);
	assert.ok(provider > 100_000 && provider < 120_000, String(provider));
	assert.equal((await turn(chat, "Continue.", fauxAssistantMessage("ok"))).status, "done");
	const [record] = compactions(chat);
	assert.equal(record?.regime, "target");
	assert.equal(record?.outcome, "digest", JSON.stringify(record));
	assert.ok(Math.abs(record!.providerTokensPerEstimate - 1.6) < 0.05, String(record!.providerTokensPerEstimate));
	assert.ok(record!.afterTokens! < record!.beforeTokens * 0.6, JSON.stringify(record));
});

test("deterministic compaction stays opt-in until validated", () => {
	assert.equal(deterministicCompactionEnabled({}), false);
	assert.equal(deterministicCompactionEnabled({ PILOT_DETERMINISTIC_COMPACTION: "0" }), false);
	assert.equal(deterministicCompactionEnabled({ PILOT_DETERMINISTIC_COMPACTION: "1" }), true);
});
