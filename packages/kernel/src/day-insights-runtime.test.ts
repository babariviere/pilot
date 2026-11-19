import assert from "node:assert/strict";
import { test } from "node:test";
import { SubscriptionGate } from "@babariviere/pi-extensions/subscription-gate";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installDayInsightsRuntime } from "./day-insights-runtime.ts";

test("Insights kernel refuses provider dispatch without both exact reservations", async () => {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
	});
	const model = runtime.getModels("anthropic")[0]!;
	let sends = 0,
		reserves = 0;
	installDayInsightsRuntime(runtime, {
		reserve: async (id) => {
			reserves++;
			return { requestId: `${id}-wrong`, perReportReserved: true, monthlyReserved: true };
		},
		settle: async () => {
			assert.fail("Unsent request cannot settle");
		},
	});
	const result = await runtime.completeSimple(
		model,
		{ messages: [] },
		{
			apiKey: "synthetic-not-a-key",
			maxTokens: 16,
			fetch: async () => {
				sends++;
				throw new Error("No real network");
			},
		},
	);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /both reservations/);
	assert.equal(reserves, 1);
	assert.equal(sends, 0);
});

test("Day subscription waits precede final admission and cancellation cannot reserve afterward", async (t) => {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		refreshOnCreate: false,
	});
	const model = runtime.getModels("anthropic")[0]!;
	const order: string[] = [];
	t.mock.method(SubscriptionGate.prototype, "wait", async () => {
		order.push("wait");
	});
	installDayInsightsRuntime(runtime, {
		reserve: async () => {
			order.push("reserve");
			throw new Error("Eligibility changed during subscription wait");
		},
		settle: async () => {
			assert.fail("No dispatch");
		},
	});
	const result = await runtime.completeSimple(
		model,
		{ messages: [] },
		{
			apiKey: "synthetic",
			maxTokens: 16,
			fetch: async () => {
				assert.fail("No provider dispatch");
			},
		},
	);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(order, ["wait", "reserve"]);
	const controller = new AbortController();
	t.mock.method(SubscriptionGate.prototype, "wait", async () => {
		controller.abort();
	});
	order.length = 0;
	const cancelled = await runtime.completeSimple(
		model,
		{ messages: [] },
		{
			apiKey: "synthetic",
			maxTokens: 16,
			signal: controller.signal,
			fetch: async () => {
				assert.fail("No provider dispatch after cancellation");
			},
		},
	);
	assert.equal(cancelled.stopReason, "aborted");
	assert.deepEqual(order, []);
});
