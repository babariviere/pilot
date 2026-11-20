import assert from "node:assert/strict";
import { test } from "node:test";
import { noProblems } from "./github.ts";
import { mergeReadiness, readinessReasonLabel } from "./pull-request-readiness.ts";

const open = { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: null, mergeStateStatus: "CLEAN" };

test("ready requires a non-draft open PR and explicit positive health", () => {
	assert.deepEqual(mergeReadiness(open, noProblems(), false, 42), { state: "ready", reasons: [], checkedAt: 42 });
	assert.equal(mergeReadiness({ ...open, reviewDecision: "APPROVED" }, noProblems(), false)?.state, "ready");
	for (const state of ["CLOSED", "MERGED"])
		assert.equal(mergeReadiness({ ...open, state }, noProblems(), false), undefined);
});

test("each known reason blocks, preserves evidence and has a dashboard label", () => {
	const cases = [
		{
			problems: { ...noProblems(), failedChecks: ["build", "test"] },
			reason: { code: "failing_checks", names: ["build", "test"] },
		},
		{ problems: { ...noProblems(), reviewComments: 3 }, reason: { code: "unresolved_comments", count: 3 } },
		{ problems: { ...noProblems(), mergeConflicts: true }, reason: { code: "conflicts" } },
		{ pr: { mergeable: "CONFLICTING" }, reason: { code: "conflicts" } },
		{ pr: { isDraft: true }, reason: { code: "draft" } },
		{ pr: { reviewDecision: "CHANGES_REQUESTED" }, reason: { code: "changes_requested" } },
		{ pr: { reviewDecision: "REVIEW_REQUIRED" }, reason: { code: "review_required" } },
		{ pr: { mergeStateStatus: "BEHIND" }, reason: { code: "behind", value: "BEHIND" } },
		{ problems: { ...noProblems(), divergedFrom: "feat/base" }, reason: { code: "behind", value: "feat/base" } },
		...["BLOCKED", "UNSTABLE", "DIRTY"].map((value) => ({
			pr: { mergeStateStatus: value },
			reason: { code: "merge_state", value },
		})),
	];
	for (const item of cases) {
		const result = mergeReadiness(
			{ ...open, ...("pr" in item ? item.pr : {}) },
			item.problems ?? noProblems(),
			false,
			1,
		)!;
		assert.equal(result.state, "blocked");
		assert.deepEqual(result.reasons, [item.reason]);
		assert.ok(readinessReasonLabel(result.reasons[0]!).length);
	}
});

test("pending evidence cannot become ready; blockers take precedence and transitions clear old reasons", () => {
	const cases = [
		{ ...open, mergeable: "UNKNOWN" },
		{ ...open, mergeable: "FUTURE" },
		{ ...open, mergeStateStatus: "UNKNOWN" },
		{ ...open, mergeStateStatus: "HAS_HOOKS" },
		{ ...open, mergeStateStatus: undefined },
		{ ...open, reviewDecision: undefined },
		{ ...open, reviewDecision: "FUTURE" },
	];
	for (const pr of cases) assert.equal(mergeReadiness(pr, noProblems(), false)?.state, "pending");
	assert.equal(mergeReadiness(open, noProblems(), true)?.state, "pending");
	const failing = { ...noProblems(), failedChecks: ["CI"] };
	assert.equal(mergeReadiness(open, failing, true)?.state, "blocked");
	const states = [
		mergeReadiness(open, failing, false),
		mergeReadiness(open, noProblems(), true),
		mergeReadiness(open, noProblems(), false),
		mergeReadiness({ ...open, isDraft: true }, noProblems(), false),
	];
	assert.deepEqual(
		states.map((item) => item?.state),
		["blocked", "pending", "ready", "blocked"],
	);
	assert.deepEqual(states[2]?.reasons, []);
});
