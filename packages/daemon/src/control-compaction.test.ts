import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { AssistantMessage, Context, Model, Tool } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CONTROL_SYSTEM_PROMPT, controlBlocks, controlContext, markControlCache } from "@pilot/kernel/control-context";
import { ControlCompactor, compactControlNode } from "./control-compaction.ts";
import { ControlMemory } from "./control-memory.ts";
import type { ControlJob } from "./control-memory-disk.ts";
import { ControlMemoryDisk } from "./control-memory-disk.ts";
import { ModelCatalog } from "./models.ts";
import { requiredAuthRegistration } from "./testing/required-auth.ts";

const model: Model<"openai-completions"> = {
	id: "cheap",
	name: "cheap",
	provider: "test",
	api: "openai-completions",
	baseUrl: "http://unused",
	input: ["text"],
	reasoning: false,
	contextWindow: 200_000,
	maxTokens: 4096,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
};
function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}
const tools: Tool[] = [
	{ name: "history", description: "Read chat history.", parameters: { type: "object", properties: {} } },
];
const job: ControlJob = { id: 0, n: 1, source: `user: ${"x".repeat(600)}` };
async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "control-compact-")),
		memory = new ControlMemory(home);
	t.after(async () => {
		await memory.stop();
		await rm(home, { recursive: true, force: true });
	});
	return { home, memory };
}
test("compaction shares the turn prefix/tools, uses a 512-byte ruler and UTF-8 feedback", async () => {
	let calls = 0;
	const runtime = {
		completeSimple: async (
			_model: unknown,
			context: Context,
			options: Parameters<ModelRuntime["completeSimple"]>[2],
		) => {
			assert.equal(context.systemPrompt, CONTROL_SYSTEM_PROMPT);
			assert.equal(context.tools, tools);
			assert.deepEqual(
				context.messages.slice(0, 2),
				controlContext([], String(context.messages[1]!.content), tools).messages,
			);
			assert.equal(options?.toolChoice, "none");
			assert.equal(options?.maxRetries, 0);
			assert.match(String(context.messages[1]!.content), new RegExp("-".repeat(512)));
			if (calls++) {
				assert.match(String(context.messages.at(-1)!.content), /514 bytes/);
				assert.doesNotMatch(String(context.messages.at(-1)!.content), /�/);
				return answer("shortest");
			}
			return answer("é".repeat(257));
		},
	};
	assert.equal(await compactControlNode(runtime, model, tools, job, [], new AbortController().signal), "shortest");
	assert.equal(calls, 2);
});
test("at most five corrections, no truncation or tool execution", async () => {
	let calls = 0;
	await assert.rejects(
		compactControlNode(
			{
				completeSimple: async () => {
					calls++;
					return answer("x".repeat(700 - calls));
				},
			},
			model,
			tools,
			job,
			[],
			new AbortController().signal,
		),
		/shortest line was 694 bytes after 5 retries/,
	);
	assert.equal(calls, 6);
	await assert.rejects(
		compactControlNode(
			{
				completeSimple: async () => ({
					...answer(""),
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "x", name: "history", arguments: { action: "zoom", id: 0, n: 1 } }],
				}),
			},
			model,
			tools,
			job,
			[],
			new AbortController().signal,
		),
		/attempted a tool/,
	);
});
test("four-line cache blocks preserve the old prefix, marking last whole block and request end", () => {
	const lines = Array.from({ length: 9 }, (_, id) => ({ id, n: 1, text: `line ${id}` }));
	const earlier = controlBlocks(lines.slice(0, 8)),
		later = controlBlocks(lines);
	assert.deepEqual(later.blocks.slice(0, 2), earlier.blocks.slice(0, 2));
	assert.equal(later.lastWhole, earlier.lastWhole);
	const payload = {
		messages: [
			{
				content: [
					...later.blocks.map((text) => ({ type: "text", text, cache_control: { type: "ephemeral" } })),
					{ type: "text", text: "task", cache_control: { type: "ephemeral" } },
				],
			},
		],
	};
	markControlCache(payload, later.lastWhole);
	assert.deepEqual(
		payload.messages[0]!.content.map((b, i) => (b.cache_control ? i : -1)).filter((i) => i >= 0),
		[1, 4],
	);
});
test("ready queues bound concurrency to eight, context has no placeholders, parents follow children", async (t) => {
	const { memory } = await fixture(t);
	let active = 0,
		max = 0,
		started = 0;
	let release!: () => void, eight!: () => void;
	const gate = new Promise<void>((resolve) => {
			release = resolve;
		}),
		firstEight = new Promise<void>((resolve) => {
			eight = resolve;
		});
	const compactor = new ControlCompactor(memory, async (job, lines) => {
		active++;
		max = Math.max(max, active);
		started++;
		if (started === 8) eight();
		assert.ok(lines.every((line) => !line.text.includes("not summarized")));
		assert.ok(lines.every((line) => line.id + line.n <= (job.n === 1 ? job.id : job.id + job.n)));
		try {
			await gate;
			return `summary ${job.id}+${job.n} ${"x".repeat(480)}`;
		} finally {
			active--;
		}
	});
	t.after(async () => {
		release();
		await compactor.stop();
	});
	for (let i = 0; i < 20; i++) await compactor.append({ kind: "user", text: `${i} ${"x".repeat(600)}` });
	await firstEight;
	assert.equal(max, 8);
	assert.equal(started, 8);
	release();
	await compactor.settled();
	assert.equal((await memory.state()).pending, 0);
	assert.ok(started > 20, "parent nodes were built too");
	assert.ok(max <= 8);
});
test("failure retries in the background with backoff; shutdown cancels an uncooperative provider", {
	timeout: 10_000,
}, async (t) => {
	const { memory } = await fixture(t);
	let fail = true,
		calls = 0;
	let retried!: () => void;
	const retryStarted = new Promise<void>((resolve) => {
		retried = resolve;
	});
	const compactor = new ControlCompactor(memory, async () => {
		calls++;
		if (fail) throw new Error("offline");
		retried();
		return "summary";
	});
	t.after(() => compactor.stop());
	await compactor.append({ kind: "user", text: "x".repeat(600) });
	await compactor.settled();
	assert.equal(calls, 1);
	assert.equal((await memory.state()).pending, 1);
	compactor.wake();
	await compactor.settled();
	assert.equal(calls, 1);
	fail = false;
	await compactor.append({ kind: "user", text: "retry" });
	await compactor.settled();
	assert.equal(calls, 1, "a new message must not bypass retry backoff");
	await retryStarted;
	await compactor.settled();
	assert.equal((await memory.state()).pending, 0);
	assert.equal((await memory.state()).failure, undefined);
	await compactor.stop();
	let started!: () => void, signal: AbortSignal | undefined;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const held = new ControlCompactor(memory, async (_job, _lines, s) => {
		signal = s;
		started();
		return new Promise<string>(() => {});
	});
	await held.append({ kind: "event", text: "x".repeat(600) });
	await ready;
	await held.stop();
	assert.equal(signal?.aborted, true);
});
test("catalog chooses a cheap scoped model from the turn provider only", async (t) => {
	const { home } = await fixture(t);
	const expensive = { ...model, id: "expensive", cost: { ...model.cost, input: 5 } },
		other = { ...model, id: "other", provider: "another", cost: { ...model.cost, input: 0, output: 0 } };
	t.mock.method(
		ModelRuntime,
		"create",
		async () =>
			({
				...requiredAuthRegistration,
				getAvailable: async () => [expensive, other, model],
				completeSimple: async (chosen: unknown) => {
					assert.equal(chosen, model);
					return answer("summary");
				},
			}) as unknown as ModelRuntime,
	);
	const catalog = new ModelCatalog(home);
	assert.equal(await catalog.compactControl(home, "test", tools, job, [], new AbortController().signal), "summary");
	await assert.rejects(
		catalog.compactControl(home, "missing", tools, job, [], new AbortController().signal),
		/No authenticated/,
	);
});

test("compaction view is bounded, built-only and preserved over restart", async (t) => {
	const { home } = await fixture(t);
	const dir = join(home, "direct");
	let disk = new ControlMemoryDisk(dir);
	t.after(() => disk.close());
	for (let id = 0; id < 400; id++) {
		disk.append({ kind: "user", text: `${id} ${"x".repeat(450)}` });
		for (let job = disk.next(); job; job = disk.next())
			disk.put(job.id, job.n, `summary ${job.id}+${job.n} ${"x".repeat(440)}`);
	}
	const lines = disk.context(400, 1);
	assert.ok(lines.length > 20);
	assert.ok(lines.reduce((sum, line) => sum + Buffer.byteLength(line.text) + 24, 0) < 33_000);
	assert.equal(lines[0]?.id, 0);
	assert.equal(lines.at(-1)!.id + lines.at(-1)!.n, 400);
	disk.close();
	disk = new ControlMemoryDisk(dir);
	assert.deepEqual(disk.context(400, 1), lines);
	disk.append({ kind: "user", text: `unbuilt ${"x".repeat(600)}` });
	disk.append({ kind: "user", text: "built after gap" });
	assert.deepEqual(disk.context(402, 1), lines, "context stops at the first unbuilt range");
});
