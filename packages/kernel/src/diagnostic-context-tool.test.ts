import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiagnosticContextTool } from "./diagnostic-context-tool.ts";

test("diagnostic context exposes performance through the existing read-only dispatcher", async () => {
	const calls: unknown[] = [];
	const tool = createDiagnosticContextTool(async (request) => {
		calls.push(request);
		return {
			schemaVersion: 1,
			host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
			collectedAt: "2026-10-30T12:00:00.000Z",
			status: "available",
			data: { process: { mainThreadCpuMs: 123 } },
			page: { more: false, scanned: 0, maxScan: 200, maxBytes: 65536, truncated: false },
		};
	});
	assert.equal(tool.annotations?.readOnlyHint, true);
	assert.match(JSON.stringify(tool.parameters), /performance/);
	const result = await tool.execute(
		"performance",
		{ action: "performance" } as never,
		undefined,
		undefined,
		{} as never,
	);
	assert.deepEqual(calls, [{ action: "performance" }]);
	assert.match(JSON.stringify(result), /mainThreadCpuMs/);
});
