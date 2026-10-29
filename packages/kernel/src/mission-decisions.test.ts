import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionNotice } from "./mission-decisions.ts";
import type { MissionContext } from "./policy.ts";

const decision = { id: "one", number: 1, text: "Original rule", audience: "all" as const, selected: true };
function context(decisionState: MissionContext["decisionState"]): MissionContext {
	return {
		id: "shared",
		title: "Shared",
		goal: "Ship",
		status: "active",
		coordinator: "other",
		tasks: [],
		decisions: [],
		decisionState,
	};
}

test("decision notices show added, edited and removed decisions with full before/after content", () => {
	const notice = decisionNotice(
		context([decision, { ...decision, id: "two", number: 2, text: "Retired rule" }]),
		context([
			{ ...decision, text: "Revised\nmultiline rule" },
			{ ...decision, id: "three", number: 3, text: "New rule" },
		]),
	)!;
	assert.equal(notice.summary, "Mission decisions changed: D1 updated: Revised multiline rule (+2 more)");
	assert.match(notice.detail, /D1 updated\n\nBefore:\n> Original rule\n\nAfter:\n> Revised\n> multiline rule/);
	assert.match(notice.detail, /D3 added\n\n> New rule/);
	assert.match(notice.detail, /D2 removed\n\n> Retired rule/);
});

test("notices include reference decisions outside the prompt and audience and pin changes", () => {
	const before = { ...decision, audience: "reference" as const, selected: false };
	const notice = decisionNotice(context([before]), context([{ ...before, audience: "coordinator", selected: true }]))!;
	assert.match(notice.detail, /D1 updated\n\n> Original rule/);
	assert.match(notice.detail, /Audience: reference → coordinator/);
	assert.match(notice.detail, /Prompt selection: not included → included/);
	const pinned = decisionNotice(context([before]), context([{ ...before, selected: true }]))!;
	assert.match(pinned.detail, /Prompt selection: not included → included/);
});

test("unchanged decision snapshots do not produce notices for unrelated replica revisions", () => {
	assert.equal(decisionNotice(context([decision]), context([{ ...decision }])), undefined);
	assert.equal(decisionNotice(context([]), context([])), undefined);
});

test("only an exact acknowledged addition is suppressed, not later external edits", () => {
	const own = new Map([[decision.id, { number: decision.number, text: decision.text, audience: decision.audience }]]);
	assert.equal(decisionNotice(context([]), context([decision]), own), undefined);
	assert.match(decisionNotice(context([]), context([{ ...decision, text: "User edit" }]), own)!.detail, /User edit/);
	assert.match(
		decisionNotice(context([decision]), context([{ ...decision, text: "User edit" }]), own)!.detail,
		/User edit/,
	);
});

test("summary is bounded while disclosure keeps the full decision", () => {
	const text = "Long rule ".repeat(1000);
	const notice = decisionNotice(context([]), context([{ ...decision, text }]))!;
	assert.ok(notice.summary.length < 160);
	assert.ok(notice.summary.endsWith("…"));
	assert.ok(notice.detail.includes(text));
});

test("older contexts still instruct the agent to fetch decisions", () => {
	assert.match(decisionNotice(context(undefined), context([decision]))!.detail, /Read mission/);
});
