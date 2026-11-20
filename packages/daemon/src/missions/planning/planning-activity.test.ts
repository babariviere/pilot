import assert from "node:assert/strict";
import test from "node:test";
import type { EntryRecord } from "@pilot/protocol";
import {
	CHAT_TEXT_BYTES,
	PlanningActivityNotices,
	planningActivity,
	planningChatPage,
	planningStep,
} from "./planning-activity.ts";

const entry = (id: number, kind: string, model: unknown[] = []) => ({ id, kind, model }) as unknown as EntryRecord;
const assistant = (id: number, at: number, ...content: unknown[]) =>
	entry(id, "pi.assistant", [{ role: "assistant", timestamp: at, content }]);
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: number, at: number, callId: string, isError = false) =>
	entry(id, "pi.tool-result", [{ role: "toolResult", timestamp: at, toolCallId: callId, isError, content: [] }]);
const run = { sessionId: "s", working: true, workingSince: 100, cwd: "/repo" };

test("steps keep only small known arguments, with paths relative to the chat", () => {
	assert.deepEqual(planningStep({ name: "read", arguments: { path: "/repo/docs/a.md", limit: 9 } }, "/repo"), {
		tool: "read",
		running: true,
		failed: false,
		target: "docs/a.md",
	});
	assert.deepEqual(
		planningStep({ name: "grep", arguments: { pattern: "plan\nmap", path: "/repo" } }, "/repo", { failed: true }),
		{ tool: "grep", running: false, failed: true, target: "plan map" },
	);
	const write = planningStep(
		{ name: "mission_plan", arguments: { action: "write", request: { purpose: "plan-map", secret: "x" } } },
		"/repo",
	);
	assert.deepEqual(write, { tool: "mission_plan", running: true, failed: false, action: "plan-map" });
	assert.equal(planningStep({ name: "read", arguments: { path: "/elsewhere/x" } }, "/repo").target, "/elsewhere/x");
	assert.equal(planningStep({ name: "web", arguments: { query: "q".repeat(500) } }, "/repo").target?.length, 200);
});

test("activity names the current run's newest step and when anything was last saved", () => {
	const entries = [
		entry(1, "pi.user", [{ role: "user", timestamp: 90, content: "old" }]),
		assistant(2, 110, { type: "text", text: "Looking" }, call("a", "read", { path: "/repo/x" })),
		result(3, 120, "a"),
		assistant(4, 130, call("b", "grep", { pattern: "map" })),
	];
	const live = planningActivity(run, entries);
	assert.deepEqual(live, {
		sessionId: "s",
		working: true,
		workingSince: 100,
		lastStepAt: 130,
		step: { tool: "grep", running: true, failed: false, target: "map" },
	});
	assert.equal(planningActivity(run, [...entries, result(5, 140, "b")]).step?.running, false);
	assert.equal(planningActivity({ ...run, toolProgressAt: 200 }, entries).lastStepAt, 200);
	// A new input starts a new run: the old run's step is not the current one.
	const next = [...entries, entry(6, "pilot.planning-input")];
	assert.equal(planningActivity(run, next).step, null);
	const idle = planningActivity({ ...run, working: false }, entries);
	assert.equal(idle.step, null);
	assert.equal(idle.workingSince, null);
	assert.equal(planningActivity(run, []).lastStepAt, null);
});

test("chat pages are compact rows and only the newest page has running steps", () => {
	const big = "é".repeat(CHAT_TEXT_BYTES);
	const history = {
		entries: [
			result(13, 5, "c"),
			entry(10, "pilot.planning-input", []),
			entry(11, "pi.user", [{ role: "user", content: "Go" }]),
			assistant(12, 4, { type: "text", text: big }, call("c", "read", { path: "/repo/a" }), call("d", "ls", {})),
			entry(14, "pi.compaction"),
		],
		more: true,
	};
	const page = planningChatPage({ missionId: "m", sessionId: "s", cwd: "/repo", newest: true }, history);
	assert.deepEqual(
		page.rows.map((r) => [r.key, r.role]),
		[
			["10", "request"],
			["11", "you"],
			["12", "pilot"],
			["12.0", "step"],
			["12.1", "step"],
		],
	);
	const pilot = page.rows[2] as { text: string; shortened: boolean };
	assert.equal(pilot.shortened, true);
	assert.ok(Buffer.byteLength(pilot.text) <= CHAT_TEXT_BYTES);
	assert.ok(!pilot.text.includes("\uFFFD"));
	assert.deepEqual(
		page.rows.slice(3).map((r) => (r as { step: { running: boolean } }).step.running),
		[false, true],
	);
	assert.equal(page.more, true);
	assert.equal(page.nextBefore, 10);
	const older = planningChatPage({ missionId: "m", sessionId: "s", cwd: "/repo", newest: false }, history);
	assert.equal((older.rows[4] as { step: { running: boolean } }).step.running, false);
	const first = planningChatPage(
		{ missionId: "m", sessionId: "s", cwd: "/repo", newest: true },
		{
			entries: [entry(1, "pi.user", [{ role: "user", content: "Go" }])],
			more: true,
		},
	);
	assert.equal(first.more, false);
});

test("notices go at once, then at most one per interval, and the last change is never lost", async () => {
	let now = 0;
	const sent: string[] = [];
	const notices = new PlanningActivityNotices(
		(id) => sent.push(id),
		20,
		() => now,
	);
	notices.touch("m");
	notices.touch("m");
	notices.touch("other");
	assert.deepEqual(sent, ["m", "other"]);
	now = 5;
	notices.touch("m");
	notices.touch("m");
	assert.deepEqual(sent, ["m", "other"]);
	now = 20;
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.deepEqual(sent, ["m", "other", "m"]);
	notices.touch("m");
	notices.close();
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.deepEqual(sent, ["m", "other", "m"]);
});
