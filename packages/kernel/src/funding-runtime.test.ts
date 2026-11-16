import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fundingOutputBound, installFundingRuntime } from "./funding-runtime.ts";

test("final physical payload must have a supported output bound", () => {
	assert.equal(fundingOutputBound("anthropic-messages", { max_tokens: 32 }), 32);
	assert.throws(() => fundingOutputBound("openai-codex-responses", { max_output_tokens: 32 }), /no verified/);
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
			assert.equal(output, 17);
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
