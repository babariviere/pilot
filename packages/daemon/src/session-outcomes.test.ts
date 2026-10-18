import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionCompletion, SessionOutcome } from "@pilot/protocol";
import { formatFailure } from "@pilot/kernel";
import { applyActivity, applyFailure, normalizeLegacyOutcome, type OutcomeMeta } from "./session-outcomes.ts";

test("diagnostic completions persist redacted causes, survive JSON reload and clear on new work", () => {
	const reason = formatFailure(
		new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect token=hidden"), {
				code: "ECONNRESET",
				host: "api.example.com",
				syscall: "connect",
			}),
		}),
		"Model request",
	);
	const meta: OutcomeMeta = {};
	applyActivity(meta, false, { outcome: "failed", outcomeAt: 42, outcomeReason: reason });
	const reopened: OutcomeMeta = JSON.parse(JSON.stringify(meta));
	assert.equal(reopened.outcomeReason, reason);
	assert.match(reopened.outcomeReason!, /Retryable network error.*ECONNRESET.*host=api.example.com.*syscall=connect/);
	assert.doesNotMatch(reopened.outcomeReason!, /hidden/);
	assert.equal(applyActivity(reopened, false, { outcome: "failed", outcomeAt: 42, outcomeReason: reason }), false);
	applyActivity(reopened, true);
	assert.equal(reopened.outcomeReason, undefined);
	applyFailure(reopened, `password=hidden ${"x".repeat(2000)}`, 43);
	assert.doesNotMatch(reopened.outcomeReason!, /hidden/);
	assert.ok(String(reopened.outcomeReason).length <= 1600);
});

test("legacy persisted outcomes normalize without changing versions or unrelated metadata", () => {
	const legacy = {
		outcome: "needs_input",
		outcomeReason: "Choose a branch",
		outcomeAt: 42,
		lastOutcomeAt: 50,
		lastCompletionAt: 42,
		working: false,
	};
	normalizeLegacyOutcome(legacy);
	assert.deepEqual(legacy, {
		outcome: "done",
		outcomeAt: 42,
		lastOutcomeAt: 50,
		lastCompletionAt: 42,
		working: false,
	});
	for (const outcome of ["done", "failed", "stopped"] as const) {
		const meta = { outcome, outcomeAt: 42, outcomeReason: "Preserved reason" };
		normalizeLegacyOutcome(meta);
		assert.deepEqual(meta, { outcome, outcomeAt: 42, outcomeReason: "Preserved reason" });
	}
});

test("legacy cold completions normalize before publication and retain replay guards", () => {
	const completion = JSON.parse(
		'{"outcome":"needs_input","outcomeAt":42,"outcomeReason":"Question","input":1,"entry":2}',
	) as SessionCompletion;
	const meta: OutcomeMeta = {};
	assert.equal(applyActivity(meta, false, completion), true);
	assert.deepEqual(meta, {
		working: false,
		outcome: "done",
		outcomeAt: 42,
		lastOutcomeAt: 42,
		lastCompletionAt: 42,
	});
	assert.equal(completion.outcomeReason, "Question", "normalization does not mutate the cold cache");
	assert.equal(applyActivity(meta, false, completion), false);
	applyActivity(meta, true);
	applyActivity(meta, false, completion);
	assert.equal(meta.outcome, undefined, "replayed legacy completions cannot resurrect cleared attention");
});

test("idle is not a completion, and working clears all public outcome fields", () => {
	const meta: OutcomeMeta = {};
	assert.equal(applyActivity(meta, false), true);
	assert.deepEqual(meta, { working: false });
	applyActivity(meta, false, { outcome: "done", outcomeAt: 42, outcomeReason: "Choose a branch" });
	assert.equal(applyActivity(meta, true, { outcome: "done", outcomeAt: 43 }), true);
	assert.deepEqual(meta, { working: true, lastOutcomeAt: 42, lastCompletionAt: 42 });
	applyActivity(meta, false);
	assert.deepEqual(meta, { working: false, lastOutcomeAt: 42, lastCompletionAt: 42 });
});

test("job-waiting completions are consumed rather than deferred or replayed after restart", () => {
	const meta: OutcomeMeta = {};
	applyActivity(meta, true);
	const completion: SessionCompletion = { outcome: "done", outcomeAt: 42 };
	assert.equal(applyActivity(meta, false, completion, true), true);
	assert.equal(meta.working, false, "kernel activity remains independent of user-visible background work");
	assert.equal(meta.outcome, undefined);
	assert.equal(meta.lastCompletionAt, 42);
	const reopened: OutcomeMeta = JSON.parse(JSON.stringify(meta));
	assert.equal(applyActivity(reopened, false, completion), false);
	assert.equal(reopened.outcome, undefined);
	applyActivity(reopened, true);
	applyActivity(reopened, false, { outcome: "done", outcomeAt: 43 });
	assert.equal(reopened.outcome, "done");
	assert.equal(reopened.outcomeAt, 43);
});

test("a question waits on the user while background work continues", () => {
	const meta: OutcomeMeta = {};
	applyActivity(meta, true);
	const completion: SessionCompletion = { outcome: "question", outcomeAt: 42, outcomeReason: "Which branch?" };
	assert.equal(applyActivity(meta, false, completion, true), true);
	assert.equal(meta.outcome, "question");
	assert.equal(meta.outcomeAt, 42);
	assert.equal(meta.outcomeReason, "Which branch?");
	// Later job or subagent updates keep the question until the agent works again.
	assert.equal(applyActivity(meta, false, undefined, true), false);
	assert.equal(applyActivity(meta, false, completion, true), false);
	assert.equal(meta.outcome, "question");
	applyActivity(meta, true);
	assert.equal(meta.outcome, undefined);
	assert.equal(meta.lastCompletionAt, 42);
});

test("settled packets persist each explicit outcome and replace obsolete reasons", () => {
	const meta: OutcomeMeta = {};
	const outcomes: SessionOutcome[] = ["done", "failed", "stopped"];
	for (const [index, outcome] of outcomes.entries()) {
		assert.equal(applyActivity(meta, false, { outcome, outcomeAt: index + 1, outcomeReason: "reason" }), true);
		assert.equal(meta.outcome, outcome);
		assert.equal(meta.outcomeAt, index + 1);
	}
	applyActivity(meta, false, { outcome: "done", outcomeAt: 5 });
	assert.equal(meta.outcomeReason, undefined);
});

test("completion replay keeps its version and older recovered completions cannot overwrite newer ones", () => {
	const completion = { outcome: "done" as const, outcomeAt: 100, outcomeReason: "Question" };
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
