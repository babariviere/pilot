import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionOutcome } from "@pilot/protocol";
import { applyActivity, applyFailure, type OutcomeMeta } from "./session-outcomes.ts";

test("idle is not a completion, and working clears all public outcome fields", () => {
	const meta: OutcomeMeta = {};
	assert.equal(applyActivity(meta, false), true);
	assert.deepEqual(meta, { working: false });
	applyActivity(meta, false, { outcome: "needs_input", outcomeAt: 42, outcomeReason: "Choose a branch" });
	assert.equal(applyActivity(meta, true, { outcome: "done", outcomeAt: 43 }), true);
	assert.deepEqual(meta, { working: true, lastOutcomeAt: 42, lastCompletionAt: 42 });
	applyActivity(meta, false);
	assert.deepEqual(meta, { working: false, lastOutcomeAt: 42, lastCompletionAt: 42 });
});

test("settled packets persist each explicit outcome and replace obsolete reasons", () => {
	const meta: OutcomeMeta = {};
	const outcomes: SessionOutcome[] = ["done", "needs_input", "failed", "stopped"];
	for (const [index, outcome] of outcomes.entries()) {
		assert.equal(applyActivity(meta, false, { outcome, outcomeAt: index + 1, outcomeReason: "reason" }), true);
		assert.equal(meta.outcome, outcome);
		assert.equal(meta.outcomeAt, index + 1);
	}
	applyActivity(meta, false, { outcome: "done", outcomeAt: 5 });
	assert.equal(meta.outcomeReason, undefined);
});

test("completion replay keeps its version and older recovered completions cannot overwrite newer ones", () => {
	const completion = { outcome: "needs_input" as const, outcomeAt: 100, outcomeReason: "Question" };
	const meta: OutcomeMeta = {};
	applyActivity(meta, false, completion);
	const before = { ...meta };
	assert.equal(applyActivity(meta, false, completion), false);
	assert.equal(applyActivity(meta, false, { outcome: "done", outcomeAt: 99 }), false);
	assert.deepEqual(meta, before);
	applyActivity(meta, true);
	applyActivity(meta, false, completion);
	assert.equal(meta.outcome, undefined, "an old completion cannot reappear after working cleared it");
	applyActivity(meta, false, { outcome: "done", outcomeAt: 101 });
	assert.equal(meta.outcome, "done");
});

test("daemon failures use monotonic versions, even after clearing and clock rollback", () => {
	const meta: OutcomeMeta = { outcome: "done", outcomeAt: 1_000, working: false };
	applyActivity(meta, true);
	assert.equal(applyFailure(meta, "model unavailable", 900), true);
	assert.equal(meta.outcome, "failed");
	assert.equal(meta.outcomeAt, 1_001);
	assert.equal(meta.outcomeReason, "model unavailable");
	assert.equal(meta.working, false);
	assert.equal(applyFailure(meta, "model unavailable", 2_000), false);
	assert.equal(meta.outcomeAt, 1_001);
	assert.equal(meta.outcomeReason, "model unavailable");
	applyActivity(meta, true);
	applyFailure(meta, "second failure", 800);
	assert.equal(meta.outcomeAt, 1_002);
});

test("a new kernel completion is persisted even when its clock is behind a daemon failure", () => {
	const meta: OutcomeMeta = {};
	applyActivity(meta, false, { outcome: "done", outcomeAt: 100 });
	applyFailure(meta, "request error", 1_000);
	const failureVersion = meta.outcomeAt!;
	assert.equal(applyActivity(meta, false, { outcome: "done", outcomeAt: 100 }), false);
	applyActivity(meta, true);
	assert.equal(applyActivity(meta, false, { outcome: "stopped", outcomeAt: 101 }), true);
	assert.ok(meta.outcomeAt! > failureVersion, "new completion advances the public attention version");
	assert.equal(meta.lastCompletionAt, 101, "the source version is retained separately for replay detection");
	const completionVersion = meta.outcomeAt;
	assert.equal(applyActivity(meta, false, { outcome: "stopped", outcomeAt: 101 }), false);
	assert.equal(meta.outcomeAt, completionVersion, "replay preserves the mapped public version");
	applyFailure(meta, "another error", 900);
	assert.equal(meta.outcomeAt, 1_002, "daemon failure versions remain monotonic across clocks");
	const fresh: OutcomeMeta = {};
	applyFailure(fresh, "start failed", 1_000);
	applyActivity(fresh, true);
	applyActivity(fresh, false, { outcome: "done", outcomeAt: 10 });
	assert.equal(fresh.outcome, "done", "a first kernel completion is not confused with the daemon clock");
	assert.equal(fresh.outcomeAt, 1_001, "done advances the version after a startup failure");
	const reopened: OutcomeMeta = JSON.parse(JSON.stringify(fresh));
	assert.equal(applyActivity(reopened, false, { outcome: "done", outcomeAt: 10 }), false);
	assert.equal(reopened.outcomeAt, 1_001, "the mapped public version remains stable after reopen and replay");
});
