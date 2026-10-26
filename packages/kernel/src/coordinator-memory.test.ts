import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, UsageDoc } from "@earendil-works/pi-durable";
import {
	COORDINATOR_MEMORY_FOCUS,
	CoordinatorMemory,
	CoordinatorMemoryDoc,
	memoryBlocks,
	memoryCachePayload,
} from "./coordinator-memory.ts";
import { coordinatorMemoryModel, type MemoryModel } from "./coordinator-memory-model.ts";

test("exact internal role model preserves provider/API family, independent of picker visibility", () => {
	const base = fauxProvider().getModel();
	const available = [
		{ ...base, provider: "openai", id: "gpt-6-luna", api: "openai-responses" },
		{ ...base, provider: "openai-codex", id: "gpt-6-luna", api: "openai-codex-responses" },
		{ ...base, provider: "anthropic", id: "claude-haiku-5-5", api: "anthropic-messages" },
	] as MemoryModel[];
	for (const provider of ["openai", "openai-codex", "anthropic"])
		assert.equal(coordinatorMemoryModel(provider, available)?.provider, provider);
	assert.equal(
		coordinatorMemoryModel(
			"openai-codex",
			available.filter((m) => m.provider === "openai"),
		),
		undefined,
	);
	assert.equal(coordinatorMemoryModel("other", available), undefined);
	assert.equal(coordinatorMemoryModel("anthropic", []), undefined);
	assert.equal(
		coordinatorMemoryModel("openai", [{ ...available[0]!, api: "openai-decisions" } as unknown as MemoryModel]),
		undefined,
	);
});

async function fixture(t: TestContext, scope: string | undefined = "mission") {
	const faux = fauxProvider({
		tokensPerSecond: 0,
		models: [
			{ id: "main", contextWindow: 1_000_000 },
			{ id: "cheap", contextWindow: 1_000_000 },
		],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	let harness: Harness | undefined;
	const state = {
		scope: scope as string | undefined,
		available: true,
		fail: false,
		calls: [] as string[],
		resolutions: 0,
		diagnostics: [] as string[],
		abort: undefined as (() => void) | undefined,
		pause: undefined as { entered(): void; release: Promise<void> } | undefined,
	};
	const complete = models.completeSimple.bind(models);
	models.completeSimple = async (model, request, options) => {
		state.calls.push(model.id);
		state.abort?.();
		if (state.fail && model.id === "cheap") throw new Error("provider failure");
		if (state.pause && model.id === "cheap") {
			const pause = state.pause;
			pause.entered();
			await new Promise<void>((resolve, reject) => {
				const abort = () => reject(new Error("stopped"));
				options?.signal?.addEventListener("abort", abort, { once: true });
				pause.release.then(() => {
					options?.signal?.removeEventListener("abort", abort);
					resolve();
				}, reject);
				if (options?.signal?.aborted) abort();
			});
		}
		return complete(model, request, options);
	};
	const makeMemory = () =>
		new CoordinatorMemory({
			scope: () => state.scope,
			provider: () => faux.getModel().provider,
			resolve: async () => {
				state.resolutions++;
				return state.available ? faux.getModel("cheap") : undefined;
			},
			harness: () => harness,
			diagnostic: (reason) => state.diagnostics.push(reason),
		});
	let memory = makeMemory();
	const registry = createRegistry();
	registry.install(memory.extension({ name: "native" }));
	await memory.refresh();
	const rawStorage = new MemoryStorage();
	const storage = new Proxy(rawStorage, {
		get(target, key) {
			if (key === "close") return async () => {};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	harness = await Harness.open(
		storage,
		{ models, registry, settings: { retry: { maxRetries: 0 }, compaction: { backgroundTokens: 0 } } },
		context,
	);
	let conversation = await harness.root(context, {
		agent: { model: { provider: faux.getModel().provider, modelId: "main" }, extensions: [{ name: "native" }] },
	});
	t.after(async () => {
		await harness!.close(context);
		await rawStorage.close(context);
	});
	let counter = 0;
	const write = async (count = 60, chars = 3000) => {
		await conversation.commit(async (tx) => {
			for (let i = 0; i < count; i++)
				await tx.appendEntry(conversation.id, {
					kind: "fixture",
					model: [
						{
							role: "user",
							content: `original ${counter++}: EXACT-OLD-FACT ${"source ".repeat(Math.ceil(chars / 7))}`,
							timestamp: 0,
						},
					],
				});
		}, context);
	};
	const compact = async (instructions?: string) => {
		faux.setResponses(
			Array.from({ length: 400 }, () => fauxAssistantMessage(`Historical note ${"detail ".repeat(56)}`)),
		);
		const id = await conversation.compact(instructions, context);
		await harness!.waitForTask(id, context);
		await conversation.waitForIdle(context);
		return (await conversation.entries({}, 1000, undefined, context)).items.filter((e) => e.kind === "pi.compaction");
	};
	return {
		faux,
		state,
		memory,
		write,
		compact,
		get harness() {
			return harness!;
		},
		get conversation() {
			return conversation;
		},
		async reopen() {
			await harness!.close(context);
			memory = makeMemory();
			registry.install(memory.extension({ name: "native" }));
			await memory.refresh();
			harness = await Harness.open(
				storage,
				{ models, registry, settings: { retry: { maxRetries: 0 }, compaction: { backgroundTokens: 0 } } },
				context,
			);
			conversation = await harness.root(context);
		},
		async fork() {
			conversation = await conversation.fork(
				(await conversation.entries({}, 1, undefined, context)).items[0]!.id,
				{ ownership: { kind: "ownerless" } },
				context,
			);
		},
	};
}
const summary = (entry: { model?: readonly import("@earendil-works/pi-ai").Message[] }) =>
	contentText(entry.model![0]!.content);

test("coordinator default tree uses cheap summaries, preserves originals and reuses placed frontier", async (t) => {
	const f = await fixture(t);
	await f.write();
	const first = await f.compact(COORDINATOR_MEMORY_FOCUS);
	assert.equal(first.length, 1);
	assert.match(summary(first[0]!), /Coordinator memory v1/);
	assert.ok(f.state.calls.length > 1 && f.state.calls.every((c) => c === "cheap"));
	const doc = await f.harness.snapshot(CoordinatorMemoryDoc, f.conversation.id, context);
	assert.equal(doc?.states.length, 1);
	assert.ok(Buffer.byteLength(summary(first[0]!)) <= 128000);
	const originals = (await f.conversation.entries({}, 1000, undefined, context)).items.filter(
		(e) => e.kind === "fixture",
	);
	assert.equal(originals.length, 60);
	assert.match(JSON.stringify(originals.at(-1)), /EXACT-OLD-FACT/);
	await f.reopen();
	await f.write(35);
	await f.compact();
	const restored = await f.harness.snapshot(CoordinatorMemoryDoc, f.conversation.id, context);
	assert.equal(restored?.states.length, 2);
	assert.ok(restored!.states[0]!.next > doc!.states[0]!.next);
	assert.deepEqual(restored!.states[0]!.nodes.slice(0, doc!.states[0]!.nodes.length), doc!.states[0]!.nodes);
	const usage = await f.harness.snapshot(UsageDoc, f.conversation.id, context);
	assert.ok(Object.keys(usage!.models).some((key) => key.endsWith("/cheap")));
});

test("ordinary chats do not resolve or summarize trees; role can change at boundaries", async (t) => {
	const f = await fixture(t, "");
	assert.equal(f.state.resolutions, 0);
	assert.equal(f.memory.policy(1_000_000), undefined);
	await f.write();
	assert.doesNotMatch(summary((await f.compact())[0]!), /Coordinator memory v1/);
	assert.deepEqual(f.state.calls, ["main"]);
	f.state.scope = "mission";
	await f.memory.refresh();
	assert.ok(f.memory.policy(1_000_000));
	await f.write(35);
	assert.match(summary((await f.compact())[0]!), /Coordinator memory v1/);
	f.state.scope = undefined;
	assert.equal(f.memory.policy(1_000_000), undefined);
});

test("unavailable authorization/model and provider errors retain ordinary safe compaction", async (t) => {
	const f = await fixture(t);
	f.state.available = false;
	await f.write();
	assert.doesNotMatch(summary((await f.compact())[0]!), /Coordinator memory v1/);
	assert.deepEqual(f.state.calls, ["main"]);
	f.state.available = true;
	f.state.fail = true;
	await f.write(35);
	await f.compact();
	assert.ok(f.state.calls.includes("cheap") && f.state.calls.at(-1) === "main");
	assert.ok(f.state.diagnostics.length);
	assert.equal((await f.harness.snapshot(CoordinatorMemoryDoc, f.conversation.id, context))?.states.length ?? 0, 0);
});

test("large existing ranges adopt via existing compaction, not a bulk paid tree rebuild", async (t) => {
	const f = await fixture(t);
	await f.write(170, 4000);
	await f.compact();
	assert.deepEqual(f.state.calls, ["main"]);
	await f.write(35);
	assert.match(summary((await f.compact())[0]!), /Coordinator memory v1/);
});

test("explicit manual focus is preserved and fork caches never inherit authority", async (t) => {
	const f = await fixture(t);
	await f.write();
	await f.compact("Keep only the user's unanswered question");
	assert.deepEqual(f.state.calls, ["main"]);
	await f.write(35);
	await f.compact();
	await f.fork();
	assert.equal(await f.harness.snapshot(CoordinatorMemoryDoc, f.conversation.id, context), undefined);
});

test("long repeated coordination actually merges sibling nodes and keeps its view bounded", async (t) => {
	const f = await fixture(t);
	await f.write();
	await f.compact();
	for (let i = 0; i < 6; i++) {
		await f.write(35);
		await f.compact();
	}
	const states = (await f.harness.snapshot(CoordinatorMemoryDoc, f.conversation.id, context))!.states;
	assert.equal(states.length, 2);
	assert.ok(states[0]!.nodes.some((n) => n.count > 1));
	const entries = (await f.conversation.entries({}, 1000, undefined, context)).items.filter(
		(e) => e.kind === "pi.compaction",
	);
	assert.ok(entries.every((e) => Buffer.byteLength(summary(e)) < 129000));
});

test("abort joins summary work, publishes no memory and never starts a fallback request", async (t) => {
	const f = await fixture(t);
	await f.write();
	let abort: Promise<void> | undefined;
	f.state.abort = () => {
		f.state.abort = undefined;
		abort = f.conversation.abort(context);
	};
	assert.equal((await f.compact()).length, 0);
	await abort;
	assert.ok(f.state.calls.length <= 8 && f.state.calls.every((m) => m === "cheap"));
	assert.equal((await f.harness.snapshot(CoordinatorMemoryDoc, f.conversation.id, context))?.states.length ?? 0, 0);
	assert.equal(
		(await f.conversation.entries({}, 1000, undefined, context)).items.filter((e) => e.kind === "fixture").length,
		60,
	);
});

test("role revocation during generation cannot publish its old-scope frontier", async (t) => {
	const f = await fixture(t);
	await f.write();
	f.state.abort = () => {
		f.state.scope = undefined;
		f.state.abort = undefined;
	};
	await f.compact();
	assert.equal((await f.harness.snapshot(CoordinatorMemoryDoc, f.conversation.id, context))?.states.length ?? 0, 0);
	assert.equal(f.state.calls.at(-1), "main");
});

test("interrupted cache nodes survive restart as uncertain, never blindly billed again", async (t) => {
	const f = await fixture(t);
	await f.write();
	let entered!: () => void, release!: () => void;
	const ready = new Promise<void>((r) => {
			entered = r;
		}),
		gate = new Promise<void>((r) => {
			release = r;
		});
	f.state.pause = { entered, release: gate };
	const id = await f.conversation.compact(undefined, context);
	try {
		await ready;
		await f.reopen();
		f.state.pause = undefined;
		f.state.calls.length = 0;
		f.faux.setResponses([fauxAssistantMessage("ordinary recovery checkpoint")]);
		f.harness.resume();
		await f.harness.waitForTask(id, context);
		await f.conversation.waitForIdle(context);
		assert.deepEqual(f.state.calls, ["main"]);
		assert.equal((await f.harness.snapshot(CoordinatorMemoryDoc, f.conversation.id, context))?.states.length ?? 0, 0);
	} finally {
		release();
	}
});

test("reset never restores an old tree, and context edits use the authoritative projection", async (t) => {
	const f = await fixture(t);
	await f.write();
	await f.compact();
	const old = (await f.harness.snapshot(CoordinatorMemoryDoc, f.conversation.id, context))!.states[0]!;
	await f.conversation.reset(undefined, context);
	await f.conversation.waitForIdle(context);
	await f.write();
	await f.compact();
	const next = (await f.harness.snapshot(CoordinatorMemoryDoc, f.conversation.id, context))!.states[0]!;
	assert.ok(next.nodes[0]!.first > old.nodes.at(-1)!.last);
	await f.write(35);
	const active = await f.conversation.context(context),
		target = active.entries.find((e) => e.kind === "fixture")!;
	await f.conversation.commit(
		(tx) =>
			tx.appendEntry(f.conversation.id, { kind: "context-edit", edits: [{ target: target.id, action: "omit" }] }),
		context,
	);
	f.state.calls.length = 0;
	await f.compact();
	assert.deepEqual(f.state.calls, ["main"]);
});

test("existing busy coordinator stages memory without interrupting or replacing its active turn", async (t) => {
	const f = await fixture(t);
	await f.write();
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>((r) => {
			release = r;
		}),
		started = new Promise<void>((r) => {
			entered = r;
		});
	f.faux.setResponses([
		async () => {
			entered();
			await gate;
			return fauxAssistantMessage("active answer");
		},
		...Array.from({ length: 400 }, () => fauxAssistantMessage("historical note")),
	]);
	try {
		const submission = await f.conversation.submit({ type: "input", content: "continue active work" }, context);
		await started;
		const task = await f.conversation.compact(undefined, context);
		await f.harness.waitForTask(task, context);
		assert.equal(
			(await f.conversation.context(context)).entries.some((e) => e.kind === "pi.compaction"),
			false,
		);
		release();
		await submission.wait(context);
		await f.conversation.waitForIdle(context);
		assert.ok((await f.conversation.context(context)).entries.some((e) => e.kind === "pi.compaction"));
		assert.match(JSON.stringify((await f.conversation.entries({}, 1000, undefined, context)).items), /active answer/);
	} finally {
		release();
	}
});

test("four-line memory packets preserve exact text and respect Anthropic cache mark limit", () => {
	const content =
		"The conversation history before this point was compacted\n\n<summary>\nCoordinator memory v1\na\nb\nc\nd\nEnd of coordinator memory.\n</summary>";
	const packets = memoryBlocks([{ role: "user", content, timestamp: 0 }]);
	assert.equal((packets[0]!.content as { text: string }[]).map((x) => x.text).join(""), content);
	const model = { ...fauxProvider().getModel(), provider: "anthropic", api: "anthropic-messages" } as MemoryModel;
	const payload = { messages: [{ content: packets[0]!.content }] };
	assert.equal(memoryCachePayload(payload, model), payload);
	assert.equal(
		(payload.messages[0]!.content as { cache_control?: unknown }[]).filter((b) => b.cache_control).length,
		1,
	);
	const full = {
		system: Array.from({ length: 4 }, () => ({ cache_control: { type: "ephemeral" } })),
		messages: [{ content: [{ type: "text", text: "End of coordinator memory." }] }],
	};
	memoryCachePayload(full, model);
	assert.equal("cache_control" in full.messages[0]!.content[0]!, false);
});
