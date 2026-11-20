import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiagnosticHistoryPage } from "@pilot/protocol";
import { createDiagnosticHistoryTool, DIAGNOSTIC_HISTORY_TOOL } from "./diagnostic-history-tool.ts";

const target = {
	host: { hostId: "remote-box", daemonId: "daemon", lineageId: "lineage" },
	sessionId: "01234567-89ab-4cde-8fab-0123456789ab",
	chatUrl: "pilot://chat/01234567-89ab-4cde-8fab-0123456789ab",
} as const;

test("diagnostic history is read-only and paginated with an optional focus", async () => {
	const calls: Array<[string, number | undefined, number | undefined]> = [];
	const page: DiagnosticHistoryPage = {
		schemaVersion: 1,
		target,
		collectedAt: "2026-01-01T00:00:00.000Z",
		source: { availability: "available", freshness: "fresh" },
		entries: [
			{
				ref: `diagnostic-history:v1:${target.sessionId}:7`,
				entryId: 7,
				kind: "pi.user",
				excerpt: '{"kind":"pi.user"}',
				originalBytes: 18,
				truncated: false,
			},
		],
		pagination: {
			more: true,
			nextBefore: 7,
			returned: 1,
			limit: 8,
			scannedEntries: 1,
			maxScannedEntries: 200,
			encodedBytes: 128,
			maxBytes: 65_536,
			perEntryMaxBytes: 8_192,
			truncatedEntries: 0,
		},
	};
	const tool = createDiagnosticHistoryTool(async (sessionId, before, limit) => {
		calls.push([sessionId, before, limit]);
		return page;
	}, target);
	assert.equal(tool.name, DIAGNOSTIC_HISTORY_TOOL);
	assert.equal(tool.annotations?.readOnlyHint, true);
	assert.equal(tool.annotations?.destructiveHint, false);
	assert.match(tool.description, /untrusted/);
	const newest = await tool.execute("newest", {} as never, undefined, undefined, {} as never);
	await tool.execute("older", { before: 7, limit: 4 } as never, undefined, undefined, {} as never);
	await tool.execute(
		"injected",
		{ sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", before: 6 } as never,
		undefined,
		undefined,
		{} as never,
	);
	assert.deepEqual(calls, [
		[target.sessionId, undefined, undefined],
		[target.sessionId, 7, 4],
		["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 6, undefined],
	]);
	assert.deepEqual(JSON.parse((newest.content[0] as { text: string }).text), page);
});
