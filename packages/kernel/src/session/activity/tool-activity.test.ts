import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ToolActivitySnapshot } from "@pilot/protocol";
import {
	parseToolActivityRecord,
	ToolActivityTracker,
	toolActivityExtension,
	toolActivityLine,
	toolCategory,
	toolWaitKind,
} from "./tool-activity.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryFile(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pilot-tool-activity-"));
	roots.push(root);
	return join(root, "tool-activity.jsonl");
}

test("classifies only closed built-in, MCP and nested codemode categories", () => {
	assert.equal(toolCategory("bash"), "shell");
	assert.equal(toolCategory("read"), "filesystem");
	assert.equal(toolCategory("web"), "network");
	assert.equal(toolCategory("jobs"), "background");
	assert.equal(toolCategory("codemode"), "codemode");
	assert.equal(toolCategory("mcp__linear__get_issue"), "mcp");
	assert.equal(toolCategory("mission"), "orchestration");
	assert.equal(toolCategory("customer-secret-tool"), "other");
	assert.equal(toolWaitKind("jobs"), "background");
	assert.equal(toolWaitKind("question"), "user");
	assert.equal(toolWaitKind("subagent"), "child");
	assert.equal(toolWaitKind("mcp__linear__get_issue"), undefined);
});

test("tracks progress and liveness independently, then records bounded cancellation timing", async () => {
	const file = await temporaryFile();
	let wall = 1_000;
	let monotonic = 10;
	const snapshots: ToolActivitySnapshot[] = [];
	const controller = new AbortController();
	const tracker = new ToolActivityTracker({
		file,
		publish: (snapshot) => snapshots.push(snapshot),
		wallNow: () => wall,
		monotonicNow: () => monotonic,
		heartbeatMs: 60_000,
	});

	tracker.start("raw-call-id", "mcp__slack__search", true, controller.signal);
	tracker.running("raw-call-id");
	wall = 2_000;
	monotonic = 1_010;
	tracker.progress("raw-call-id");
	let active = tracker.snapshot().calls[0]!;
	assert.equal(tracker.snapshot().enabled, true);
	assert.equal(active.category, "mcp");
	assert.equal(active.nested, true);
	assert.equal(active.progressAt, 2_000);
	assert.equal(active.livenessAt, 2_000);

	wall = 3_000;
	monotonic = 2_010;
	controller.abort();
	active = tracker.snapshot().calls[0]!;
	assert.equal(active.state, "cancelling");
	assert.equal(active.progressAt, 2_000, "a cancellation heartbeat is not useful progress");
	assert.equal(active.livenessAt, 3_000);

	wall = 3_500;
	monotonic = 2_510;
	tracker.finish("raw-call-id", true, 2_000);
	await tracker.close();
	assert.deepEqual(tracker.snapshot().calls, []);
	assert.equal(snapshots.at(-1)?.calls.length, 0);

	const contents = await readFile(file, "utf8");
	assert.doesNotMatch(contents, /raw-call-id|mcp__slack|search/);
	const records = contents
		.trim()
		.split("\n")
		.map((line) => parseToolActivityRecord(JSON.parse(line))!);
	const finished = records.find((record) => record.kind === "finished");
	assert.ok(finished && finished.kind === "finished");
	assert.equal(finished.outcome, "cancelled");
	assert.equal(finished.durationMs, 2_500);
	assert.equal(finished.dispatchMs, 500);
	assert.equal(finished.executionMs, 2_000);
	assert.equal(finished.cancellationWaitMs, 500);
});

test("retains interrupted nested calls and bounds live overflow", async () => {
	const file = await temporaryFile();
	let wall = 5_000;
	let monotonic = 100;
	const tracker = new ToolActivityTracker({
		file,
		publish: () => {},
		wallNow: () => wall,
		monotonicNow: () => monotonic,
		maxActive: 1,
		heartbeatMs: 60_000,
	});
	tracker.start("outer/1", "codemode", true);
	tracker.start("outer/2", "bash", true);
	assert.equal(tracker.snapshot().calls.length, 1);
	assert.equal(tracker.snapshot().dropped, 1);
	wall = 5_900;
	monotonic = 1_000;
	await tracker.close();
	const contents = await readFile(file, "utf8");
	const finished = contents
		.trim()
		.split("\n")
		.map((line) => parseToolActivityRecord(JSON.parse(line)))
		.find((record) => record?.kind === "finished");
	assert.ok(finished && finished.kind === "finished");
	assert.equal(finished.category, "codemode");
	assert.equal(finished.nested, true);
	assert.equal(finished.outcome, "interrupted");
});

test("disk schema strips unreviewed fields", () => {
	const line = toolActivityLine({
		v: 1,
		kind: "started",
		ref: "abcdef012345-1",
		at: 1,
		category: "other",
		nested: false,
		secret: "must-not-survive",
		args: { token: "no" },
	} as never);
	assert.ok(line);
	assert.deepEqual(JSON.parse(line), {
		v: 1,
		kind: "started",
		ref: "abcdef012345-1",
		at: 1,
		category: "other",
		nested: false,
	});
	assert.equal(
		toolActivityLine({
			v: 1,
			kind: "progress",
			ref: "abcdef012345-1",
			at: Number.MAX_SAFE_INTEGER,
		}),
		undefined,
	);
});

test("extension wiring observes nested codemode calls without retaining their names or IDs", async () => {
	const file = await temporaryFile();
	const tracker = new ToolActivityTracker({ file, publish: () => {}, heartbeatMs: 60_000 });
	const handlers = new Map<string, (...args: never[]) => unknown>();
	toolActivityExtension(tracker)({
		on: (name: string, handler: (...args: never[]) => unknown) => {
			handlers.set(name, handler);
			return () => {};
		},
	} as never);

	await handlers.get("tool_execution_start")?.(
		{
			toolCallId: "outer-call/1",
			toolName: "mcp__private_server__lookup",
			parentToolCallId: "outer-call",
		} as never,
		{ signal: new AbortController().signal } as never,
	);
	await handlers.get("tool_call")?.({ toolCallId: "outer-call/1" } as never);
	await handlers.get("tool_execution_update")?.({ toolCallId: "outer-call/1" } as never);
	await handlers.get("tool_execution_end")?.({ toolCallId: "outer-call/1", isError: false, durationMs: 1 } as never);
	await tracker.close();

	const contents = await readFile(file, "utf8");
	assert.doesNotMatch(contents, /outer-call|private_server|lookup/);
	const records = contents
		.trim()
		.split("\n")
		.map((line) => parseToolActivityRecord(JSON.parse(line)));
	assert.equal(
		records.some((record) => record?.kind === "started" && record.category === "mcp" && record.nested),
		true,
	);
});
