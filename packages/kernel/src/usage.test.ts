import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { type ContextView, type EntryId, type EntryRecord, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { SessionUsage } from "@pilot/protocol";
import { contextUsage, subscriptionUsage, UsageTracker } from "./usage.ts";

function assistant(totalTokens = 100): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Answer" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 20,
			output: 10,
			cacheRead: 60,
			cacheWrite: 10,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function view(messages: Message[], headId?: number): ContextView {
	const entries: EntryRecord[] = messages.map((message, i) => ({
		id: (i + 1) as EntryId,
		conversationId: ROOT_CONVERSATION_ID,
		kind: "pi.message",
		model: [message],
	}));
	return {
		entries,
		contributions: entries.map((entry) => entry.model!),
		messages,
		head:
			headId === undefined
				? undefined
				: { id: headId as EntryId, conversationId: ROOT_CONVERSATION_ID, kind: "pi.compaction" },
	};
}

test("context uses the last response including cache tokens, plus trailing message estimates", () => {
	const tail: Message = { role: "user", content: "abcdefgh", timestamp: 2 };
	assert.deepEqual(contextUsage(view([assistant(), tail]), 200), { tokens: 102, contextWindow: 200, percent: 51 });
	assert.equal(contextUsage(view([assistant(0)]), 200)?.tokens, 100);
});

test("new and compacted contexts are estimated without trusting old usage", () => {
	const summary: Message = { role: "user", content: "summary", timestamp: 3 };
	const response = assistant(190_000);
	const compacted = view([summary, response], 3);
	assert.equal(
		contextUsage(compacted, 200_000)?.tokens,
		estimateMessageTokens(summary) + estimateMessageTokens(response),
	);
	const fresh = view([summary, response, assistant(50)], 2);
	assert.equal(contextUsage(fresh, 200_000)?.tokens, 50);
	assert.deepEqual(contextUsage(view([]), 200_000), { tokens: 0, contextWindow: 200_000, percent: 0 });
});

test("unknown model limits are not displayed as zero; overflow percentages are preserved", () => {
	for (const window of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])
		assert.equal(contextUsage(view([assistant()]), window), undefined);
	assert.equal(contextUsage(view([assistant(300)]), 200)?.percent, 150);
});

test("validates Claude and Codex snapshots and forwards only display fields", () => {
	for (const provider of ["anthropic", "openai"]) {
		assert.deepEqual(
			subscriptionUsage({
				fetchedAt: 123,
				secret: "never-forward",
				snapshot: {
					provider,
					token: "never-forward",
					windows: [{ label: "5h", usedPercent: 22.5, resetsAt: "2026-04-01T12:00:00Z", secret: "no" }],
				},
			}),
			{ fetchedAt: 123, provider, windows: [{ label: "5h", usedPercent: 22.5, resetsAt: "2026-04-01T12:00:00Z" }] },
		);
	}
	assert.deepEqual(subscriptionUsage({ fetchedAt: 123, snapshot: { windows: [] } }), { fetchedAt: 123, windows: [] });
	assert.deepEqual(
		subscriptionUsage({ fetchedAt: 123, snapshot: { provider: "openai", windows: [], error: "Unavailable" } }),
		{ fetchedAt: 123, provider: "openai", windows: [], error: "Unavailable" },
	);
});

test("ignores malformed event bus data rather than poisoning client decoding", () => {
	for (const data of [
		null,
		{},
		{ fetchedAt: Number.NaN, snapshot: { windows: [] } },
		{ fetchedAt: 1, snapshot: { windows: [{ label: "5h", usedPercent: Number.POSITIVE_INFINITY }] } },
		{ fetchedAt: 1, snapshot: { windows: [{ label: "5h", usedPercent: -1 }] } },
		{ fetchedAt: 1, snapshot: { windows: [{ label: "5h", usedPercent: 1, resetsAt: 10 }] } },
		{ fetchedAt: 1, snapshot: { windows: [], provider: "other" } },
		{ fetchedAt: 1, snapshot: { windows: [], error: 5 } },
	])
		assert.equal(subscriptionUsage(data), undefined);
});

test("usage tracker merges, deduplicates, clears and protects snapshots from mutation", () => {
	const changes: SessionUsage[] = [];
	const tracker = new UsageTracker((usage) => changes.push(usage));
	const context = { tokens: 100, contextWindow: 200, percent: 50 };
	tracker.setContext(context);
	tracker.setContext({ ...context });
	tracker.receive({
		fetchedAt: 1,
		snapshot: { provider: "anthropic", windows: [{ label: "Week", usedPercent: 10 }] },
	});
	assert.equal(changes.length, 2);
	context.tokens = 999;
	changes[1]!.subscription!.windows[0]!.usedPercent = 999;
	assert.equal(tracker.current.context?.tokens, 100);
	assert.equal(tracker.current.subscription?.windows[0]?.usedPercent, 10);
	tracker.receive({ fetchedAt: 2, snapshot: { provider: "openai", windows: [] } });
	assert.equal(tracker.current.subscription?.provider, "openai");
	tracker.receive({ fetchedAt: 3, snapshot: { windows: [] } });
	assert.equal(tracker.current.subscription?.provider, undefined);
	tracker.setContext(undefined);
	assert.equal(tracker.current.context, undefined);
	tracker.receive(null);
	assert.equal(changes.length, 5);
});
