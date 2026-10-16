import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Mission, SessionSummary } from "@pilot/protocol";
import { ControlActions } from "./control-actions.ts";
import { ControlMemory } from "./control-memory.ts";
import { ControlPilot } from "./control-pilot.ts";

test("creation and lead start reuse services, audit separately, and notices cannot authorize them", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-create-")),
		memory = new ControlMemory(home);
	t.after(async () => {
		await memory.stop();
		await rm(home, { recursive: true, force: true });
	});
	const audit = new ControlActions(
			memory,
			() => true,
			async () => {},
		),
		calls: unknown[] = [];
	let notice = false,
		fail = false;
	const service = new ControlPilot({
		isControl: (id) => id === "control",
		sessions: { list: () => [], get: () => undefined, history: async () => ({ entries: [], more: false }) },
		projects: () => [],
		missions: () => [],
		linear: () => [],
		mutations: {
			audit: () => audit,
			startProject: async () => {
				throw new Error("wrong path");
			},
			startTask: async () => {
				throw new Error("wrong path");
			},
			send: async () => {
				throw new Error("wrong path");
			},
			organizeAllowed: () => !notice,
			createMission: async (request) => {
				calls.push(["create", request]);
				return { id: "m", projectId: "p", title: "Goal" } as Mission;
			},
			startCoordinator: async (...args) => {
				calls.push(["start", ...args]);
				if (fail) throw new Error("price admission refused");
				return { id: "lead", model: "cheap" } as SessionSummary;
			},
		},
	});
	const args = { projectId: "p", goal: "Goal", brief: "# Draft", authorization: "user_request" };
	await service.call("control", "mission_create", args, "create");
	assert.deepEqual(calls, [
		["create", { projectId: "p", goal: "Goal", title: "Goal", brief: "# Draft", startCoordinator: false }],
		["start", "m", {}],
	]);
	assert.deepEqual(
		(await audit.page()).map((e) => [e.action, e.phase]),
		[
			["coordinator_start", "succeeded"],
			["coordinator_start", "requested"],
			["mission_create", "succeeded"],
			["mission_create", "requested"],
		],
	);
	await service.call("control", "mission_create", args, "create");
	assert.equal(calls.length, 2);
	notice = true;
	await assert.rejects(
		service.call("control", "mission_create", { ...args, authorization: "accepted_suggestion" }, "watch"),
		/forbidden/,
	);
	assert.equal(calls.length, 2);
	notice = false;
	await assert.rejects(
		service.call("control", "mission_create", { ...args, authorization: undefined }, "no-approval"),
		/User request/,
	);
	fail = true;
	await assert.rejects(service.call("control", "mission_create", args, "partial"), /price admission/);
	const entries = await audit.page();
	assert.equal(entries[0]!.phase, "failed");
	assert.equal(entries[2]!.action, "mission_create");
	assert.equal(entries[2]!.phase, "succeeded", "creation is not falsely rolled back when lead start fails");
});
