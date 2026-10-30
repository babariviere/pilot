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
async function open(t: TestContext, storage: Storage = new MemoryStorage(), digest = false) {
	const faux = fauxProvider({ tokensPerSecond: 0, models: [{ id: "main", contextWindow: 32_000, maxTokens: 8192 }] });
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
			auto.policy(32_000, conversation?.id) ?? {
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

for (const failure of ["empty", "length", "tool", "oversized", "provider-error", "throw"] as const)
	test(`invalid handoff ${failure} preserves context and fails without native fallback`, async (t) => {
		const chat = await open(t);
		await seed(chat);
		chat.faux.setResponses([
			() => {
				if (failure === "throw") throw new Error("Simulated lost model acknowledgement");
				if (failure === "empty") return fauxAssistantMessage("");
				if (failure === "length") return fauxAssistantMessage("Partial handoff", { stopReason: "length" });
				if (failure === "tool") return fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" });
				if (failure === "oversized") return fauxAssistantMessage("🦀".repeat(1025));
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider failed" });
			},
		]);
		assert.equal((await run(chat)).status, "unanswered");
		assert.equal(chat.faux.state.callCount, 1);
		assert.equal(chat.state.effects, 0);
		assert.equal(
			(await entries(chat)).some((entry) => entry.kind === "pi.compaction"),
			false,
		);
		assert.match(JSON.stringify((await chat.conversation.context(context)).messages), /ORIGINAL_ONLY_CANARY/);
		assert.match(
			(await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))!.compactionFailure!.error,
			/handoff/i,
		);
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

for (const cut of ["pending", "ready"] as const)
	test(`SQLite recovery from ${cut} handoff never replays its model request`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "pilot-handoff-recovery-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const file = join(dir, "harness.sqlite");
		const first = await open(t, await openNodeSqliteStorage(file));
		await seed(first);
		const entered = deferred(),
			release = deferred();
		t.after(() => release.resolve());
		if (cut === "pending") {
			first.faux.setResponses([
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
		assert.equal(
			(await first.harness.snapshot(AutoHandoffDoc, first.conversation.id, context))!.last!.result.kind,
			cut,
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
		if (cut === "pending")
			assert.match(
				(await next.harness.snapshot(LiveDoc, next.conversation.id, context))!.compactionFailure!.error,
				/unknown/,
			);
	});
