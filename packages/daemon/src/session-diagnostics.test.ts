import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { OperationHost, SessionDiagnosticCurrent } from "@pilot/protocol";
import type { DaemonPerformance } from "./event-loop-watchdog.ts";
import { type LifecycleEvent, lifecycleLine } from "./lifecycle-diagnostics.ts";
import { MAX_DIAGNOSTIC_BYTES, MAX_DIAGNOSTIC_ITEMS, readSessionDiagnostics } from "./session-diagnostics.ts";

const host: OperationHost = { hostId: "local", daemonId: "daemon", lineageId: "lineage" };
const current: SessionDiagnosticCurrent = {
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
};

function event(index: number, at: string): LifecycleEvent {
	return {
		v: 1,
		id: `e-${index.toString(16)}`,
		at,
		source: "daemon",
		release: "1.0.0",
		hostKind: "local",
		kind: "execution.started",
		reason: "work",
		state: "working",
	};
}

function performance(at: number): DaemonPerformance {
	return {
		startedAt: at - 1_000,
		uptimeMs: 1_000,
		eventLoop: { utilization: 0.25, delayMs: { p50: 1, p99: 4, p999: 8, max: 10 } },
		stalls: {
			thresholdMs: 1_000,
			count: 1,
			busy: 1,
			waiting: 0,
			sleep: 0,
			totalMs: 1_200,
			cpuMs: 1_000,
			recent: [{ at, ms: 1_200, cpuMs: 1_000, context: ["secret route and session id"] }],
		},
		operations: {
			recentSlow: [],
			slowByKind: [],
			inFlight: [{ label: "secret request label", ms: 10 }],
		},
		process: {
			mainThreadCpuMs: 10,
			cpuMs: 20,
			rssBytes: 1_000,
			heapUsedBytes: 500,
			externalBytes: 10,
			fsReads: 1,
			fsWrites: 2,
			voluntaryContextSwitches: 3,
			involuntaryContextSwitches: 4,
		},
	};
}

test("diagnostics combine strict local sources without exposing retained content", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-diagnostics-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "durable"));
	const now = Date.parse("2026-01-02T00:00:10.000Z");
	await writeFile(
		join(root, "lifecycle.jsonl"),
		`${lifecycleLine(event(1, "2026-01-02T00:00:05.000Z"))}{"message":"conversation secret"}\n`,
	);
	await writeFile(
		join(root, "durable", "performance.jsonl"),
		`${JSON.stringify({
			v: 1,
			request: 2,
			at: now - 4_000,
			source: "generation",
			outcome: "completed",
			preparationMs: 2,
			providerMs: 3,
			totalMs: 5,
			httpAttempts: 1,
			prompt: "conversation secret",
		})}\nnot-json\n`,
	);
	const native = join(root, "native-diagnostics.json");
	await writeFile(
		native,
		JSON.stringify({
			schemaVersion: 1,
			evidence: [
				{
					ref: "diagnostic:v1:setup:abcdef0123456789abcdef01",
					attemptRef: "diagnostic:v1:setup-attempt:0123456789abcdef01234567",
					sequence: 8,
					source: "app",
					at: "2026-01-02T00:00:09.000Z",
					kind: "devbox.setup",
					stage: "remote_handshake",
					outcome: "failed",
					reason: "handshake_rejected",
				},
				{
					ref: "diagnostic:v1:native:0123456789abcdef01234567",
					source: "os",
					at: "2026-01-02T00:00:08.000Z",
					kind: "native.hang",
					reason: "unresponsive",
					windowMs: 86_400_000,
					releaseRelation: "current",
					durationMs: 2_000,
				},
			],
			dropped: 0,
		}),
	);
	const result = await readSessionDiagnostics({
		host,
		sessionId: "session",
		storageDir: root,
		current,
		connectivity: { state: "online", observedAt: "2026-01-02T00:00:09.000Z" },
		performance: performance(now - 3_000),
		nativeDiagnosticsPath: native,
		now,
	});
	assert.equal(result.freshness, "fresh");
	assert.deepEqual(
		result.evidence.map((item) => item.source),
		["app", "os", "daemon", "request_timing", "lifecycle"],
	);
	assert.equal(result.sources.find((source) => source.source === "app")?.freshness, "fresh");
	assert.equal(result.sources.find((source) => source.source === "lifecycle")?.invalid, 1);
	assert.equal(result.sources.find((source) => source.source === "request_timing")?.invalid, 1);
	assert.equal(result.resources.inFlightRequests, 1);
	assert.equal(result.truncation.invalid, 2);
	assert.equal(JSON.stringify(result).includes("conversation secret"), false);
	assert.equal(JSON.stringify(result).includes("secret route"), false);
	assert.ok(result.truncation.encodedBytes <= MAX_DIAGNOSTIC_BYTES);
});

test("a healthy local daemon keeps failed remote setup evidence separate and marks old setup evidence stale", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-diagnostics-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "durable"));
	const now = Date.parse("2026-01-02T00:10:00.000Z");
	const native = join(root, "native-diagnostics.json");
	await writeFile(
		native,
		JSON.stringify({
			schemaVersion: 1,
			evidence: [
				{
					ref: "diagnostic:v1:setup:abcdef0123456789abcdef01",
					attemptRef: "diagnostic:v1:setup-attempt:0123456789abcdef01234567",
					sequence: 4,
					source: "app",
					at: "2026-01-02T00:00:00.000Z",
					kind: "devbox.setup",
					stage: "ssh_transport",
					outcome: "failed",
					reason: "ssh_timeout",
				},
			],
			dropped: 0,
		}),
	);
	const result = await readSessionDiagnostics({
		host,
		sessionId: "session",
		storageDir: root,
		current,
		connectivity: { state: "online", observedAt: new Date(now).toISOString() },
		performance: performance(now),
		nativeDiagnosticsPath: native,
		now,
	});
	assert.equal(result.sources.find((source) => source.source === "daemon")?.freshness, "fresh");
	assert.equal(result.sources.find((source) => source.source === "app")?.freshness, "stale");
	assert.equal(result.sources.find((source) => source.source === "os")?.freshness, "unavailable");
	const setup = result.evidence.find((item) => item.kind === "devbox.setup");
	assert.ok(setup && setup.kind === "devbox.setup");
	assert.equal(setup.reason, "ssh_timeout");
});

test("diagnostics bound items, bytes and report stale, missing and dropped evidence", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-diagnostics-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "durable"));
	const lines = Array.from({ length: 150 }, (_, index) =>
		lifecycleLine({
			...event(index, new Date(index * 1_000).toISOString()),
			...(index === 149 ? { droppedBefore: 7 } : {}),
		}),
	).join("");
	await writeFile(join(root, "lifecycle.jsonl"), lines);
	const result = await readSessionDiagnostics({
		host,
		sessionId: "session",
		storageDir: root,
		current,
		connectivity: { state: "unknown" },
		limit: MAX_DIAGNOSTIC_ITEMS,
		now: 1_000_000,
	});
	assert.equal(result.evidence.length, 96);
	assert.equal(result.evidence[0]?.ref, "diagnostic:v1:lifecycle:e-95");
	assert.equal(result.sources[0]?.freshness, "stale");
	assert.equal(result.sources[1]?.freshness, "unavailable");
	assert.equal(result.truncation.available, 150);
	assert.equal(result.truncation.dropped, 7);
	assert.equal(result.truncation.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_DIAGNOSTIC_BYTES);
});

test("diagnostics treat symlinked evidence as unavailable", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-diagnostics-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const outside = join(root, "outside");
	await writeFile(outside, lifecycleLine(event(1, new Date().toISOString()))!);
	await symlink(outside, join(root, "lifecycle.jsonl"));
	const result = await readSessionDiagnostics({
		host,
		sessionId: "session",
		storageDir: root,
		current,
		connectivity: { state: "unknown" },
	});
	assert.equal(result.evidence.length, 0);
	assert.equal(result.sources[0]?.freshness, "unavailable");
});

test("diagnostics combine live tool progress with completed and interrupted evidence", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-diagnostics-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "durable"));
	const now = 20_000;
	const lines = [
		{
			v: 1,
			kind: "started",
			ref: "abcdef012345-1",
			at: 10_000,
			category: "mcp",
			nested: true,
		},
		{
			v: 1,
			kind: "started",
			ref: "abcdef012345-2",
			at: 11_000,
			category: "shell",
			nested: false,
		},
		{
			v: 1,
			kind: "finished",
			ref: "abcdef012345-3",
			at: 19_000,
			startedAt: 17_000,
			category: "filesystem",
			nested: false,
			outcome: "success",
			durationMs: 2_000,
			dispatchMs: 100,
			executionMs: 1_900,
		},
	]
		.map((record) => `${JSON.stringify(record)}\n`)
		.join("");
	await writeFile(join(root, "durable", "tool-activity.jsonl"), lines);
	const result = await readSessionDiagnostics({
		host,
		sessionId: "session",
		storageDir: root,
		current,
		connectivity: { state: "online" },
		toolActivity: {
			enabled: true,
			observedAt: 19_900,
			dropped: 0,
			calls: [
				{
					ref: "abcdef012345-1",
					category: "mcp",
					nested: true,
					state: "running",
					startedAt: 10_000,
					progressAt: 15_000,
					livenessAt: 19_000,
				},
			],
		},
		now,
	});
	const toolEvidence = result.evidence.filter((item) => item.source === "tool");
	assert.deepEqual(
		toolEvidence.map((item) => [item.kind, "outcome" in item ? item.outcome : undefined, item.category]),
		[
			["tool.in_flight", undefined, "mcp"],
			["tool.call", "success", "filesystem"],
			["tool.call", "interrupted", "shell"],
		],
	);
	const active = toolEvidence.find((item) => item.kind === "tool.in_flight");
	assert.equal(active?.durationMs, 10_000);
	assert.equal(active?.assessment, "active");
	assert.equal(active?.progressAgeMs, 5_000);
	assert.equal(active?.livenessAgeMs, 1_000);
	assert.equal(result.sources.find((source) => source.source === "tool")?.available, 3);
	assert.equal(JSON.stringify(result).includes("mcp__slack"), false, "raw tool names are never exposed");
});

test("diagnostics distinguish an idle live observer from disabled collection", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-diagnostics-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "durable"));
	await writeFile(
		join(root, "durable", "tool-activity.jsonl"),
		`${JSON.stringify({
			v: 1,
			kind: "started",
			ref: "abcdef012345-1",
			at: 10_000,
			category: "mcp",
			nested: true,
		})}\n`,
	);

	const live = await readSessionDiagnostics({
		host,
		sessionId: "session",
		storageDir: root,
		current,
		connectivity: { state: "online" },
		toolActivity: { enabled: true, observedAt: 20_000, calls: [], dropped: 0 },
		now: 20_000,
	});
	assert.equal(live.sources.find((source) => source.source === "tool")?.freshness, "fresh");
	assert.equal(
		live.evidence.some((item) => item.kind === "tool.call" && "outcome" in item && item.outcome === "interrupted"),
		true,
	);

	const disabled = await readSessionDiagnostics({
		host,
		sessionId: "session",
		storageDir: root,
		current,
		connectivity: { state: "online" },
		toolActivity: { enabled: false, observedAt: 20_000, calls: [], dropped: 1 },
		now: 20_000,
	});
	assert.equal(disabled.sources.find((source) => source.source === "tool")?.freshness, "unavailable");
	assert.equal(
		disabled.evidence.some(
			(item) => item.kind === "tool.call" && "outcome" in item && item.outcome === "interrupted",
		),
		false,
	);
});
