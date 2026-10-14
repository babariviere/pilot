import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { reasonLine, sessionNeedsYouReason } from "./needs-you-reason.ts";

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
