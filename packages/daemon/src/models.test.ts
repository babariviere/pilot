import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { cheapestTitleModel, generateChatTitle, ModelCatalog } from "./models.ts";

type Model = Parameters<ModelRuntime["completeSimple"]>[0];
const model = (id: string, input: number, output: number): Model => ({
	id,
	name: id,
	provider: "test",
	api: "openai-completions",
	baseUrl: "http://unused",
	input: ["text"],
	reasoning: true,
	contextWindow: 32000,
	maxTokens: 4096,
	cost: { input, output, cacheRead: 0, cacheWrite: 0 },
});
const expensive = model("large", 3, 15);
const cheap = model("small", 0.1, 0.4);

function answer(
	text: string,
	stopReason: "stop" | "error" | "aborted" = "stop",
): Awaited<ReturnType<ModelRuntime["completeSimple"]>> {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "test",
		model: "small",
		content: [
			{ type: "thinking", thinking: "Not part of the title" },
			{ type: "text", text },
		],
		stopReason,
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

test("title selection compares input plus output prices, including free models and stable ties", () => {
	assert.equal(cheapestTitleModel([expensive, cheap]), cheap);
	const free = model("free", 0, 0);
	assert.equal(cheapestTitleModel([cheap, free]), free);
	assert.equal(cheapestTitleModel([cheap, model("tie", 0.1, 0.4)]), cheap);
	assert.equal(cheapestTitleModel([]), undefined);
});

test("title completion is bounded, tool-free and runs with no reasoning", async () => {
	const signal = new AbortController().signal;
	const title = await generateChatTitle(
		{
			completeSimple: async (chosen, context, options) => {
				assert.equal(chosen, cheap);
				assert.equal(options?.reasoning, undefined);
				assert.equal(options?.maxTokens, 128);
				assert.equal(options?.maxRetries, 0);
				assert.equal(options?.signal, signal);
				assert.equal(context.tools, undefined);
				assert.equal(context.messages.length, 1);
				assert.equal(context.messages[0]!.content.length, 4000);
				return answer('  "Fix branch naming"\nExplanation  ');
			},
		},
		[expensive, cheap],
		"a".repeat(6000),
		signal,
	);
	assert.equal(title, "Fix branch naming");
});

test("empty scope and failed or empty completions leave title unset", async () => {
	assert.equal(
		await generateChatTitle(
			{
				completeSimple: async () => {
					throw new Error("must not run");
				},
			},
			[],
			"task",
		),
		undefined,
	);
	for (const result of [answer(""), answer("Bad title", "error"), answer("Bad title", "aborted")]) {
		assert.equal(await generateChatTitle({ completeSimple: async () => result }, [cheap], "task"), undefined);
	}
	assert.equal(
		(await generateChatTitle({ completeSimple: async () => answer("a".repeat(80)) }, [cheap], "task"))?.length,
		60,
	);
});

test("title generation follows project model scope, ignores its thinking suffix and never falls outside it", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-title-models-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir);
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["test/large"] }));
	await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["test/small:high"] }));
	const calls: Model[] = [];
	const runtime = {
		getAvailable: async () => [expensive, cheap, model("outside-scope", 0, 0)],
		completeSimple: async (chosen: Model, _context: unknown, options: { reasoning?: string }) => {
			calls.push(chosen);
			assert.equal(options.reasoning, undefined);
			return answer("Short title");
		},
	} as unknown as ModelRuntime;
	t.mock.method(ModelRuntime, "create", async () => runtime);
	t.after(() => rm(root, { recursive: true, force: true }));
	const catalog = new ModelCatalog(agentDir);
	assert.equal(await catalog.generateTitle(cwd, "task"), "Short title");
	assert.deepEqual(calls, [cheap]);
	assert.deepEqual(
		(await catalog.list(cwd)).models.map((entry) => entry.id),
		["test/small"],
	);
	await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["missing/*"] }));
	assert.equal(await catalog.generateTitle(cwd, "task"), undefined);
	assert.equal(calls.length, 1);
});

test("model catalog offers only levels supported by each model, including mapped extended levels", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-thinking-models-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const mapped = {
		...model("mapped", 0, 0),
		thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
	};
	const plain = { ...model("plain", 0, 0), reasoning: false };
	t.mock.method(
		ModelRuntime,
		"create",
		async () =>
			({
				getAvailable: async () => [cheap, mapped, plain],
			}) as unknown as ModelRuntime,
	);
	const list = await new ModelCatalog(root).list(root);
	assert.deepEqual(
		list.models.map(({ id, thinkingLevels }) => ({ id, thinkingLevels })),
		[
			{ id: "test/small", thinkingLevels: ["off", "minimal", "low", "medium", "high"] },
			{ id: "test/mapped", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
			{ id: "test/plain", thinkingLevels: ["off"] },
		],
	);
});
