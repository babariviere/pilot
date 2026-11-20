import assert from "node:assert/strict";
import test from "node:test";
import { attentionCounts, attentionHeadline } from "../todayHeadline.ts";

test("two stopped chats and two incoming requests are separate facts", () => {
	assert.equal(
		attentionHeadline({ stopped: 2, other: 0, requests: 2, complete: true }),
		"Two stopped chats. Two incoming requests.",
	);
});

test("requests alone do not claim that nothing needs attention", () => {
	assert.equal(attentionHeadline({ stopped: 0, other: 0, requests: 2, complete: true }), "Two incoming requests.");
});

test("other attention stays separate from stopped chats", () => {
	assert.equal(
		attentionHeadline({ stopped: 2, other: 1, requests: 2, complete: true }),
		"Two stopped chats. One other item needs you. Two incoming requests.",
	);
});

test("a partial read cannot claim all clear, including when requests are known", () => {
	assert.equal(
		attentionHeadline({ stopped: 0, other: 0, requests: 0, complete: false }),
		"What needs you is not fully known.",
	);
	assert.equal(
		attentionHeadline({ stopped: 0, other: 0, requests: 2, complete: false }),
		"What needs you is not fully known. Two incoming requests.",
	);
});

test("host rows count even when another project's saved aggregate says zero", () => {
	const problem = {
		id: "stopped",
		title: "Stopped chat",
		projectId: "other",
		sessionId: "chat",
		nextStep: "Reply",
		canContinue: true,
		canDismiss: false,
		canReply: true,
	};
	const own = attentionCounts({ decisions: [], actions: [], problems: [] });
	const other = attentionCounts({
		decisions: [],
		actions: [],
		problems: [problem, { ...problem, id: "second", sessionId: "second" }],
	});
	assert.equal(
		attentionHeadline({
			stopped: own.stopped + other.stopped,
			other: own.other + other.other,
			requests: 2,
			complete: true,
		}),
		"Two stopped chats. Two incoming requests.",
	);
});

test("host problems that are not stopped chats count as other attention", () => {
	const counts = attentionCounts({
		decisions: [],
		actions: [],
		problems: [
			{
				id: "failed",
				title: "Failed check",
				projectId: "other",
				sessionId: "chat",
				nextStep: "Inspect",
				canContinue: true,
				canDismiss: true,
				canReply: false,
			},
		],
	});
	assert.deepEqual(counts, { stopped: 0, other: 1 });
});
