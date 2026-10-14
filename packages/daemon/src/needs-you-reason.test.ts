import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary, SubscriptionUsage } from "@pilot/protocol";
import { reasonLine, sessionNeedsYouReason, subscriptionLimit } from "./needs-you-reason.ts";

const session = (extra: Partial<SessionSummary>): SessionSummary => ({
	id: "s",
	title: "Chat",
	cwd: "/tmp",
	state: "idle",
	createdAt: 1,
	updatedAt: 1,
	...extra,
});

test("attention reasons use the first nonempty error or question line and bound long text", () => {
	assert.equal(reasonLine("\n  First error\r\ntrace"), "First error");
	assert.equal(reasonLine(" \n\t"), undefined);
	assert.equal(reasonLine("x".repeat(201)), `${"x".repeat(199)}…`);
	assert.deepEqual(sessionNeedsYouReason(session({ outcome: "failed", outcomeReason: "\nboom\ntrace" })), {
		kind: "failed",
		detail: "boom",
	});
	assert.deepEqual(sessionNeedsYouReason(session({ state: "failed", outcomeReason: " ", error: "crashed\ntrace" })), {
		kind: "failed",
		detail: "crashed",
	});
	assert.deepEqual(sessionNeedsYouReason(session({ outcome: "question", outcomeReason: "Where?\nOptions" })), {
		kind: "asks",
		detail: "Where?",
	});
	assert.deepEqual(sessionNeedsYouReason(session({ outcome: "failed" })), {
		kind: "failed",
		detail: "The chat failed",
	});
	assert.equal(sessionNeedsYouReason(session({ outcome: "question" })).kind, "asks");
	for (const outcome of ["done", "stopped"] as const)
		assert.deepEqual(sessionNeedsYouReason(session({ outcome, outcomeReason: "Stopped by user" })), {
			kind: "not_reviewed",
		});
});

test("a failed chat stopped by a subscription limit reads as Limit reached with when it resumes", () => {
	const now = Date.parse("2026-06-15T12:00:00Z");
	const usage = (windows: SubscriptionUsage["windows"]) => ({
		subscription: { fetchedAt: now, provider: "anthropic" as const, windows },
	});
	const exhausted = session({
		outcome: "failed",
		error: "Request failed",
		usage: usage([
			{ label: "5h", usedPercent: 100, resetsAt: "2026-06-15T18:00:00Z" },
			{ label: "Week", usedPercent: 100, resetsAt: "2026-06-16T09:00:00Z" },
			{ label: "Extra [on] 200.00/200.00", usedPercent: 100 },
		]),
	});
	assert.deepEqual(subscriptionLimit(exhausted, now), { resumesAt: Date.parse("2026-06-16T09:00:00Z") });
	assert.deepEqual(sessionNeedsYouReason(exhausted, now), {
		kind: "limit",
		resumesAt: Date.parse("2026-06-16T09:00:00Z"),
	});
	// The provider's error alone is enough; the reset time is then unknown.
	assert.deepEqual(
		sessionNeedsYouReason(session({ outcome: "failed", outcomeReason: "429 Claude AI usage limit reached" })),
		{ kind: "limit" },
	);
	// Windows that already reset, high but not full windows and spent extra usage are not limits.
	for (const windows of [
		[{ label: "5h", usedPercent: 100, resetsAt: "2026-06-15T11:00:00Z" }],
		[{ label: "5h", usedPercent: 99 }],
		[{ label: "Extra [on] 200.00/200.00", usedPercent: 100 }],
	])
		assert.equal(
			subscriptionLimit(session({ outcome: "failed", error: "boom", usage: usage(windows) }), now),
			undefined,
		);
	// Only failures: a finished chat on an exhausted account is still just not reviewed.
	assert.equal(sessionNeedsYouReason({ ...exhausted, outcome: "done" }, now).kind, "not_reviewed");
});
