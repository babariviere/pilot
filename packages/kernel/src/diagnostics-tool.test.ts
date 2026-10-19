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
const target = {
	host: { hostId: "remote-box", daemonId: "daemon", lineageId: "lineage" },
	sessionId: "01234567-89ab-4cde-8fab-0123456789ab",
	chatUrl: "pilot://chat/01234567-89ab-4cde-8fab-0123456789ab",
} as const;

test("diagnostics is declared read-only with an initial chat focus", async () => {
	const calls: Array<[string, number | undefined]> = [];
	const tool = createDiagnosticsTool(
		async (sessionId, limit) => {
			assert.ok(sessionId);
			calls.push([sessionId, limit]);
			return { ...result, sessionId };
		},
		{ kind: "chat", target },
	);
	assert.equal(tool.name, DIAGNOSTICS_TOOL);
	assert.equal(tool.annotations?.readOnlyHint, true);
	assert.equal(tool.annotations?.destructiveHint, false);
	assert.match(tool.description, /No wake or mutation/);
	const first = await tool.execute("call-1", {} as never, undefined, undefined, {} as never);
	await tool.execute("call-2", { limit: 12 } as never, undefined, undefined, {} as never);
	assert.deepEqual(calls, [
		[target.sessionId, undefined],
		[target.sessionId, 12],
	]);
	assert.equal(JSON.parse((first.content[0] as { text: string }).text).sessionId, target.sessionId);
});

test("app diagnostics has no implicit session target", async () => {
	const calls: Array<[string | undefined, number | undefined]> = [];
	const host = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
	const tool = createDiagnosticsTool(
		async (sessionId, limit) => {
			calls.push([sessionId, limit]);
			return {
				schemaVersion: 1,
				scope: "app",
				host,
				release: "1.0.0",
				collectedAt: "2026-01-01T00:00:00.000Z",
				connectivity: { state: "unknown" },
				localDiagnostics: { enabled: true, coverage: "host" },
				sessions: { total: 0, active: 0, archived: 0, working: 0, failed: 0, workers: 0 },
				resources: {},
			};
		},
		{ kind: "app", host },
	);
	await tool.execute("call", { limit: 4 } as never, undefined, undefined, {} as never);
	assert.deepEqual(calls, [[undefined, 4]]);
	assert.match(tool.description, /app health/);
});
