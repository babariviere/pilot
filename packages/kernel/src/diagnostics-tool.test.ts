import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionDiagnostics } from "@pilot/protocol";
import { createDiagnosticsTool, DIAGNOSTICS_TOOL } from "./diagnostics-tool.ts";

const result = {
	schemaVersion: 1,
	host: { hostId: "local", daemonId: "daemon", lineageId: "lineage" },
	sessionId: "current",
	release: "1.0.0",
	collectedAt: "2026-01-01T00:00:00.000Z",
	freshness: "fresh",
	connectivity: { state: "unknown" },
	current: {
		state: "parked",
		working: false,
		pauses: [],
		recovery: "none",
		hasError: false,
		queue: {
			pendingInputs: 0,
			starting: false,
			parking: false,
			workspacePreparing: false,
			runningJobs: 0,
			workingSubagents: 0,
		},
	},
	resources: {},
	sources: [],
	evidence: [],
	truncation: {
		truncated: false,
		returned: 0,
		available: 0,
		dropped: 0,
		invalid: 0,
		encodedBytes: 0,
		maxItems: 128,
		maxBytes: 65_536,
	},
} satisfies SessionDiagnostics;

test("diagnostics is declared read-only and defaults to the current chat", async () => {
	const calls: Array<[string, number | undefined]> = [];
	const tool = createDiagnosticsTool(async (sessionId, limit) => {
		calls.push([sessionId, limit]);
		return { ...result, sessionId };
	}, "current");
	assert.equal(tool.name, DIAGNOSTICS_TOOL);
	assert.equal(tool.annotations?.readOnlyHint, true);
	assert.equal(tool.annotations?.destructiveHint, false);
	const first = await tool.execute("call-1", {} as never, undefined, undefined, {} as never);
	await tool.execute("call-2", { sessionId: "other", limit: 12 } as never, undefined, undefined, {} as never);
	assert.deepEqual(calls, [
		["current", undefined],
		["other", 12],
	]);
	assert.equal(JSON.parse((first.content[0] as { text: string }).text).sessionId, "current");
});
