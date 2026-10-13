/** Synthetic content and identifiers, preserving the dedicated MCP server's observed wire formatting. */
export const slackHistoryFixture = {
	messages: `Channel: #bugs (C000000001)

=== Message from Reporter <reporter@example.test> (U000000001) at 2026-10-13 11:55:05 CEST ===
Message TS: 1791885305.000001

Export crashes after choosing a large file.
Steps:
1. Open <https://example.test/export|Export>.
2. Choose a file, then press Export.
Expected: a download. Actual: a blank page.
Reactions: eyes (2)

Thread: 2 replies (latest: 2026-10-13 12:00:00 CEST)

=== Message from Helper (U000000002) at 2026-10-13 11:50:00 CEST ===
Message TS: 1791885000.000001

Weekly release notes are ready.
`,
	pagination_info: "There are more messages available. To view the next page, use cursor: `NEXT_PAGE`\n",
};
export const slackThreadFixture = {
	messages: `=== THREAD PARENT MESSAGE ===
From: Reporter <reporter@example.test> (U000000001)
Time: 2026-10-13 11:55:05 CEST
Message TS: 1791885305.000001

Export crashes after choosing a large file.
Reactions: eyes (2)

=== THREAD REPLIES (2 total) ===

--- Reply 1 of 2 ---
From: Helper (U000000002)
Time: 2026-10-13 11:56:00 CEST
Message TS: 1791885360.000001

Reproduced on the latest release.
The browser console reports a TypeError.
Reactions: thumbsup (1)

--- Reply 2 of 2 ---
From: Reporter <reporter@example.test> (U000000001)
Time: 2026-10-13 11:58:00 CEST
Message TS: 1791885480.000001

Small files work; large files fail.
`,
	pagination_info: "There are no more messages in this thread.\n",
};
export const slackEmptyFixture = {
	messages: "Channel: #bugs (C000000001)\n\n",
	pagination_info: "There are no more messages available.\n",
};
