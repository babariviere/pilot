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
Thread: 2 replies (latest: 2026-10-13 12:00:00 CEST)
Reactions: eyes (2)

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
/** Trailing metadata after the text (Thread, Reactions, Files), file-only messages and a bot alert whose
 * Attachment block follows the Thread line. */
export const slackMetadataFixture = {
	messages: `Channel: #support (C000000002)

=== Message from Sam Rivera <sam.rivera@example.test> (U000000011) at 2026-10-14 09:12:40 CEST === 
Message TS: 1791961960.000201

The invoice preview shows the wrong currency for <https://example.test/accounts/42|account 42>.
Thread: 2 replies (latest: 2026-10-14 09:30:02 CEST)
Reactions: eyes (1), white_check_mark (2)
Files: invoice-preview.png (ID: F000000101, image/png, 60.8 KB), console-log.txt (ID: F000000102, text/plain, 2.1 KB)

=== Message from Alex Chen <alex.chen@example.test> (U000000012) at 2026-10-14 09:05:00 CEST === 
Message TS: 1791961500.000202

Same here after the last deploy, screenshot attached.
Files: settings-page.png (ID: F000000103, image/png, 120.4 KB)

=== Message from Alex Chen <alex.chen@example.test> (U000000012) at 2026-10-14 09:04:10 CEST === 
Message TS: 1791961450.000203

Files: recording.mov (ID: F000000104, video/quicktime, 3.2 MB)

=== Message from Monitor (B000000013) at 2026-10-14 09:00:00 CEST === 
Message TS: 1791961200.000204

*Alert:* checkout latency above threshold
Thread: 1 replies (latest: 2026-10-14 09:01:00 CEST)
Attachment: monitor: [Triggered] checkout latency (https://monitor.example.test/alerts/7)
p95 latency 2.4s over the last 10 minutes.

Metric value: 2.4
`,
	pagination_info: "There are no more messages available.\n",
};
export const slackMetadataThreadFixture = {
	messages: `=== THREAD PARENT MESSAGE === 
From: Sam Rivera <sam.rivera@example.test> (U000000011)
Time: 2026-10-14 09:12:40 CEST
Message TS: 1791961960.000201

The invoice preview shows the wrong currency for <https://example.test/accounts/42|account 42>.
Reactions: eyes (1), white_check_mark (2)
Files: invoice-preview.png (ID: F000000101, image/png, 60.8 KB)

=== THREAD REPLIES (2 total) === 

--- Reply 1 of 2 ---
From: Alex Chen <alex.chen@example.test> (U000000012)
Time: 2026-10-14 09:20:00 CEST
Message TS: 1791962400.000301

Files: currency-dropdown.png (ID: F000000105, image/png, 44.0 KB)

--- Reply 2 of 2 ---
From: Sam Rivera <sam.rivera@example.test> (U000000011)
Time: 2026-10-14 09:30:02 CEST
Message TS: 1791963002.000302

It only happens for accounts created this month.
Reactions: pray (1)
`,
	pagination_info: "There are no more messages in this thread.\n",
};
