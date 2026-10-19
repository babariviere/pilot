import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiagnosticLogTool, DIAGNOSTIC_LOG_TOOL } from "./diagnostic-log-tool.ts";
import type { DiagnosticLogRequest, DiagnosticLogResult } from "./protocol.ts";

const target = {
	host: { hostId: "remote-box", daemonId: "daemon", lineageId: "lineage" },
	sessionId: "01234567-89ab-4cde-8fab-0123456789ab",
	chatUrl: "pilot://chat/01234567-89ab-4cde-8fab-0123456789ab",
} as const;

test("diagnostic logs exposes only inventory, catalogue search and returned-ref excerpts", async () => {
	const calls: DiagnosticLogRequest[] = [];
	const result: DiagnosticLogResult = {
		schemaVersion: 1,
		host: target.host,
		scope: "chat",
		targetSessionId: target.sessionId,
		collectedAt: "2026-10-18T10:00:00.000Z",
		untrusted: true,
		action: "inventory",
		sources: [],
	};
	const tool = createDiagnosticLogTool(
		async (request) => {
			calls.push(request);
			return { ...result, action: request.action };
		},
		{ kind: "chat", target },
	);
	assert.equal(tool.name, DIAGNOSTIC_LOG_TOOL);
	assert.equal(tool.annotations?.readOnlyHint, true);
	assert.equal(tool.annotations?.destructiveHint, false);
	assert.equal(tool.annotations?.openWorldHint, false);
	assert.match(tool.description, /catalogued source IDs/);
	assert.match(tool.description, /untrusted data/);
	assert.match(tool.description, /cannot read arbitrary files or paths/);
	const inventory = await tool.execute(
		"inventory",
		{ action: "inventory" } as never,
		undefined,
		undefined,
		{} as never,
	);
	await tool.execute(
		"search",
		{ action: "search", source: "daemon", q: "timeout", limit: 4 } as never,
		undefined,
		undefined,
		{} as never,
	);
	await tool.execute(
		"excerpt",
		{ action: "excerpt", ref: "diagnostic-log:v1:opaque", before: 2, after: 3 } as never,
		undefined,
		undefined,
		{} as never,
	);
	assert.deepEqual(calls, [
		{ action: "inventory" },
		{ action: "search", source: "daemon", q: "timeout", limit: 4 },
		{ action: "excerpt", ref: "diagnostic-log:v1:opaque", before: 2, after: 3 },
	]);
	assert.deepEqual(JSON.parse((inventory.content[0] as { text: string }).text), result);
});
