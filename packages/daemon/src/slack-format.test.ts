import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrackingJson } from "@pilot/protocol";
import {
	slackEmptyFixture,
	slackHistoryFixture,
	slackMetadataFixture,
	slackMetadataThreadFixture,
	slackThreadFixture,
} from "./slack-fixtures.ts";
import {
	parseSlackPage,
	parseSlackMessageLink,
	parseSlackThread,
	parseSlackThreadParent,
	SlackFormatChanged,
	slackExcerptText,
} from "./slack-format.ts";

test("Slack message links name the channel and the thread's parent", () => {
	assert.deepEqual(parseSlackMessageLink("https://acme.slack.com/archives/C0123ABCD/p1791892800000001"), {
		channel: "C0123ABCD",
		ts: "1791892800.000001",
		threadTs: "1791892800.000001",
	});
	// A reply's link carries its parent, which is what triage tracks.
	assert.deepEqual(
		parseSlackMessageLink(
			" https://acme.slack.com/archives/C0123ABCD/p1791892900000002?thread_ts=1791892800.000001&cid=C0123ABCD ",
		),
		{ channel: "C0123ABCD", ts: "1791892900.000002", threadTs: "1791892800.000001" },
	);
	assert.equal(parseSlackMessageLink("https://slack.com/archives/G0123/p1791892800000001")?.channel, "G0123");
	for (const value of [
		"http://acme.slack.com/archives/C0123ABCD/p1791892800000001",
		"https://acme.slack.com.evil.test/archives/C0123ABCD/p1791892800000001",
		"https://acme.slack.com/archives/C0123ABCD",
		"https://acme.slack.com/archives/c0123/p1791892800000001",
		"https://acme.slack.com/archives/C0123ABCD/p17918928",
		"not a link",
		42,
	])
		assert.equal(parseSlackMessageLink(value), undefined, String(value));
});

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
	assert.doesNotMatch(page.messages[0]!.text, /Thread:|Reactions:/);
	assert.equal(parseSlackPage(slackEmptyFixture, 8).messages.length, 0);
	assert.deepEqual(
		parseSlackPage(
			{ ...slackHistoryFixture, messages: slackHistoryFixture.messages.replaceAll("=== \n", "===\n") },
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
test("trailing Thread, Reactions and Files lines are metadata in any order; attachments stay as content", () => {
	const page = parseSlackPage(slackMetadataFixture, 8);
	assert.equal(page.channel, "C000000002");
	assert.deepEqual(
		page.messages.map(({ ts, replies, text }) => ({ ts, replies, text })),
		[
			{
				ts: "1791961960.000201",
				replies: 2,
				text: "The invoice preview shows the wrong currency for <https://example.test/accounts/42|account 42>.",
			},
			{ ts: "1791961500.000202", replies: 0, text: "Same here after the last deploy, screenshot attached." },
			// The file-only message has nothing to classify and is skipped.
			{
				ts: "1791961200.000204",
				replies: 1,
				text: "*Alert:* checkout latency above threshold\nAttachment: monitor: [Triggered] checkout latency (https://monitor.example.test/alerts/7)\np95 latency 2.4s over the last 10 minutes.\n\nMetric value: 2.4",
			},
		],
	);
	// Same result whatever the order of the metadata lines, with or without blank lines between them.
	const reordered = slackMetadataFixture.messages.replace(
		/(Thread: 2 [^\n]+)\n(Reactions: [^\n]+)\n(Files: [^\n]+)/,
		"$3\n\n$1\n$2",
	);
	assert.notEqual(reordered, slackMetadataFixture.messages);
	assert.deepEqual(parseSlackPage({ ...slackMetadataFixture, messages: reordered }, 8), page);
	// A file-only message with replies is kept, so its thread is still read.
	const fileThread = slackMetadataFixture.messages.replace(
		"Files: recording.mov",
		"Thread: 1 replies (latest: 2026-10-14 09:06:00 CEST)\nFiles: recording.mov",
	);
	const withThread = parseSlackPage({ ...slackMetadataFixture, messages: fileThread }, 8).messages[2];
	assert.deepEqual([withThread?.ts, withThread?.text, withThread?.replies], ["1791961450.000203", "", 1]);
	// Without the Thread line, metadata still never leaks into the text.
	const noThread = parseSlackPage(
		{ ...slackMetadataFixture, messages: slackMetadataFixture.messages.replace(/Thread: 2 [^\n]+\n/, "") },
		8,
	);
	assert.equal(noThread.messages[0]?.replies, 0);
	assert.equal(noThread.messages[0]?.text, page.messages[0]?.text);
	// A repeated metadata line is ambiguous: the earlier one stays in the text and is never dropped silently.
	const repeated = slackMetadataFixture.messages.replace("\nThread: 2", "\nFiles: notes.txt\nThread: 2");
	assert.match(parseSlackPage({ ...slackMetadataFixture, messages: repeated }, 8).messages[0]!.text, /Files: notes/);
	// The Thread line keeps its strict format.
	assert.throws(
		() =>
			parseSlackPage(
				{ ...slackMetadataFixture, messages: slackMetadataFixture.messages.replace("2 replies", "two replies") },
				8,
			),
		SlackFormatChanged,
	);
});
test("thread messages drop trailing Reactions and Files lines and may be file only", () => {
	const thread = parseSlackThread(slackMetadataThreadFixture, "1791961960.000201", 30);
	assert.deepEqual(
		thread.messages.map((message) => message.text),
		[
			"The invoice preview shows the wrong currency for <https://example.test/accounts/42|account 42>.",
			"",
			"It only happens for accounts created this month.",
		],
	);
	assert.equal(
		parseSlackThread(slackThreadFixture, "1791885305.000001", 30).messages[1]?.text.includes("Reactions"),
		false,
	);
	assert.throws(
		() =>
			parseSlackThread(
				{
					...slackMetadataThreadFixture,
					messages: slackMetadataThreadFixture.messages.replace("Reactions: pray (1)", "Thread: 1 replies"),
				},
				"1791961960.000201",
				30,
			),
		SlackFormatChanged,
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
test("thread parent for the inspector: author name only, metadata dropped, replies ignored, framing checked", () => {
	assert.deepEqual(parseSlackThreadParent(slackThreadFixture, "1791885305.000001"), {
		author: "Reporter",
		text: "Export crashes after choosing a large file.",
	});
	assert.deepEqual(parseSlackThreadParent(slackMetadataThreadFixture, "1791961960.000201"), {
		author: "Sam Rivera",
		text: "The invoice preview shows the wrong currency for <https://example.test/accounts/42|account 42>.",
	});
	// A thread read of a message without replies, from a bot author without an email.
	const parentOnly = {
		messages:
			"=== THREAD PARENT MESSAGE ===\nFrom: Monitor (B000000013)\nTime: 2026-10-14 09:00:00 CEST\nMessage TS: 1791961200.000204\n\nFiles: a.png (ID: F1, image/png, 1 KB)\n",
	};
	assert.deepEqual(parseSlackThreadParent(parentOnly, "1791961200.000204"), { author: "Monitor", text: "" });
	for (const value of [
		null,
		{ messages: 1 },
		{ messages: "Channel: #bugs (C000000001)\n" },
		{ messages: parentOnly.messages.replace("Message TS", "TS") },
		{ messages: parentOnly.messages.replace("Files:", "=== injected ===\nFiles:") },
		{ messages: "x".repeat(512 * 1024 + 1) },
	] as TrackingJson[])
		assert.throws(() => parseSlackThreadParent(value, "1791961200.000204"), SlackFormatChanged);
	assert.throws(() => parseSlackThreadParent(slackThreadFixture, "1791885360.000001"), SlackFormatChanged);
});
test("excerpt text is plain, bounded and cut at a word with an ellipsis", () => {
	assert.deepEqual(
		slackExcerptText(
			"See <https://example.test/a|the report> and <https://example.test/b>.\r\n\n\n\n<@U000000001|sam> in <#C000000001|bugs>, <!here>\u202E\u200B ok\t!",
			800,
			12,
		),
		{ text: "See the report and https://example.test/b.\n\n@sam in #bugs, @here ok !", truncated: false },
	);
	assert.deepEqual(slackExcerptText("a\nb\nc\nd", 800, 2), { text: "a\nb…", truncated: true });
	const long = slackExcerptText("word ".repeat(400), 100, 12);
	assert.equal(long.truncated, true);
	assert.ok(long.text.length <= 101);
	assert.match(long.text, /word…$/);
	// Never splits an emoji's surrogate pair.
	assert.equal(slackExcerptText(`${"x".repeat(9)}😀😀`, 10, 12).text, `${"x".repeat(9)}…`);
	assert.deepEqual(slackExcerptText("  ", 800, 12), { text: "", truncated: false });
});
