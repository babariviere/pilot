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

test("replacement notices retire old guidance without copying replacement text or redirecting pins", () => {
	const target = {
		...decision,
		id: "two",
		number: 2,
		text: "Scoped replacement",
		audience: "coordinator" as const,
		selected: false,
	};
	const replaced = { ...decision, selected: false, replacement: { id: target.id, number: target.number, at: 42 } };
	const before = context([decision, target]);
	const after = context([replaced, target]);
	const notice = decisionNotice(before, after)!;
	assert.match(notice.summary, /D1 replaced by D2 \(no longer binding\)/);
	assert.match(notice.detail, /D1 is no longer binding/);
	assert.match(notice.detail, /Historical task pins are unchanged/);
	assert.doesNotMatch(notice.detail, /Scoped replacement/);
	assert.equal(decisionNotice(after, after), undefined);
	assert.match(decisionNotice(context([]), context([replaced]))!.detail, /no longer binding/);
	const own = new Map([[decision.id, replaced]]);
	const ownAddition = new Map([[decision.id, decision]]);
	assert.match(decisionNotice(context([]), context([replaced]), ownAddition)!.detail, /no longer binding/);
	assert.equal(decisionNotice(before, after, own), undefined);
	const mixed = decisionNotice(before, context([replaced, { ...target, text: "Separate user update" }]), own)!;
	assert.match(mixed.detail, /Separate user update/);
	assert.doesNotMatch(mixed.detail, /D1 updated|D1 is no longer binding/);
	assert.match(
		decisionNotice(before, context([{ ...replaced, text: "User edited" }, target]), own)!.detail,
		/User edited/,
	);
	assert.match(
		decisionNotice(before, context([{ ...replaced, audience: "reference" }, target]), own)!.detail,
		/Audience/,
	);
	assert.ok(
		decisionNotice(before, context([{ ...replaced, replacement: { ...replaced.replacement, at: 43 } }, target]), own),
	);
});

test("withdrawal notices require exact acknowledged state and preserve external user changes", () => {
	const withdrawn = {
		...decision,
		selected: false,
		withdrawn: { at: 42, reason: "Obsolete", proposalId: "proposal" },
	};
	const before = context([decision]);
	const after = context([withdrawn]);
	const notice = decisionNotice(before, after)!;
	assert.match(notice.summary, /D1 withdrawn \(no longer binding\)/);
	assert.match(notice.detail, /Historical text and task pins are unchanged/);
	assert.match(notice.detail, /Reason:\n> Obsolete/);
	assert.equal(decisionNotice(after, after), undefined);
	assert.match(decisionNotice(context([]), after)!.detail, /withdrawn/);
	const own = new Map([[decision.id, withdrawn]]);
	assert.equal(decisionNotice(before, after, own), undefined);
	assert.equal(decisionNotice(context([]), after, own), undefined);
	assert.match(decisionNotice(context([]), after, new Map([[decision.id, decision]]))!.detail, /withdrawn/);
	for (const metadata of [{ at: 43 }, { reason: "User correction" }, { proposalId: "other" }])
		assert.ok(
			decisionNotice(after, context([{ ...withdrawn, withdrawn: { ...withdrawn.withdrawn, ...metadata } }]), own),
		);
	assert.match(decisionNotice(after, context([{ ...withdrawn, text: "User edit" }]), own)!.detail, /User edit/);
	assert.match(decisionNotice(after, context([{ ...withdrawn, audience: "reference" }]), own)!.detail, /Audience/);
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
