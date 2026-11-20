import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { type ContextView, type EntryId, type EntryRecord, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { aiUsageConversation, contextUsage, type KernelUsage, UsageTracker } from "./usage.ts";

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
	// Pi 1.1 estimates text at 3.5 characters/token, rounded up.
	assert.deepEqual(contextUsage(view([assistant(), tail]), 200), { tokens: 103, contextWindow: 200, percent: 51.5 });
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

test("usage tracker deduplicates, clears and protects reports from mutation", () => {
	const changes: KernelUsage[] = [];
	const tracker = new UsageTracker((usage) => changes.push(usage));
	const context = { tokens: 100, contextWindow: 200, percent: 50 };
	tracker.set(context, "anthropic");
	tracker.set({ ...context }, "anthropic");
	assert.equal(changes.length, 1);
	context.tokens = 999;
	changes[0]!.context!.tokens = 999;
	assert.deepEqual(tracker.current, {
		context: { tokens: 100, contextWindow: 200, percent: 50 },
		provider: "anthropic",
	});
	tracker.set(undefined, "openai-codex");
	assert.deepEqual(tracker.current, { provider: "openai-codex" });
	tracker.set(undefined, undefined);
	assert.deepEqual(tracker.current, {});
	assert.equal(changes.length, 3);
});

test("AI accounting aggregates authoritative ledgers without provider or model dimensions", () => {
	const success = assistant();
	const failure = { ...assistant(), stopReason: "error" as const };
	const child: Message = {
		role: "toolResult",
		toolCallId: "call",
		toolName: "subagent-private-name",
		content: [],
		isError: false,
		timestamp: 2,
		usage: {
			input: 5,
			output: 3,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const report = aiUsageConversation(
		view([success, failure, child]),
		ROOT_CONVERSATION_ID,
		{
			models: {
				"secret-provider/secret-model": {
					input: 40,
					output: 20,
					cacheRead: 120,
					cacheWrite: 20,
					reasoning: 5,
					totalTokens: 200,
					cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
				},
				"tokenless-priced-operation": {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					reasoning: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
				},
			},
			tools: {
				"subagent-private-name": child.usage!,
			},
		},
		"boot-private",
		{
			direct: {
				providerAttemptsObserved: 3,
				requestRetriesObserved: 1,
				elapsedMsObserved: 500,
				activeMsObserved: 400,
			},
			child: {
				providerAttemptsObserved: 1,
				requestRetriesObserved: 0,
				elapsedMsObserved: 100,
				activeMsObserved: 80,
			},
		},
		10_000,
	);
	assert.deepEqual(report.direct.tokens, {
		input: 40,
		output: 20,
		cacheRead: 120,
		cacheWrite: 20,
		reasoning: 5,
		reasoningStatus: "reported",
	});
	assert.equal(report.direct.activity.count, 2);
	assert.equal(report.direct.activity.success, 1);
	assert.equal(report.direct.activity.failure, 1);
	assert.equal(report.direct.activity.providerAttemptsObserved, 3);
	assert.equal(report.direct.activity.requestRetriesObserved, 1);
	assert.equal(report.epochKind, "initial");
	assert.equal(report.direct.cost.estimateStatus, "catalog_estimate");
	assert.equal(report.direct.cost.estimatedUsdMicros, 87_000);
	assert.equal(report.direct.cost.billedStatus, "unavailable");
	assert.equal(report.child.activity.kind, "child_operations");
	assert.equal(report.child.activity.count, 1);
	assert.equal(report.child.cost.estimateStatus, "unavailable", "zero cannot imply free or subscription-covered");
	assert.equal(report.child.cost.estimatedUsdMicros, undefined);
	assert.equal(report.child.cost.subscriptionCoverage, "unknown");
	assert.doesNotMatch(JSON.stringify(report), /secret-provider|secret-model|subagent-private-name|tokenless-priced/);
});

test("accounting classifies only explicit compaction heads as compaction epochs", () => {
	const tracker = new UsageTracker(() => {});
	tracker.set(undefined, undefined, {
		conversationId: ROOT_CONVERSATION_ID,
		observedAt: 1,
		view: view([]),
		state: { models: {}, tools: {} },
	});
	assert.equal(tracker.current.accounting?.epochKind, "initial");
	tracker.set(undefined, undefined, {
		conversationId: ROOT_CONVERSATION_ID,
		observedAt: 2,
		view: view([], 3),
		state: { models: {}, tools: {} },
	});
	assert.equal(tracker.current.accounting?.epochKind, "compaction");
});

test("request timing remains explicitly partial and deduplicates unchanged publications", () => {
	const changes: KernelUsage[] = [];
	const tracker = new UsageTracker((usage) => changes.push(usage));
	tracker.set(undefined, undefined, {
		conversationId: ROOT_CONVERSATION_ID,
		observedAt: 1,
		view: view([]),
		state: { models: {}, tools: {} },
	});
	tracker.recordRequest({
		v: 1,
		request: 1,
		at: 1,
		source: "generation",
		outcome: "aborted",
		preparationMs: 20,
		providerMs: 80,
		totalMs: 100,
		httpAttempts: 2,
	});
	assert.equal(tracker.current.accounting?.direct.activity.providerAttemptsObserved, 2);
	assert.equal(tracker.current.accounting?.direct.activity.requestRetriesObserved, 1);
	assert.equal(tracker.current.accounting?.direct.activity.elapsedMsObserved, 100);
	assert.equal(tracker.current.accounting?.direct.activity.activeMsObserved, 80);
	assert.equal(tracker.current.accounting?.direct.activity.timingCoverage, "partial");
	assert.equal(changes.length, 2);
});
