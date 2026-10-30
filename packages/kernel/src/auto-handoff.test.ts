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
	type Message,
	Type,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
	AssistantEntry,
	CompactionTask,
	type Conversation,
	createRegistry,
	defineTool,
	Harness,
	hook,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	ResetEntry,
	type Storage,
	ToolResultEntry,
	UsageDoc,
	UserEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AutoHandoff, AutoHandoffDoc, autoHandoffPolicy, handoffSource } from "./auto-handoff.ts";
import { DeterministicCompaction } from "./deterministic-compaction.ts";
import { searchHistory } from "./history-recall.ts";

type Chat = Awaited<ReturnType<typeof open>>;
function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function open(t: TestContext, storage: Storage = new MemoryStorage(), digest = false, window = 32_000) {
	const faux = fauxProvider({ tokensPerSecond: 0, models: [{ id: "main", contextWindow: window, maxTokens: 8192 }] });
	const models = createModels();
	models.setProvider(faux.provider);
	let harness: Harness | undefined;
	let conversation: Conversation | undefined;
	const state = {
		enabled: true,
		coordinator: false,
		effects: 0,
		imageEffect: false,
		manual: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
	};
	const auto = new AutoHandoff({
		harness: () => harness,
		enabled: () => state.enabled,
		eligible: (id) => id === conversation?.id && !state.coordinator,
		manualPolicy: () => state.manual,
	});
	const deterministic = new DeterministicCompaction({ harness: () => harness, recall: true });
	const effect = defineTool({
		name: "effect",
		description: "Record a synthetic irreversible effect",
		parameters: Type.Object({}),
		execute: async () => {
			state.effects++;
			if (state.imageEffect)
				return {
					output: [
						{ type: "image", mimeType: "image/png", data: Buffer.from("TOOL_IMAGE_PIXELS").toString("base64") },
					],
				};
			return { output: [{ type: "text", text: "Effect completed once" }] };
		},
	});
	const registry = createRegistry();
	const extension = auto.extension({ name: "native", tools: [effect] });
	registry.install(digest ? deterministic.extension(extension) : extension);
	const settings = Object.defineProperty({ retry: { enabled: false } }, "compaction", {
		enumerable: true,
		configurable: true,
		get: () =>
			auto.policy(window, conversation?.id) ?? {
				enabled: false,
				reserveTokens: 2048,
				keepRecentTokens: 1000,
				backgroundTokens: 0,
			},
	});
	harness = await Harness.open(storage, { models, registry, settings }, context);
	t.after(() => harness!.close(context));
	conversation = await harness.root(context, {
		agent: { model: { provider: faux.getModel().provider, modelId: "main" } },
	});
	return { faux, models, registry, harness, conversation, state, auto, settings };
}

async function seed(chat: Chat, reportedTokens = 25_000) {
	await chat.conversation.commit(async (tx) => {
		await tx.appendEntry(UserEntry, chat.conversation.id, {
			model: [{ role: "user", content: "ORIGINAL_ONLY_CANARY. Fix the export. Do not push.", timestamp: 1 }],
		});
		const message = fauxAssistantMessage(`Old answer. ${"Historical inspection log. ".repeat(100)}`);
		message.usage = { ...message.usage, input: reportedTokens, totalTokens: reportedTokens };
		await tx.appendEntry(AssistantEntry, chat.conversation.id, { model: [message] });
	}, context);
}
const run = async (chat: Chat, text: UserMessage["content"] = "Continue the unfinished export task") =>
	(await chat.conversation.submit({ type: "input", content: text }, context)).wait(context);
const entries = async (chat: Chat) =>
	(await chat.conversation.entries({ order: "ascending" }, 1000, undefined, context)).items;
const handoff = () =>
	fauxAssistantMessage("Handoff: continue the export without pushing. The old check is unverified. #1");

test("handoff trigger is 100k or 70% of the window, with no background or unknown-window work", () => {
	assert.equal(200_000 - autoHandoffPolicy(200_000).reserveTokens, 100_000);
	assert.equal(32_000 - autoHandoffPolicy(32_000).reserveTokens, 22_400);
	assert.equal(8_000 - autoHandoffPolicy(8_000).reserveTokens, 5_600);
	assert.equal(autoHandoffPolicy(32_000).backgroundTokens, 0);
	assert.equal(autoHandoffPolicy(0).enabled, false);
	assert.equal(autoHandoffPolicy(Number.NaN).enabled, false);
});

test("threshold handoff replaces processed history but carries unconsumed input in the same run", async (t) => {
	const chat = await open(t);
	await seed(chat);
	const id = chat.conversation.id;
	chat.faux.setResponses([
		(source, options) => {
			assert.match(JSON.stringify(source.messages), /Prepare a handoff/);
			assert.match(JSON.stringify(source.messages), /ORIGINAL_ONLY_CANARY/);
			assert.doesNotMatch(JSON.stringify(source.messages), /Continue the unfinished export task/);
			assert.equal(getCurrentTools(source.messages).length, 0, "handoff writer has no tools");
			assert.equal(options?.maxRetries, 0);
			return handoff();
		},
		(request) => {
			assert.match(JSON.stringify(request.messages), /\[Pilot handoff\]/);
			assert.doesNotMatch(JSON.stringify(request.messages), /ORIGINAL_ONLY_CANARY|Old answer/);
			assert.match(JSON.stringify(request.messages), /Continue the unfinished export task/);
			return fauxAssistantMessage("Continued safely");
		},
	]);
	assert.equal((await run(chat)).status, "done");
	assert.equal(chat.conversation.id, id);
	const saved = await entries(chat);
	assert.ok(saved.some((entry) => JSON.stringify(entry.model).includes("ORIGINAL_ONLY_CANARY")));
	const marker = saved.find((entry) => entry.kind === "pi.compaction")!;
	assert.equal(
		marker.head,
		saved.find(
			(entry) => entry.kind === "pi.user" && entry.model?.[0]?.content === "Continue the unfinished export task",
		)!.id,
	);
	assert.equal((marker.data as { mode: string }).mode, "handoff");
	assert.equal(chat.faux.state.callCount, 2);
	assert.ok(Object.keys((await chat.harness.snapshot(UsageDoc, id, context))!.models).length);
	const recalled = await searchHistory(chat.conversation, { query: "ORIGINAL_ONLY_CANARY" }, context);
	assert.ok(JSON.stringify(recalled).includes("ORIGINAL_ONLY_CANARY"));
});

for (const boundary of ["threshold", "overflow"] as const)
	test(`unconsumed image input survives ${boundary} handoff verbatim`, async (t) => {
		const chat = await open(t);
		await seed(chat, boundary === "overflow" ? 0 : 25_000);
		const content: UserMessage["content"] = [
			{ type: "text", text: "CURRENT_IMAGE_REQUEST: identify these pixels" },
			{ type: "image", mimeType: "image/png", data: Buffer.from("pixel canary").toString("base64") },
		];
		chat.faux.setResponses([
			...(boundary === "overflow"
				? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" })]
				: []),
			(source) => {
				assert.doesNotMatch(JSON.stringify(source.messages), /CURRENT_IMAGE_REQUEST/);
				return handoff();
			},
			(request) => {
				assert.deepEqual(request.messages.filter((m) => m.role === "user").at(-1)!.content, content);
				return fauxAssistantMessage("Image received");
			},
		]);
		assert.equal((await run(chat, content)).status, "done");
		const marker = (await entries(chat)).find((entry) => entry.kind === "pi.compaction")!;
		assert.deepEqual((await entries(chat)).find((entry) => entry.id === marker.head)?.model?.[0]?.content, content);
	});

test("an oversized unconsumed request fails before dispatch rather than silently dropping input", async (t) => {
	const chat = await open(t);
	await seed(chat);
	assert.equal((await run(chat, "PENDING_BIG_REQUEST ".repeat(12_000))).status, "unanswered");
	assert.equal(chat.faux.state.callCount, 0);
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
});

test("retained current input keeps its canonical context-edit target after handoff", async (t) => {
	const chat = await open(t);
	await seed(chat);
	chat.faux.setResponses([handoff(), fauxAssistantMessage("First response")]);
	assert.equal((await run(chat, "ORIGINAL_CURRENT_INPUT")).status, "done");
	const marker = (await entries(chat)).find((entry) => entry.kind === "pi.compaction")!;
	await chat.conversation.commit(async (tx) => {
		await tx.appendEntry(chat.conversation.id, {
			kind: "fixture.context-edit",
			edits: [
				{
					target: marker.head!,
					action: "replace",
					messages: [{ role: "user", content: "EDITED_CURRENT_INPUT", timestamp: 1 }],
				},
			],
		});
	}, context);
	chat.faux.setResponses([
		(request) => {
			assert.match(JSON.stringify(request.messages), /EDITED_CURRENT_INPUT/);
			assert.doesNotMatch(JSON.stringify(request.messages), /ORIGINAL_CURRENT_INPUT/);
			return fauxAssistantMessage("Edited input observed");
		},
	]);
	assert.equal((await run(chat, "Next request")).status, "done");
});

test("a reset head carrying unconsumed instructions is refused rather than silently excluded", async (t) => {
	const chat = await open(t);
	await chat.conversation.commit(async (tx) => {
		await tx.appendEntry(ResetEntry, chat.conversation.id, {
			head: "self",
			model: [
				{
					role: "user",
					content: `RESET_LITERAL_CANARY ${"unconsumed reset instruction ".repeat(100)}`,
					timestamp: 1,
				},
			],
		});
		await tx.appendEntry(UserEntry, chat.conversation.id, {
			model: [{ role: "user", content: "Another unconsumed user input ".repeat(100), timestamp: 1 }],
		});
	}, context);
	chat.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
		handoff(),
	]);
	assert.equal(
		(
			await run(chat, [
				{ type: "image", mimeType: "image/png", data: Buffer.from("reset current pixels").toString("base64") },
			])
		).status,
		"unanswered",
	);
	assert.equal(chat.faux.state.callCount, 2);
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
	assert.match(JSON.stringify((await chat.conversation.context(context)).messages), /RESET_LITERAL_CANARY/);
});

for (const image of [false, true])
	test(`a successful tool round consumes its user input, preserving unseen images=${image}`, async (t) => {
		const chat = await open(t);
		chat.state.imageEffect = image;
		await seed(chat, 0);
		chat.faux.setResponses([
			() => {
				// Force a boundary after this first native tool round, without a large synthetic model payload.
				Object.defineProperty(chat.settings, "compaction", {
					value: { ...chat.auto.policy(32_000, chat.conversation.id), reserveTokens: 31_500 },
				});
				return fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" });
			},
			handoff(),
			(request) => {
				assert.doesNotMatch(JSON.stringify(request.messages), /EXECUTE_THIS_EFFECT_ONCE/);
				assert.equal(
					request.messages.some(
						(message) =>
							message.role === "toolResult" &&
							message.content.some(
								(block) =>
									block.type === "image" && block.data === Buffer.from("TOOL_IMAGE_PIXELS").toString("base64"),
							),
					),
					image,
				);
				return fauxAssistantMessage("The effect is already done");
			},
		]);
		assert.equal((await run(chat, "EXECUTE_THIS_EFFECT_ONCE")).status, "done");
		assert.equal(chat.state.effects, 1);
		const marker = (await entries(chat)).find((entry) => entry.kind === "pi.compaction");
		assert.ok(marker);
		assert.equal(marker.model?.length, 1);
		assert.equal(
			(await entries(chat)).find((entry) => entry.id === marker.head)?.kind,
			image ? "pi.assistant" : "pi.compaction",
		);
	});

for (const condition of ["disabled", "coordinator"] as const)
	test(`${condition} leaves the ordinary model context untouched`, async (t) => {
		const chat = await open(t);
		await seed(chat);
		if (condition === "disabled") chat.state.enabled = false;
		else chat.state.coordinator = true;
		chat.faux.setResponses([
			(request) => {
				assert.match(JSON.stringify(request.messages), /ORIGINAL_ONLY_CANARY/);
				return fauxAssistantMessage("Normal answer");
			},
		]);
		assert.equal((await run(chat)).status, "done");
		assert.equal(chat.faux.state.callCount, 1);
		assert.equal(
			(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
			false,
		);
	});

test("handoff takes precedence over the opt-in deterministic digest", async (t) => {
	const chat = await open(t, new MemoryStorage(), true);
	await seed(chat);
	chat.faux.setResponses([handoff(), fauxAssistantMessage("Done")]);
	assert.equal((await run(chat)).status, "done");
	assert.equal(chat.faux.state.callCount, 2);
	assert.match(JSON.stringify((await entries(chat)).find((entry) => entry.kind === "pi.compaction")), /Pilot handoff/);
});

test("a provider context overflow uses a full handoff and retries the pending request once", async (t) => {
	const chat = await open(t);
	await seed(chat, 0);
	chat.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
		handoff(),
		fauxAssistantMessage("Recovered pending request"),
	]);
	assert.equal((await run(chat)).status, "done");
	assert.equal(chat.faux.state.callCount, 3);
	const marker = (await entries(chat)).find((entry) => entry.kind === "pi.compaction")!;
	assert.equal((await entries(chat)).find((entry) => entry.id === marker.head)?.kind, "pi.user");
	assert.deepEqual(marker.data, { reason: "overflow", mode: "handoff" });
});

test("four successive handoffs retain one conversation and every original history entry", async (t) => {
	const chat = await open(t),
		id = chat.conversation.id;
	for (let round = 1; round <= 4; round++) {
		await seed(chat);
		chat.faux.setResponses([
			(source) => {
				if (round > 1) assert.match(JSON.stringify(source.messages), new RegExp(`HANDOFF_ROUND_${round - 1}`));
				return fauxAssistantMessage(`HANDOFF_ROUND_${round}. Continue the task without pushing.`);
			},
			(request) => {
				assert.match(JSON.stringify(request.messages), new RegExp(`HANDOFF_ROUND_${round}`));
				if (round > 1)
					assert.doesNotMatch(JSON.stringify(request.messages), new RegExp(`HANDOFF_ROUND_${round - 1}`));
				return fauxAssistantMessage(`Continuation ${round}`);
			},
		]);
		assert.equal((await run(chat)).status, "done");
		assert.equal(chat.conversation.id, id);
	}
	const all = await entries(chat);
	assert.equal(all.filter((entry) => entry.kind === "pi.compaction").length, 4);
	assert.equal(all.filter((entry) => JSON.stringify(entry.model).includes("ORIGINAL_ONLY_CANARY")).length, 4);
});

for (const mode of ["steer", "followUp"] as const)
	test(`input arriving during handoff survives as ${mode}`, async (t) => {
		const chat = await open(t);
		await seed(chat);
		const entered = deferred<void>(),
			release = deferred<void>();
		t.after(() => release.resolve());
		let sawArrival = false;
		chat.faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return handoff();
			},
			() => fauxAssistantMessage("Initial continuation"),
			(request) => {
				sawArrival = JSON.stringify(request.messages).includes("NEW_ARRIVAL_CANARY");
				return fauxAssistantMessage("Received new message");
			},
		]);
		const first = run(chat);
		await entered.promise;
		const arrival = await chat.conversation.submit(
			{ type: "input", content: "NEW_ARRIVAL_CANARY", whenBusy: mode },
			context,
		);
		assert.equal((await chat.harness.snapshot(InboxDoc, chat.conversation.id, context))!.items.length, 1);
		release.resolve();
		await first;
		assert.equal((await arrival.wait(context)).status, "done");
		assert.equal(sawArrival, true);
		const all = await entries(chat);
		assert.ok(
			all.findIndex((entry) => entry.kind === "pi.compaction") <
				all.findIndex((entry) => JSON.stringify(entry.model).includes("NEW_ARRIVAL_CANARY")),
		);
	});

for (const failure of [
	"empty",
	"length",
	"tool",
	"oversized",
	"provider-error",
	"sanitizer-empty",
	"raw-limit",
	"throw",
] as const)
	test(`invalid handoff ${failure} preserves context and fails without native fallback`, async (t) => {
		const chat = await open(t);
		await seed(chat);
		const originalEntries = await entries(chat);
		const response = () => {
			if (failure === "throw") throw new Error("Simulated lost model acknowledgement");
			if (failure === "empty") return fauxAssistantMessage("");
			if (failure === "sanitizer-empty") return fauxAssistantMessage("\u200b\u0000\u2060");
			if (failure === "raw-limit") return fauxAssistantMessage("x".repeat(256_001));
			if (failure === "length") return fauxAssistantMessage("Partial handoff", { stopReason: "length" });
			if (failure === "tool") return fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" });
			if (failure === "oversized") return fauxAssistantMessage("🦀".repeat(1025));
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider failed" });
		};
		chat.faux.setResponses([response, ...(failure === "oversized" ? [response] : [])]);
		assert.equal((await run(chat)).status, "unanswered");
		assert.equal(chat.faux.state.callCount, failure === "oversized" ? 2 : 1);
		assert.equal(chat.state.effects, 0);
		assert.equal(
			(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
			false,
		);
		assert.match(JSON.stringify((await chat.conversation.context(context)).messages), /ORIGINAL_ONLY_CANARY/);
		assert.deepEqual((await entries(chat)).slice(0, originalEntries.length), originalEntries);
		assert.match(
			(await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))!.compactionFailure!.error,
			/handoff/i,
		);
		const error = (await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))!.compactionFailure!.error;
		if (failure === "oversized") assert.match(error, /4096-byte limit \(4100 bytes\)/);
		if (failure === "length") assert.match(error, /output-token limit/);
		if (failure === "provider-error") assert.match(error, /model request failed/);
		const saved = (await chat.harness.snapshot(AutoHandoffDoc, chat.conversation.id, context))!.last!;
		{
			const reason = {
				empty: "empty",
				length: "output_tokens",
				tool: "incomplete",
				oversized: "byte_limit",
				"provider-error": "provider_error",
				"sanitizer-empty": "empty",
				"raw-limit": "raw_limit",
				throw: "provider_error",
			}[failure];
			assert.equal(saved.diagnostic?.phase, "validation");
			assert.equal(saved.diagnostic?.reason, reason);
			assert.equal(saved.diagnostic?.attempt, failure === "oversized" ? 2 : 1);
			if (failure !== "throw")
				assert.equal(
					saved.diagnostic?.rawBytes,
					failure === "oversized"
						? 4100
						: Buffer.byteLength(
								response()
									.content.filter((block) => block.type === "text")
									.map((block) => block.text)
									.join("\n")
									.trim(),
							),
				);
			assert.doesNotMatch(JSON.stringify(saved), /Provider failed|Partial handoff/);
		}
	});

for (const failure of ["transport", "malformed"] as const)
	test(`unconfirmed handoff ${failure} records its phase without replay`, async (t) => {
		const chat = await open(t);
		await seed(chat);
		const complete = t.mock.method(chat.models, "completeSimple", async () => {
			if (failure === "transport") throw new Error("PRIVATE_PROVIDER_ERROR_CANARY");
			return { ...handoff(), content: null } as never;
		});
		assert.equal((await run(chat)).status, "unanswered");
		assert.equal(complete.mock.callCount(), 1);
		const saved = (await chat.harness.snapshot(AutoHandoffDoc, chat.conversation.id, context))!.last!;
		assert.equal(saved.result.kind, "pending");
		assert.deepEqual(saved.diagnostic, { phase: "writer", attempt: 1 });
		const error = (await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))!.compactionFailure!.error;
		assert.match(error, failure === "transport" ? /during writer request/ : /during validation/);
		assert.doesNotMatch(error + JSON.stringify(saved), /PRIVATE_PROVIDER_ERROR_CANARY/);
		assert.equal(
			(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
			false,
		);
		assert.match(JSON.stringify((await chat.conversation.context(context)).messages), /ORIGINAL_ONLY_CANARY/);
	});

test("a non-idempotent sanitizer still refuses replacement with a precise rejection", async (t) => {
	// A synthetic environment value colliding with the redaction marker makes a second pass differ.
	const key = "HANDOFF_FIXTURE_SECRET";
	const previous = process.env[key];
	process.env[key] = "redacted";
	t.after(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});
	const chat = await open(t);
	await seed(chat);
	chat.faux.setResponses([fauxAssistantMessage("Continue. api_key=SYNTHETIC_PRIVATE_CANARY")]);
	assert.equal((await run(chat)).status, "unanswered");
	assert.equal(chat.faux.state.callCount, 1);
	const saved = (await chat.harness.snapshot(AutoHandoffDoc, chat.conversation.id, context))!.last!;
	assert.equal(saved.diagnostic?.reason, "sanitizer");
	assert.equal(saved.result.kind, "failed");
	assert.doesNotMatch(JSON.stringify(saved), /SYNTHETIC_PRIVATE_CANARY/);
	assert.match(
		(await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))!.compactionFailure!.error,
		/could not be sanitized safely/,
	);
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
});

test("a returned model identity mismatch fails without a rewrite", async (t) => {
	const chat = await open(t);
	await seed(chat);
	const complete = t.mock.method(chat.models, "completeSimple", async () => ({
		...handoff(),
		provider: chat.faux.getModel().provider,
		model: "different-model",
	}));
	assert.equal((await run(chat)).status, "unanswered");
	assert.equal(complete.mock.callCount(), 1);
	assert.match(
		(await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))!.compactionFailure!.error,
		/different model identity/,
	);
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
});

test("malformed provider stop categories cannot leak into durable diagnostics", async (t) => {
	const chat = await open(t);
	await seed(chat);
	t.mock.method(
		chat.models,
		"completeSimple",
		async () => ({ ...handoff(), stopReason: "PRIVATE_STOP_REASON_CANARY" }) as never,
	);
	assert.equal((await run(chat)).status, "unanswered");
	const saved = (await chat.harness.snapshot(AutoHandoffDoc, chat.conversation.id, context))!.last!;
	assert.equal(saved.diagnostic?.stopReason, "other");
	assert.equal(saved.diagnostic?.reason, "incomplete");
	assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_STOP_REASON_CANARY/);
});

test("the exact UTF-8 byte ceiling accepts complete Unicode text without a rewrite", async (t) => {
	const chat = await open(t);
	await seed(chat);
	chat.faux.setResponses([fauxAssistantMessage("🦀".repeat(1024)), fauxAssistantMessage("Continued")]);
	assert.equal((await run(chat)).status, "done");
	assert.equal(chat.faux.state.callCount, 2);
	const saved = (await chat.harness.snapshot(AutoHandoffDoc, chat.conversation.id, context))!.last!;
	assert.equal(saved.diagnostic?.sanitizedBytes, 4096);
	assert.equal(saved.diagnostic?.reason, "accepted");
});

test("a completed oversized handoff is rewritten once without clipping or repeating source tools", async (t) => {
	const chat = await open(t);
	await seed(chat);
	const modelKey = `${chat.faux.getModel().provider}/main`;
	const beforeOutput =
		(await chat.harness.snapshot(UsageDoc, chat.conversation.id, context))!.models[modelKey]?.output ?? 0;
	const complete = chat.models.completeSimple.bind(chat.models);
	let writerOutput = 0;
	t.mock.method(chat.models, "completeSimple", async (...args: Parameters<typeof complete>) => {
		const answer = await complete(...args);
		writerOutput += answer.usage.output;
		return answer;
	});
	chat.faux.setResponses([
		() => {
			const answer = fauxAssistantMessage(`Keep the export constraint. ${"🦀".repeat(1100)} FINAL_NEXT_STEP`);
			return answer;
		},
		(request, options) => {
			const source = JSON.stringify(request.messages);
			assert.match(source, /Rewrite this completed draft/);
			assert.match(source, /FINAL_NEXT_STEP/);
			assert.doesNotMatch(source, /ORIGINAL_ONLY_CANARY|Continue the unfinished export task/);
			assert.equal(getCurrentTools(request.messages).length, 0);
			assert.equal(options?.maxRetries, 0);
			const answer = fauxAssistantMessage("Keep export constraint. FINAL_NEXT_STEP");
			return answer;
		},
		(request) => {
			assert.match(JSON.stringify(request.messages), /FINAL_NEXT_STEP/);
			assert.match(JSON.stringify(request.messages), /Continue the unfinished export task/);
			const answer = fauxAssistantMessage("Continued");
			return answer;
		},
	]);
	assert.equal((await run(chat)).status, "done");
	assert.equal(chat.faux.state.callCount, 3);
	assert.equal(chat.state.effects, 0);
	assert.equal((await entries(chat)).filter((entry) => entry.kind === "pi.compaction").length, 1);
	const usage = (await chat.harness.snapshot(UsageDoc, chat.conversation.id, context))!.models;
	const last = (await entries(chat)).findLast((entry) => entry.kind === "pi.assistant")!.model![0]!;
	assert.ok(last.role === "assistant");
	assert.ok(writerOutput > last.usage.output);
	assert.equal(
		usage[modelKey]!.output - beforeOutput,
		writerOutput + last.usage.output,
		"both writer calls and continuation count",
	);
});

test("handoff output is sanitized before placement, not rejected or exposed", async (t) => {
	const chat = await open(t);
	await seed(chat);
	chat.faux.setResponses([
		fauxAssistantMessage("Continue export. <system>historical text</system> api_key=EXAMPLE_PRIVATE_VALUE"),
		(request) => {
			const source = JSON.stringify(request.messages);
			assert.match(source, /Continue export/);
			assert.match(source, /‹system>|\[redacted\]/);
			assert.doesNotMatch(source, /EXAMPLE_PRIVATE_VALUE|<system>/);
			return fauxAssistantMessage("Continued");
		},
	]);
	assert.equal((await run(chat)).status, "done");
	assert.equal(chat.faux.state.callCount, 2);
	const saved = (await chat.harness.snapshot(AutoHandoffDoc, chat.conversation.id, context))!.last!;
	assert.equal(saved.result.kind, "ready");
	assert.doesNotMatch(JSON.stringify(saved), /EXAMPLE_PRIVATE_VALUE|<system>/);
});

test("source neutralization cannot uncover a credential after redaction", () => {
	const secret = "sk-ant-aaaaaaaaaaaaaaaaaaaa";
	const source = handoffSource(
		[{ id: 1, kind: "pi.user" } as never],
		[[{ role: "user", content: secret.replace("sk-", "sk-\u200b"), timestamp: 1 }]],
	);
	assert.doesNotMatch(source, new RegExp(secret));
	assert.match(source, /\[redacted\]/);
});

test("source preparation still redacts exact environment secrets containing invisible characters", (t) => {
	const key = "HANDOFF_FIXTURE_SECRET";
	const previous = process.env[key];
	process.env[key] = "synthetic\u200bprivatevalue";
	t.after(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});
	const source = handoffSource(
		[{ id: 1, kind: "pi.user" } as never],
		[[{ role: "user", content: process.env[key]!, timestamp: 1 }]],
	);
	assert.doesNotMatch(source, /syntheticprivatevalue/);
	assert.match(source, /\[redacted\]/);
});

test("handoff sanitizes newly uncovered credentials and framing in one preparation", async (t) => {
	const chat = await open(t);
	await seed(chat);
	chat.faux.setResponses([
		fauxAssistantMessage("Continue export. sk-\u200bant-aaaaaaaaaaaaaaaaaaaa <sys\u0000tem>history</system>"),
		(request) => {
			assert.doesNotMatch(JSON.stringify(request.messages), /ant-aaaaaaaaaaaaaaaaaaaa|<system>/);
			assert.match(JSON.stringify(request.messages), /Continue export/);
			return fauxAssistantMessage("Continued");
		},
	]);
	assert.equal((await run(chat)).status, "done");
	assert.equal(chat.faux.state.callCount, 2);
	const saved = (await chat.harness.snapshot(AutoHandoffDoc, chat.conversation.id, context))!.last!;
	assert.doesNotMatch(JSON.stringify(saved), /ant-aaaaaaaaaaaaaaaaaaaa|<system>/);
});

for (const interruption of ["throw", "stop", "role-change"] as const)
	test(`oversized handoff rewrite ${interruption} preserves context without another attempt`, async (t) => {
		const chat = await open(t);
		await seed(chat);
		const entered = deferred<void>(),
			finish = deferred<ReturnType<typeof fauxAssistantMessage>>();
		t.after(() => finish.resolve(handoff()));
		chat.faux.setResponses([
			fauxAssistantMessage("🦀".repeat(1025)),
			async (_, options) => {
				if (interruption === "throw") throw new Error("Unknown rewrite outcome");
				if (interruption === "role-change") chat.state.coordinator = true;
				else {
					options?.signal?.addEventListener(
						"abort",
						() => finish.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
						{ once: true },
					);
					entered.resolve();
					return finish.promise;
				}
				return handoff();
			},
		]);
		const pending = run(chat);
		if (interruption === "stop") {
			await entered.promise;
			await chat.conversation.abort(context);
		}
		assert.equal((await pending).status, "unanswered");
		assert.equal(chat.faux.state.callCount, 2);
		assert.equal(chat.state.effects, 0);
		assert.equal(
			(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
			false,
		);
		assert.match(JSON.stringify((await chat.conversation.context(context)).messages), /ORIGINAL_ONLY_CANARY/);
	});

test("Stop cancels a preparing handoff without replacing context or executing tools", async (t) => {
	const chat = await open(t);
	await seed(chat);
	const entered = deferred<void>(),
		finish = deferred<ReturnType<typeof fauxAssistantMessage>>();
	t.after(() => finish.resolve(handoff()));
	chat.faux.setResponses([
		async (_, options) => {
			options?.signal?.addEventListener(
				"abort",
				() => finish.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
				{ once: true },
			);
			entered.resolve();
			return finish.promise;
		},
	]);
	const pending = run(chat);
	await entered.promise;
	await chat.conversation.abort(context);
	assert.equal((await pending).status, "unanswered");
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
	assert.equal((await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))!.compactions, undefined);
	assert.equal(chat.state.effects, 0);
});

test("disabling during an admitted handoff lets that handoff finish, then stops further rollovers", async (t) => {
	const chat = await open(t);
	await seed(chat);
	chat.faux.setResponses([
		() => {
			chat.state.enabled = false;
			return handoff();
		},
		fauxAssistantMessage("Continued"),
	]);
	assert.equal((await run(chat)).status, "done");
	assert.equal((await entries(chat)).filter((entry) => entry.kind === "pi.compaction").length, 1);
	await seed(chat);
	chat.faux.setResponses([fauxAssistantMessage("No next handoff")]);
	assert.equal((await run(chat)).status, "done");
	assert.equal((await entries(chat)).filter((entry) => entry.kind === "pi.compaction").length, 1);
});

test("a coordinator role change during preparation fences publication", async (t) => {
	const chat = await open(t);
	await seed(chat);
	chat.faux.setResponses([
		() => {
			chat.state.coordinator = true;
			return handoff();
		},
	]);
	assert.equal((await run(chat)).status, "unanswered");
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
});

test("uncertain handoff recovery never repeats the tool-free request", async (t) => {
	const chat = await open(t);
	await seed(chat);
	chat.registry.install(
		chat.auto.extension({
			name: "native",
			hooks: [
				hook(CompactionTask, {
					beforeCompact: async (_, api) => {
						await chat.harness.commit(async (tx) => {
							(await tx.doc(AutoHandoffDoc, api.conversationId)).last = {
								task: String(api.taskId),
								identity: "interrupted",
								result: { kind: "pending" },
							};
						}, context);
					},
				}),
			],
		}),
	);
	assert.equal((await run(chat)).status, "unanswered");
	assert.equal(chat.faux.state.callCount, 0);
	assert.match(
		(await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))!.compactionFailure!.error,
		/unknown/,
	);
});

test("SQLite reopen preserves the full history and committed handoff without regenerating it", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-auto-handoff-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "harness.sqlite");
	const first = await open(t, await openNodeSqliteStorage(file));
	await seed(first);
	first.faux.setResponses([handoff(), fauxAssistantMessage("First continuation")]);
	assert.equal((await run(first)).status, "done");
	await first.harness.close(context);
	const next = await open(t, await openNodeSqliteStorage(file));
	next.faux.setResponses([
		(request) => {
			assert.match(JSON.stringify(request.messages), /Pilot handoff/);
			assert.doesNotMatch(JSON.stringify(request.messages), /ORIGINAL_ONLY_CANARY/);
			return fauxAssistantMessage("After reopen");
		},
	]);
	assert.equal((await run(next, "Continue after reopen")).status, "done");
	assert.equal(next.faux.state.callCount, 1);
	assert.equal((await entries(next)).filter((entry) => entry.kind === "pi.compaction").length, 1);
});

test("source serialization keeps evidence and questions but omits reasoning and image bytes", () => {
	const messages: Message[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: "Keep draft" },
				{ type: "image", data: "IMAGE_BYTES_CANARY", mimeType: "image/png" },
			],
			timestamp: 1,
		},
		fauxAssistantMessage([{ type: "thinking", thinking: "PRIVATE_REASONING_CANARY" }, fauxToolCall("effect", {})]),
	];
	const text = handoffSource(
		[{ id: 1, kind: "pilot.question", data: { question: "Keep preview open?" } } as never],
		[messages],
	);
	assert.match(text, /Keep draft|Keep preview open/);
	assert.match(text, /effect/);
	assert.doesNotMatch(text, /IMAGE_BYTES_CANARY|PRIVATE_REASONING_CANARY/);
});

test("large Unicode codemode results are bounded only in writer source, never in original history", async (t) => {
	const chat = await open(t, new MemoryStorage(), false, 200_000);
	await seed(chat, 0);
	const output = `CODEMODE_RESULT ${"日志 🦀 ".repeat(50_000)} ORIGINAL_TAIL_CANARY`;
	await chat.conversation.commit(async (tx) => {
		const answer = fauxAssistantMessage(fauxToolCall("codemode", { code: "synthetic historical code" }), {
			stopReason: "toolUse",
		});
		answer.usage = { ...answer.usage, input: 150_000, totalTokens: 150_000 };
		await tx.appendEntry(AssistantEntry, chat.conversation.id, { model: [answer] });
		await tx.appendEntry(ToolResultEntry, chat.conversation.id, {
			data: { diagnostics: [] },
			model: [
				{
					role: "toolResult",
					toolName: "codemode",
					toolCallId: (answer.content[0] as { id: string }).id,
					content: [{ type: "text", text: output }],
					isError: false,
					timestamp: 1,
				},
			],
		});
	}, context);
	chat.faux.setResponses([
		(request) => {
			const source = JSON.stringify(request.messages);
			assert.match(source, /CODEMODE_RESULT|Source text clipped/);
			assert.match(source, /Source text clipped/);
			assert.doesNotMatch(source, /ORIGINAL_TAIL_CANARY/);
			return handoff();
		},
		fauxAssistantMessage("Continued without rerunning code"),
	]);
	assert.equal((await run(chat)).status, "done");
	assert.ok(
		(await entries(chat)).some((entry) =>
			entry.model?.some(
				(message) =>
					message.role === "toolResult" &&
					message.content.some((block) => block.type === "text" && block.text === output),
			),
		),
	);
	assert.equal(chat.faux.state.callCount, 2);
	assert.equal(chat.state.effects, 0);
});

test("retained head markers and interleaved user inputs keep the entire unseen image round tool-safe", async (t) => {
	const chat = await open(t);
	let assistantId: number | undefined;
	await chat.conversation.commit(async (tx) => {
		const start = await tx.appendEntry(UserEntry, chat.conversation.id, {
			model: [{ role: "user", content: "Old work", timestamp: 1 }],
		});
		await tx.appendEntry(ResetEntry, chat.conversation.id, {
			head: "self",
			model: [{ role: "user", content: "OBSOLETE_HEAD_CANARY", timestamp: 1 }],
		});
		await tx.appendEntry(ResetEntry, chat.conversation.id, {
			head: start.id,
			model: [{ role: "user", content: "Current historical head", timestamp: 1 }],
		});
		const calls = [fauxToolCall("effect", {}), fauxToolCall("effect", {})];
		const answer = fauxAssistantMessage(calls, { stopReason: "toolUse" });
		answer.usage = { ...answer.usage, input: 25_000, totalTokens: 25_000 };
		assistantId = (await tx.appendEntry(AssistantEntry, chat.conversation.id, { model: [answer] })).id;
		await tx.appendEntry(UserEntry, chat.conversation.id, {
			model: [{ role: "user", content: "INTERLEAVED_CURRENT_INPUT", timestamp: 1 }],
		});
		for (const [index, call] of calls.entries())
			await tx.appendEntry(ToolResultEntry, chat.conversation.id, {
				data: { diagnostics: [] },
				model: [
					{
						role: "toolResult",
						toolName: "effect",
						toolCallId: call.id,
						content:
							index === 0
								? [{ type: "text", text: "Effect already committed" }]
								: [{ type: "image", mimeType: "image/png", data: "UNSEEN_IMAGE_CANARY" }],
						isError: false,
						timestamp: 1,
					},
				],
			});
	}, context);
	chat.faux.setResponses([
		(request) => {
			assert.doesNotMatch(
				JSON.stringify(request.messages),
				/OBSOLETE_HEAD_CANARY|INTERLEAVED_CURRENT_INPUT|UNSEEN_IMAGE_CANARY/,
			);
			return handoff();
		},
		(request) => {
			assert.match(JSON.stringify(request.messages), /INTERLEAVED_CURRENT_INPUT|UNSEEN_IMAGE_CANARY/);
			const round = request.messages.findIndex((message) => message.role === "assistant");
			assert.equal(request.messages[round + 1]?.role, "toolResult");
			assert.equal(request.messages[round + 2]?.role, "toolResult");
			return fauxAssistantMessage("Pixels received, no effects replayed");
		},
	]);
	assert.equal((await run(chat)).status, "done");
	assert.equal((await entries(chat)).find((entry) => entry.kind === "pi.compaction")?.head, assistantId);
	assert.equal(chat.state.effects, 0);
});

test("an unexpected error in the handoff hook fails closed, not into the native summarizer", async (t) => {
	const chat = await open(t);
	await seed(chat);
	t.mock.method(chat.auto as unknown as { compact: () => Promise<never> }, "compact", async () => {
		throw new Error("Unexpected hook defect");
	});
	assert.equal((await run(chat)).status, "unanswered");
	assert.equal(chat.faux.state.callCount, 0);
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
});

test("the placement commit rechecks current role after the handoff hook returned", async (t) => {
	const chat = await open(t);
	await seed(chat);
	const extension = chat.auto.extension({ name: "native" });
	const original = extension.hooks![0]!.handlers as import("@earendil-works/pi-durable").CompactionHooks;
	chat.registry.install({
		...extension,
		hooks: [
			hook(CompactionTask, {
				beforeCompact: async (input, api, scope) => {
					const result = await original.beforeCompact(input, api, scope);
					chat.state.coordinator = true;
					return result;
				},
			}),
		],
	});
	chat.faux.setResponses([handoff()]);
	assert.equal((await run(chat)).status, "unanswered");
	assert.equal(chat.faux.state.callCount, 1);
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
});

test("the placement commit refuses a source head changed after the hook returned", async (t) => {
	const chat = await open(t);
	await seed(chat);
	const extension = chat.auto.extension({ name: "native" });
	const original = extension.hooks![0]!.handlers as import("@earendil-works/pi-durable").CompactionHooks;
	chat.registry.install({
		...extension,
		hooks: [
			hook(CompactionTask, {
				beforeCompact: async (input, api, scope) => {
					const decision = await original.beforeCompact(input, api, scope);
					await chat.conversation.commit(async (tx) => {
						await tx.appendEntry(chat.conversation.id, {
							kind: "fixture.new-head",
							head: "self",
							model: [{ role: "user", content: "EXTERNAL_NEW_HEAD", timestamp: 1 }],
						});
					}, scope);
					return decision;
				},
			}),
		],
	});
	chat.faux.setResponses([handoff()]);
	assert.equal((await run(chat)).status, "unanswered");
	assert.equal(chat.faux.state.callCount, 1);
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
	assert.match(JSON.stringify((await chat.conversation.context(context)).messages), /EXTERNAL_NEW_HEAD/);
});

async function manyEntries(chat: Chat) {
	await chat.conversation.commit(async (tx) => {
		for (let i = 0; i < 70; i++)
			await tx.appendEntry(UserEntry, chat.conversation.id, {
				model: [{ role: "user", content: `Original source item ${i}`, timestamp: i }],
			});
	}, context);
}

test("disabling during source preparation never dispatches an unadmitted handoff request", async (t) => {
	const chat = await open(t);
	await seed(chat);
	await manyEntries(chat);
	const extension = chat.auto.extension({ name: "native" });
	const original = extension.hooks![0]!.handlers as import("@earendil-works/pi-durable").CompactionHooks;
	chat.registry.install({
		...extension,
		hooks: [
			hook(CompactionTask, {
				beforeCompact: async (input, api, scope) => {
					const result = original.beforeCompact(input, api, scope);
					setImmediate(() => {
						chat.state.enabled = false;
					});
					return result;
				},
			}),
		],
	});
	chat.faux.setResponses([
		(request) => {
			assert.doesNotMatch(JSON.stringify(request.messages), /Prepare a handoff/);
			assert.match(JSON.stringify(request.messages), /ORIGINAL_ONLY_CANARY/);
			return fauxAssistantMessage("Normal continuation after disabling");
		},
	]);
	assert.equal((await run(chat)).status, "done");
	assert.equal(chat.faux.state.callCount, 1);
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
});

test("ready recovery rechecks role after yielding during source preparation", async (t) => {
	const chat = await open(t);
	await seed(chat);
	await manyEntries(chat);
	const extension = chat.auto.extension({ name: "native" });
	const original = extension.hooks![0]!.handlers as import("@earendil-works/pi-durable").CompactionHooks;
	chat.registry.install({
		...extension,
		hooks: [
			hook(CompactionTask, {
				beforeCompact: async (input, api, scope) => {
					await original.beforeCompact(input, api, scope);
					assert.equal(
						(await chat.harness.snapshot(AutoHandoffDoc, api.conversationId, scope))!.last!.result.kind,
						"ready",
					);
					const recovery = original.beforeCompact(input, api, scope);
					setImmediate(() => {
						chat.state.coordinator = true;
					});
					return recovery;
				},
			}),
		],
	});
	chat.faux.setResponses([handoff()]);
	assert.equal((await run(chat)).status, "unanswered");
	assert.equal(chat.faux.state.callCount, 1);
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
});

test("ready recovery validates saved text before reuse without another model call", async (t) => {
	const chat = await open(t);
	await seed(chat);
	const extension = chat.auto.extension({ name: "native" });
	const original = extension.hooks![0]!.handlers as import("@earendil-works/pi-durable").CompactionHooks;
	chat.registry.install({
		...extension,
		hooks: [
			hook(CompactionTask, {
				beforeCompact: async (input, api, scope) => {
					await original.beforeCompact(input, api, scope);
					await chat.harness.commit(async (tx) => {
						(await tx.doc(AutoHandoffDoc, api.conversationId)).last!.result = { kind: "ready", text: "" };
					}, scope);
					return original.beforeCompact(input, api, scope);
				},
			}),
		],
	});
	chat.faux.setResponses([handoff()]);
	assert.equal((await run(chat)).status, "unanswered");
	assert.equal(chat.faux.state.callCount, 1);
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
});

test("handoff never re-executes a committed native tool effect", async (t) => {
	const chat = await open(t);
	chat.state.enabled = false;
	chat.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Effect recorded"),
	]);
	assert.equal((await run(chat, "Execute the fixture effect once")).status, "done");
	assert.equal(chat.state.effects, 1);
	chat.state.enabled = true;
	await seed(chat);
	chat.faux.setResponses([handoff(), fauxAssistantMessage("Continue without replay")]);
	assert.equal((await run(chat)).status, "done");
	assert.equal(chat.state.effects, 1);
});

test("full-context placement is refused for conversation-owned background or manual summaries", async (t) => {
	const chat = await open(t);
	await seed(chat);
	chat.state.manual.keepRecentTokens = 256;
	chat.registry.install({
		name: "native",
		hooks: [
			hook(CompactionTask, {
				beforeCompact: () => ({ summary: "Not admitted at a blocking boundary", replaceContext: true }),
			}),
		],
	});
	const task = await chat.conversation.compact(undefined, context);
	assert.equal((await chat.harness.waitForTask(task, context)).state.outcome.status, "failed");
	assert.equal(
		(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
		false,
	);
	assert.equal(chat.faux.state.callCount, 0);
});

test("manual Compact keeps its legacy tail and output budget while automatic handoff is enabled", async (t) => {
	const chat = await open(t);
	await chat.conversation.commit(async (tx) => {
		for (let i = 0; i < 3; i++)
			await tx.appendEntry(UserEntry, chat.conversation.id, {
				model: [
					{ role: "user", content: `MANUAL_SOURCE_${i}. ${"Manual old source. ".repeat(2000)}`, timestamp: i },
				],
			});
	}, context);
	chat.faux.setResponses([
		(source, options) => {
			assert.doesNotMatch(JSON.stringify(source.messages), /Prepare a handoff/);
			assert.match(JSON.stringify(source.messages), /MANUAL_SOURCE_0/);
			assert.doesNotMatch(JSON.stringify(source.messages), /MANUAL_SOURCE_1|MANUAL_SOURCE_2/);
			assert.equal(options?.maxTokens, 8192, "legacy reserve, capped by model output limit");
			return fauxAssistantMessage("Ordinary manual summary");
		},
	]);
	const task = await chat.conversation.compact("Keep the manual focus", context);
	assert.equal((await chat.harness.waitForTask(task, context)).state.outcome.status, "completed");
	await chat.conversation.waitForIdle(context);
	assert.equal(chat.faux.state.callCount, 1);
	const view = await chat.conversation.context(context);
	assert.match(JSON.stringify(view.messages), /MANUAL_SOURCE_1|MANUAL_SOURCE_2/);
	const marker = view.entries.find((entry) => entry.kind === "pi.compaction")!;
	assert.notEqual(marker.head, marker.id);
	assert.equal((marker.data as { mode?: string }).mode, undefined);
});

for (const cut of ["pending", "rewrite-pending", "ready"] as const)
	test(`SQLite recovery from ${cut} handoff never replays its model request`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "pilot-handoff-recovery-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const file = join(dir, "harness.sqlite");
		const first = await open(t, await openNodeSqliteStorage(file));
		await seed(first);
		const entered = deferred(),
			release = deferred();
		t.after(() => release.resolve());
		if (cut !== "ready") {
			first.faux.setResponses([
				...(cut === "rewrite-pending" ? [fauxAssistantMessage("🦀".repeat(1025))] : []),
				async (_, options) => {
					options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
					entered.resolve();
					await release.promise;
					return handoff();
				},
			]);
		} else {
			const extension = first.auto.extension({ name: "native" });
			const original = extension.hooks![0]!;
			first.registry.install({
				...extension,
				hooks: [
					hook(CompactionTask, {
						beforeCompact: async (input, api, scope) => {
							const result = await (
								original.handlers as import("@earendil-works/pi-durable").CompactionHooks
							).beforeCompact(input, api, scope);
							entered.resolve();
							await release.promise;
							return result;
						},
					}),
				],
			});
			first.faux.setResponses([handoff()]);
		}
		const imageInput: UserMessage["content"] = [
			{ type: "text", text: "RECOVER_CURRENT_IMAGE" },
			{ type: "image", mimeType: "image/png", data: Buffer.from("recovered pixels").toString("base64") },
		];
		const running = run(first, imageInput).catch(() => undefined);
		await entered.promise;
		const diagnostic = (await first.harness.snapshot(AutoHandoffDoc, first.conversation.id, context))!.last!
			.diagnostic;
		assert.equal(
			diagnostic?.phase,
			cut === "ready" ? "validation" : cut === "rewrite-pending" ? "rewrite" : "writer",
		);
		assert.equal(diagnostic?.attempt, cut === "rewrite-pending" ? 2 : 1);
		assert.equal(
			(await first.harness.snapshot(AutoHandoffDoc, first.conversation.id, context))!.last!.result.kind,
			cut === "ready" ? "ready" : "pending",
		);
		const closing = first.harness.close(context);
		release.resolve();
		await closing;
		await running;
		const next = await open(t, await openNodeSqliteStorage(file));
		next.faux.setResponses([
			(request) => {
				assert.deepEqual(request.messages.filter((message) => message.role === "user").at(-1)!.content, imageInput);
				return fauxAssistantMessage("Resumed without regeneration");
			},
		]);
		next.harness.resume();
		await next.conversation.waitForIdle(context);
		assert.equal(next.faux.state.callCount, cut === "ready" ? 1 : 0, "only a normal continuation request may run");
		const markers = (await entries(next)).filter((entry) => entry.kind === "pi.compaction");
		assert.equal(markers.length, cut === "ready" ? 1 : 0);
		if (cut === "ready")
			assert.deepEqual(
				(await entries(next)).find((entry) => entry.id === markers[0]!.head)?.model?.[0]?.content,
				imageInput,
			);
		if (cut !== "ready")
			assert.match(
				(await next.harness.snapshot(LiveDoc, next.conversation.id, context))!.compactionFailure!.error,
				/unknown/,
			);
	});
