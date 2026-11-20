import assert from "node:assert/strict";
import { test } from "node:test";
import { createScopedMetricsTool } from "./scoped-metrics-tool.ts";

test("scoped metrics sends only a fixed protected selector and forwards cancellation", async () => {
	const calls: unknown[] = [];
	const signal = new AbortController().signal;
	const tool = createScopedMetricsTool(async (request, received) => {
		calls.push(request);
		assert.equal(received, signal);
		return {
			schemaVersion: 1,
			host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
			collectedAt: "2026-01-01T00:00:00Z",
			status: "available",
			data: { usage: null },
			page: { more: false, scanned: 0, maxScan: 200, maxBytes: 65536, truncated: false },
		};
	});
	assert.equal(tool.annotations?.readOnlyHint, true);
	assert.equal(Reflect.get(tool.parameters, "additionalProperties"), false);
	await tool.execute("self", {}, signal, undefined, {} as never);
	await tool.execute("target", { sessionId: "11111111-1111-1111-1111-111111111111" }, signal, undefined, {} as never);
	assert.deepEqual(calls, [
		{ action: "scoped_metrics" },
		{ action: "scoped_metrics", sessionId: "11111111-1111-1111-1111-111111111111" },
	]);
});
