import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CHAT_REPORT_FILE,
	CHAT_REPORT_LIMITS,
	parseChatReport,
	readChatReport,
	saveChatReport,
} from "./chat-report.ts";

test("a chat report keeps its fields trimmed and drops empty ones", () => {
	assert.deepEqual(
		parseChatReport(
			{
				answer: "  It is a true positive. ",
				howItKnows: "The audit log shows the entry.",
				limits: "",
				links: [{ url: "https://example.com/log", title: "Audit log" }, { url: "pilot://chat/abc" }],
			},
			5,
		),
		{
			answer: "It is a true positive.",
			howItKnows: "The audit log shows the entry.",
			links: [{ url: "https://example.com/log", title: "Audit log" }, { url: "pilot://chat/abc" }],
			at: 5,
		},
	);
});

test("refusals name the field, its size and its limit", () => {
	assert.throws(() => parseChatReport({}, 1), /needs an answer/);
	assert.throws(
		() => parseChatReport({ answer: "x".repeat(CHAT_REPORT_LIMITS.answer + 1) }, 1),
		/chat_report answer has 8,001 characters; the limit is 8,000/,
	);
	assert.throws(
		() => parseChatReport({ answer: "a", nextStep: "y".repeat(CHAT_REPORT_LIMITS.field + 1) }, 1),
		/nextStep has 2,001 characters; the limit is 2,000/,
	);
	const links = Array.from({ length: CHAT_REPORT_LIMITS.links + 1 }, (_, i) => ({ url: `https://e.com/${i}` }));
	assert.throws(() => parseChatReport({ answer: "a", links }, 1), /11 links; the limit is 10/);
	assert.throws(() => parseChatReport({ answer: "a", links: [{ url: "file:///etc/passwd" }] }, 1), /must start with/);
});

test("a saved report replaces the earlier one and survives a reread; a broken file reads as none", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-chat-report-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	assert.equal(await readChatReport(dir), undefined);
	await saveChatReport(dir, { answer: "First", at: 1 });
	await saveChatReport(dir, { answer: "Second", limits: "Not checked in production.", at: 2 });
	assert.deepEqual(await readChatReport(dir), { answer: "Second", limits: "Not checked in production.", at: 2 });
	await writeFile(join(dir, CHAT_REPORT_FILE), "{broken");
	assert.equal(await readChatReport(dir), undefined);
});
