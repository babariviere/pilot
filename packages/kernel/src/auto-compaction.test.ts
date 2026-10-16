import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { autoCompactionThreshold, promptCacheLifetimeMs, shouldAutoCompact } from "./auto-compaction.ts";

const MINUTE = 60_000;
const assistant = (api: string, timestamp: number, durationMs?: number) => ({
	...fauxAssistantMessage("Answer", { timestamp }),
	api,
	...(durationMs === undefined ? {} : { durationMs }),
});

test("threshold is 40% of the window, capped at 100k tokens", () => {
	assert.equal(autoCompactionThreshold(200_000), 80_000);
	assert.equal(autoCompactionThreshold(1_000_000), 100_000);
});

test("cache lifetimes follow the provider and PI_CACHE_RETENTION, erring long", () => {
	assert.equal(promptCacheLifetimeMs("anthropic-messages", {}), 5 * MINUTE);
	assert.equal(promptCacheLifetimeMs("anthropic-messages", { PI_CACHE_RETENTION: "long" }), 60 * MINUTE);
	assert.equal(promptCacheLifetimeMs("openai-codex-responses", {}), 10 * MINUTE);
	assert.equal(promptCacheLifetimeMs("openai-responses", { PI_CACHE_RETENTION: "long" }), 24 * 60 * MINUTE);
	assert.equal(promptCacheLifetimeMs("google-generative-ai", {}), 60 * MINUTE);
});

test("compacts only a long context whose cache has expired", () => {
	const now = 10 * 60 * MINUTE;
	const big = { tokens: 90_000, contextWindow: 200_000 };
	const cold = [assistant("anthropic-messages", now - 6 * MINUTE)];
	assert.equal(shouldAutoCompact(cold, big, now, {}), true);
	assert.equal(shouldAutoCompact(cold, { tokens: 70_000, contextWindow: 200_000 }, now, {}), false, "short context");
	assert.equal(shouldAutoCompact(cold, { contextWindow: 200_000 }, now, {}), false, "unknown size");
	assert.equal(shouldAutoCompact(cold, undefined, now, {}), false, "unknown window");
	assert.equal(shouldAutoCompact([assistant("anthropic-messages", now - 4 * MINUTE)], big, now, {}), false, "warm");
	assert.equal(
		shouldAutoCompact([assistant("anthropic-messages", now - 6 * MINUTE, 2 * MINUTE)], big, now, {}),
		false,
		"the cache was last used when the response ended",
	);
	assert.equal(shouldAutoCompact(cold, big, now, { PI_CACHE_RETENTION: "long" }), false, "long retention");
	assert.equal(shouldAutoCompact([], big, now, {}), false, "no model request yet");
});
