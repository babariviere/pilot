import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolActivityCall, ToolActivitySnapshot } from "@pilot/protocol";
import {
	assessToolCall,
	nextToolStallAt,
	TOOL_CANCELLATION_DELAY_MS,
	TOOL_LIVENESS_STALE_MS,
	ToolStallWatchdog,
	toolStallAttention,
} from "./tool-stalls.ts";

function call(overrides: Partial<ToolActivityCall> = {}): ToolActivityCall {
	return {
		ref: "abcdef012345-1",
		category: "mcp",
		nested: true,
		state: "running",
		startedAt: 1_000,
		progressAt: 1_000,
		livenessAt: 1_000,
		...overrides,
	};
}

const context = { pauses: [], runningJobs: 0 } as const;

test("classifies useful-progress, liveness and cancellation delays independently", () => {
	const noProgress = assessToolCall(call({ livenessAt: 601_001 }), 601_001, context, 601_001);
	assert.equal(noProgress.assessment, "suspected_no_progress");
	assert.equal(noProgress.thresholdMs, 10 * 60_000);

	const unresponsive = assessToolCall(call(), 1_000, context, 1_000 + TOOL_LIVENESS_STALE_MS);
	assert.equal(unresponsive.assessment, "suspected_unresponsive");

	const cancelling = assessToolCall(
		call({ state: "cancelling", cancelRequestedAt: 2_000, livenessAt: 99_000 }),
		99_000,
		context,
		2_000 + TOOL_CANCELLATION_DELAY_MS,
	);
	assert.equal(cancelling.assessment, "suspected_cancellation_delay");
});

test("explicit waits, background jobs and session pauses do not become no-progress stalls", () => {
	assert.equal(
		assessToolCall(call({ waitKind: "user", livenessAt: 999_999 }), 999_999, context, 999_999).assessment,
		"waiting_user",
	);
	assert.equal(
		assessToolCall(
			call({ category: "background", waitKind: "background", livenessAt: 999_999 }),
			999_999,
			{ pauses: [], runningJobs: 1 },
			999_999,
		).assessment,
		"background_work",
	);
	for (const pause of ["sleep", "update", "quota", "connectivity", "user"] as const) {
		assert.equal(
			assessToolCall(call({ livenessAt: 999_999 }), 999_999, { pauses: [pause], runningJobs: 0 }, 999_999)
				.assessment,
			`paused_${pause}`,
		);
	}
	assert.equal(
		assessToolCall(
			call({ state: "cancelling", cancelRequestedAt: 2_000 }),
			999_999,
			{ pauses: ["sleep"], runningJobs: 0 },
			999_999,
		).assessment,
		"paused_sleep",
		"an explicit pause explains even an overdue cancellation until the session resumes",
	);
});

test("attention is bounded to categories and the next deadline needs no polling", () => {
	const snapshot: ToolActivitySnapshot = {
		enabled: true,
		observedAt: 700_000,
		dropped: 0,
		calls: [call({ livenessAt: 700_000 })],
	};
	const attention = toolStallAttention(snapshot, context, 700_000);
	assert.equal(attention?.assessment, "suspected_no_progress");
	assert.match(attention?.reason.detail ?? "", /^A mcp tool/);
	assert.doesNotMatch(attention?.reason.detail ?? "", /abcdef|server|argument/);
	assert.equal(
		toolStallAttention({ ...snapshot, calls: [call({ category: "raw-secret-tool" as never })] }, context, 700_000),
		undefined,
		"unexpected child categories cannot cross the observer boundary",
	);

	const fresh = { ...snapshot, observedAt: 1_100, calls: [call({ livenessAt: 1_100 })] };
	assert.equal(nextToolStallAt(fresh, context, 1_100), 1_100 + TOOL_LIVENESS_STALE_MS);
});

test("watchdog coalesces deadlines into a due notification", async () => {
	const watchdog = new ToolStallWatchdog();
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("watchdog did not fire")), 1_000);
		watchdog.update("later", Date.now() + 500, () => assert.fail("later deadline fired first"));
		watchdog.update("due", Date.now() - 1, (id) => {
			clearTimeout(timeout);
			assert.equal(id, "due");
			resolve();
		});
	});
	watchdog.close();
});
