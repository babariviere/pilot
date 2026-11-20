import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@pilot/protocol";
import { dayWaiting, dayWorking } from "./day-working.ts";

test("a chat whose input waits for a coding slot shows as waiting, not working", () => {
	const chat = (id: string, extra: Partial<SessionSummary>) =>
		({ id, title: id, projectId: "p", working: true, state: "working", ...extra }) as SessionSummary;
	const sessions = [
		chat("running", {}),
		chat("queued", {
			state: "parked",
			codingQueueReason: "Waiting for a project coding slot (2 of 2 occupied).",
			codingQueue: { kind: "slots", position: 1, holders: ["running"] },
		}),
	];
	assert.deepEqual(
		dayWorking("p", sessions, [], [], new Set()).map((r) => r.sessionId),
		["running"],
	);
	assert.deepEqual(
		dayWaiting("p", sessions, []).map((r) => r.sessionId),
		["queued"],
	);
});
