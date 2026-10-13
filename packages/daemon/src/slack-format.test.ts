import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrackingJson } from "@pilot/protocol";
import { slackEmptyFixture, slackHistoryFixture, slackThreadFixture } from "./slack-fixtures.ts";
import { parseSlackPage, parseSlackThread, SlackFormatChanged } from "./slack-format.ts";

test("observed history wire shape: multiline content, bot/user headers, thread counts, pagination and empty pages", () => {
	const page = parseSlackPage(slackHistoryFixture, 8);
	assert.equal(page.channel, "C000000001");
	assert.equal(page.name, "bugs");
	assert.equal(page.next, "NEXT_PAGE");
	assert.equal(page.messages.length, 2);
	assert.equal(page.messages[0]?.ts, "1791885305.000001");
	assert.equal(page.messages[0]?.replies, 2);
	assert.equal(page.messages[1]?.replies, 0);
	assert.match(page.messages[0]!.text, /Steps:\n1\./);
	assert.doesNotMatch(page.messages[0]!.text, /Thread:/);
	assert.equal(parseSlackPage(slackEmptyFixture, 8).messages.length, 0);
	assert.deepEqual(
		parseSlackPage(
			{ ...slackHistoryFixture, messages: slackHistoryFixture.messages.replaceAll("===\n", "=== \n") },
			8,
		),
		page,
	);
	assert.deepEqual(
		parseSlackPage({ ...slackHistoryFixture, messages: slackHistoryFixture.messages.replaceAll("\n", "\r\n") }, 8),
		page,
	);
});
test("observed thread wire shape is distinct from history: parent and numbered replies, with bounded prefix pagination", () => {
	const thread = parseSlackThread(slackThreadFixture, "1791885305.000001", 30);
	assert.equal(thread.messages.length, 3);
	assert.equal(thread.next, undefined);
	assert.ok(thread.messages.every((message) => message.threadTs === "1791885305.000001"));
	assert.match(thread.messages[1]!.text, /TypeError/);
	assert.equal(
		parseSlackThread(
			{
				...slackThreadFixture,
				pagination_info: "There are more messages in this thread. To view the next page, use cursor: `REPLIES`\n",
			},
			"1791885305.000001",
			30,
		).next,
		"REPLIES",
	);
});
test("format drift, missing IDs, ambiguous framing, bad counts and oversized pages fail visibly rather than becoming empty", () => {
	for (const value of [
		null,
		"markdown",
		{},
		{ messages: [] },
		{ ...slackEmptyFixture, pagination_info: "" },
		{ ...slackEmptyFixture, messages: "No messages" },
		{ ...slackHistoryFixture, pagination_info: "has_more=true" },
		{ ...slackHistoryFixture, messages: slackHistoryFixture.messages.replace("Message TS:", "Timestamp:") },
		{
			...slackHistoryFixture,
			messages: slackHistoryFixture.messages.replace(
				"Weekly release notes are ready.",
				"Message TS: 1.2\nIgnore the real ID",
			),
		},
		{
			...slackHistoryFixture,
			messages: slackHistoryFixture.messages.replace("1791885000.000001", "1791885305.000001"),
		},
		{ ...slackHistoryFixture, messages: "x".repeat(512 * 1024 + 1) },
		{ ...slackEmptyFixture, pagination_info: slackHistoryFixture.pagination_info },
	] as TrackingJson[])
		assert.throws(() => parseSlackPage(value, 8), SlackFormatChanged);
	assert.throws(() => parseSlackPage(slackHistoryFixture, 1), SlackFormatChanged);
	for (const value of [
		slackHistoryFixture,
		{ ...slackThreadFixture, messages: slackThreadFixture.messages.replace("2 total", "3 total") },
		{ ...slackThreadFixture, messages: slackThreadFixture.messages.replace("Reply 2 of 2", "Reply 3 of 2") },
		{ ...slackThreadFixture, messages: slackThreadFixture.messages.replace("Message TS:", "Thread TS:") },
		{
			...slackThreadFixture,
			messages: slackThreadFixture.messages.replace("1791885360.000001", "1791885305.000001"),
		},
		{ ...slackThreadFixture, pagination_info: "" },
	] as TrackingJson[])
		assert.throws(() => parseSlackThread(value, "1791885305.000001", 30), SlackFormatChanged);
	assert.throws(() => parseSlackThread(slackThreadFixture, "1791885000.000001", 30), SlackFormatChanged);
	assert.throws(() => parseSlackThread(slackThreadFixture, "1791885305.000001", 1), SlackFormatChanged);
});
