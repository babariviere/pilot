import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskRefs } from "./mission-task-refs.ts";

test("claim selectors expand inclusive ranges and normalize task numbers without splitting IDs", () => {
	const uuid = "eacd6bcc-b7c3-4022-a94a-fd346cc9b094";
	assert.deepEqual(parseTaskRefs(["1-5", "#3", 6, " #07 ", uuid]), ["1", "2", "3", "4", "5", "6", "7", uuid]);
	assert.deepEqual(parseTaskRefs(" #2 - #4, 6, #2 "), ["2", "3", "4", "6"]);
	assert.deepEqual(parseTaskRefs("4-4"), ["4"]);
	assert.deepEqual(parseTaskRefs(uuid), [uuid]);
	assert.deepEqual(parseTaskRefs("opaque-id"), ["opaque-id"]);
	assert.deepEqual(parseTaskRefs(9), ["9"]);
	assert.equal(parseTaskRefs("1-1000").length, 1000);
});

test("invalid and unbounded selectors are rejected before claiming", () => {
	for (const input of [
		undefined,
		null,
		{},
		[],
		[true],
		[[1]],
		"",
		" ",
		"1,",
		"0",
		"#0",
		-1,
		1.5,
		NaN,
		Infinity,
		"5-1",
		"0-1",
		"1-1001",
		["1-1000", 1],
		Array(1001).fill(1),
		"9007199254740992",
		"1-9007199254740992",
		"x".repeat(129),
	])
		assert.throws(() => parseTaskRefs(input), Error, JSON.stringify(input));
});
