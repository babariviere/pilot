import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fundingOutputBound, fundingOutputLimit, installFundingRuntime } from "./funding-runtime.ts";

test("final physical payload must have a supported output bound", () => {
	assert.equal(fundingOutputBound("anthropic-messages", { max_tokens: 32 }), 32);
	// Pay-per-token APIs keep needing a payload cap, even when the model maximum is known.
	for (const api of ["openai-responses", "openai-completions", "anthropic-messages", "google-generative-ai"])
		assert.throws(() => fundingOutputBound(api, { model: "m" }, "m", 128_000), /no verified/);
	// The Codex backend refuses a request cap, so the model's own output maximum is its bound.
	assert.equal(fundingOutputBound("openai-codex-responses", { model: "m" }, "m", 128_000), 128_000);
	for (const max of [undefined, 0, NaN])
		assert.throws(() => fundingOutputBound("openai-codex-responses", { model: "m" }, "m", max), /no verified/);
	assert.throws(
		() => fundingOutputBound("openai-codex-responses", { model: "m", tools: [{ type: "web_search" }] }, "m", 9),
		/hosted-tool/,
	);
	assert.throws(() => fundingOutputBound("openai-codex-responses", { model: "x" }, "m", 9), /changed the priced/);
	assert.throws(
		() => fundingOutputBound("anthropic-messages", { model: "other", max_tokens: 32 }, "chosen"),
		/changed the priced model/,
	);
	assert.throws(
		() => fundingOutputBound("anthropic-messages", { max_tokens: 32, fallbacks: [{ model: "other" }] }),
		/fallback model prices/,
	);
	for (const value of [null, {}, { max_tokens: NaN }, { max_tokens: 0 }])
		assert.throws(() => fundingOutputBound("anthropic-messages", value), /no verified/);
});
test("real SDK HTTP boundary reserves after payload hooks, settles once and refuses unfunded sends", async () => {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
	});
	const model = runtime.getModels("anthropic")[0]!;
	let sends = 0,
		reserves = 0,
		settlements = 0,
		blocked = false;
	const order: string[] = [];
	installFundingRuntime(runtime, {
		reserve: async (_id, physical, output) => {
			assert.equal(physical.id, model.id);
			assert.deepEqual(output, { outputTokens: 17 });
			order.push("reserve");
			reserves++;
			if (blocked) throw new Error("Allowance exhausted");
		},
		settle: async (_id, usage) => {
			settlements++;
			assert.equal(usage.input, 10);
			assert.equal(usage.output, 2);
			order.push("settle");
		},
	});
	const events = [
		{
			type: "message_start",
			message: {
				id: "offline",
				type: "message",
				role: "assistant",
				model: model.id,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	];
	const options = {
		apiKey: "sk-ant-api03-offline-fixture",
		maxTokens: 16,
		maxRetries: 5,
		onPayload: (p: unknown) => {
			order.push("hook");
			return { ...(p as object), max_tokens: 17 };
		},
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			sends++;
			order.push("http");
			const body = (await new Request(input, init).json()) as { max_tokens: number };
			assert.equal(body.max_tokens, 17);
			return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	};
	const result = await runtime.completeSimple(
		{ ...model, baseUrl: "https://example.invalid" },
		{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
		options,
	);
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "unexpected provider stop reason");
	assert.deepEqual(order, ["hook", "reserve", "http", "settle"]);
	blocked = true;
	const denied = await runtime.completeSimple(model, { messages: [] }, options);
	assert.equal(denied.stopReason, "error");
	assert.match(denied.errorMessage!, /Allowance exhausted/);
	assert.equal(sends, 1);
	assert.equal(reserves, 2);
	assert.equal(settlements, 1);
});

test("real SDK Codex boundary reserves the model output maximum after payload hooks", async () => {
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } }));
	const credentials = new InMemoryCredentialStore();
	// Codex is a ChatGPT subscription: only an OAuth token configures it.
	await credentials.modify("openai-codex", async () => ({
		type: "oauth",
		access: `x.${claims.toString("base64url")}.y`,
		refresh: "offline",
		expires: Date.now() + 3_600_000,
	}));
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
	});
	const model = runtime.getModels("openai-codex")[0]!;
	assert.equal(model.api, "openai-codex-responses");
	const order: string[] = [];
	let settled: unknown;
	installFundingRuntime(runtime, {
		reserve: async (_id, physical, output) => {
			assert.equal(physical.id, model.id);
			assert.deepEqual(output, { outputTokens: model.maxTokens });
			order.push("reserve");
		},
		settle: async (_id, usage) => {
			settled = usage;
			order.push("settle");
		},
	});
	const events = [
		{ type: "response.created", response: { id: "resp_offline" } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Done" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Done" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_offline",
				status: "completed",
				usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	const result = await runtime.completeSimple(
		{ ...model, baseUrl: "https://example.invalid" },
		{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
		{
			transport: "sse",
			maxTokens: 16,
			onPayload: (p: unknown) => {
				order.push("hook");
				return p;
			},
			fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
				order.push("http");
				const raw = Buffer.from(init!.body as Uint8Array);
				const body = JSON.parse(
					new Headers(init!.headers).get("content-encoding") === "zstd"
						? zstdDecompressSync(raw).toString()
						: raw.toString(),
				) as Record<string, unknown>;
				assert.equal(body.model, model.id);
				assert.equal("max_output_tokens" in body, false, "the Codex backend rejects a request cap");
				return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		},
	);
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "unexpected provider stop reason");
	assert.deepEqual(order, ["hook", "reserve", "http", "settle"]);
	assert.deepEqual(settled, { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test("a request without an output cap reaches the daemon, which decides whether to hold it", async () => {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
	});
	const model = runtime.getModels("anthropic")[0]!;
	let limitsOn = false,
		sends = 0;
	const bounds: unknown[] = [];
	installFundingRuntime(runtime, {
		// Stands in for the daemon: limits off skip every request; limits on refuse a hold.
		reserve: async (_id, _physical, bound) => {
			bounds.push(bound);
			if (limitsOn && "hold" in bound) throw new Error(bound.hold);
		},
		settle: async () => {},
	});
	const options = {
		apiKey: "sk-ant-api03-offline-fixture",
		onPayload: (p: unknown) => {
			const { max_tokens: _, ...rest } = p as Record<string, unknown>;
			return rest;
		},
		fetch: async () => {
			sends++;
			return new Response("{}", { status: 500 });
		},
	};
	const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
	await runtime.completeSimple({ ...model, baseUrl: "https://example.invalid" }, context, options);
	assert.equal(sends, 1, "limits off: the request is sent");
	assert.match((bounds[0] as { hold: string }).hold, /no verified output bound/);
	limitsOn = true;
	const held = await runtime.completeSimple({ ...model, baseUrl: "https://example.invalid" }, context, options);
	assert.match(held.errorMessage!, /no verified output bound/);
	assert.equal(sends, 1, "limits on: held before HTTP");
});

test("a caller's output limit (clarification) is held only while limits are on", async () => {
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } }));
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai-codex", async () => ({
		type: "oauth",
		access: `x.${claims.toString("base64url")}.y`,
		refresh: "offline",
		expires: Date.now() + 3_600_000,
	}));
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
	});
	const model = { ...runtime.getModels("openai-codex")[0]!, baseUrl: "https://example.invalid" };
	let limitsOn = false,
		sends = 0;
	installFundingRuntime(runtime, {
		reserve: async (_id, _physical, bound) => {
			if (limitsOn && "hold" in bound) throw new Error(bound.hold);
		},
		settle: async () => {},
	});
	// Codex cannot cap output, so its model maximum is larger than the clarification limit.
	const options = {
		transport: "sse" as const,
		maxTokens: 1024,
		[fundingOutputLimit]: 1024,
		fetch: async () => {
			sends++;
			return new Response("{}", { status: 500 });
		},
	};
	const context = { messages: [{ role: "user" as const, content: "Why?", timestamp: 1 }] };
	await runtime.completeSimple(model, context, options);
	assert.equal(sends, 1, "limits off: the clarification is sent");
	limitsOn = true;
	const held = await runtime.completeSimple(model, context, options);
	assert.match(held.errorMessage!, /output limit is 1024 tokens; got 128000/);
	assert.equal(sends, 1, "limits on: held before HTTP");
});
