import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubscriptionUsage } from "@pilot/protocol";
import { refreshSubscriptionPolicy, subscriptionWindowKey, type SubscriptionPolicy } from "./subscription-policy.ts";
import type { SubscriptionUsageSource } from "./subscription-usage.ts";

const now = Date.parse("2026-10-15T12:00:00Z");
const reset = new Date(now + 60_000).toISOString();
const usage = (usedPercent: number, fetchedAt = now, resetsAt: string | undefined = reset): SubscriptionUsage => ({
	provider: "openai",
	fetchedAt,
	windows: [{ label: "5h", usedPercent, ...(resetsAt ? { resetsAt } : {}) }],
});
function source(value?: SubscriptionUsage): SubscriptionUsageSource {
	return { get: (provider) => (provider === "openai" ? value : undefined), start: async () => {}, close() {} };
}

test("95% of any window pauses and a fresh lower reading or reset releases it", () => {
	assert.deepEqual(refreshSubscriptionPolicy(undefined, source(usage(94.99)), now).windows, []);
	const blocked = refreshSubscriptionPolicy(undefined, source(usage(95)), now);
	assert.equal(blocked.windows.length, 1);
	assert.equal(refreshSubscriptionPolicy(blocked, source(usage(94, now + 1)), now + 1).windows.length, 0);
	assert.equal(refreshSubscriptionPolicy(blocked, source(), now + 60_000).windows.length, 0);
	const weekly = usage(30);
	weekly.windows.push({ label: "Week", usedPercent: 96 });
	assert.equal(refreshSubscriptionPolicy(undefined, source(weekly), now).windows[0]?.label, "Week");
	assert.deepEqual(
		refreshSubscriptionPolicy(
			undefined,
			source({ ...usage(1), windows: [{ label: "Extra [enabled]", usedPercent: 100 }] }),
			now,
		).windows,
		[],
		"extra-usage spend is not a subscription window",
	);
});

test("unknown, error, stale and older readings cannot release a known limit", () => {
	const blocked = refreshSubscriptionPolicy(undefined, source(usage(95)), now);
	for (const reading of [
		undefined,
		{ ...usage(5), error: "unavailable" },
		usage(5, now - 1),
		usage(5, now - 120_000),
	]) {
		assert.deepEqual(refreshSubscriptionPolicy(blocked, source(reading), now), blocked);
	}
	assert.equal(refreshSubscriptionPolicy(blocked, source(usage(5, now + 1)), now + 1).windows.length, 0);
});

test("force is scoped to window identity and expires on reset, decrease or a new window", () => {
	const policy = refreshSubscriptionPolicy(undefined, source(usage(95)), now);
	policy.forced = policy.windows.map(subscriptionWindowKey);
	assert.deepEqual(refreshSubscriptionPolicy(policy, source(usage(99, now + 1)), now + 1).forced, policy.forced);
	assert.deepEqual(refreshSubscriptionPolicy(policy, source(), now + 60_000).forced, []);
	assert.deepEqual(refreshSubscriptionPolicy(policy, source(usage(10, now + 1)), now + 1).forced, []);
	const next = refreshSubscriptionPolicy(
		policy,
		source(usage(96, now + 1, new Date(now + 120_000).toISOString())),
		now + 1,
	);
	assert.equal(next.windows.length, 1);
	assert.deepEqual(next.forced, []);
});

test("the durable policy preserves missing-reset pauses and independent provider windows", () => {
	const previous: SubscriptionPolicy = {
		version: 1,
		windows: [{ provider: "anthropic", label: "Week", usedPercent: 96 }],
		forced: [],
		observed: { anthropic: now },
	};
	const both = refreshSubscriptionPolicy(previous, source(usage(95)), now);
	assert.deepEqual(
		both.windows.map((w) => w.provider),
		["anthropic", "openai"],
	);
	assert.equal(refreshSubscriptionPolicy(both, source(), now + 120_000).windows.length, 1);
});
