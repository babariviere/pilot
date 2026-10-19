import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Mission, SessionSummary } from "@pilot/protocol";
import { ControlActions, type ControlAuditEntry } from "./control-actions.ts";
import { createAuthorization } from "./control-authorizations.ts";
import { ControlMemory } from "./control-memory.ts";
import { ControlPilot } from "./control-pilot.ts";
import { WatchService } from "./watch-service.ts";

test("start/send use existing admissions, route mission members and durably audit intent/outcome", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-actions-")),
		memory = new ControlMemory(home),
		watches = new WatchService(":memory:");
	t.after(async () => {
		await watches.close();
		await memory.stop();
		await rm(home, { recursive: true, force: true });
	});
	const published: ControlAuditEntry[] = [],
		calls: unknown[] = [];
	const audit = new ControlActions(
		memory,
		(id) => id === "control",
		async (entry) => {
			published.push(entry);
		},
	);
	const chat = { id: "created", title: "Created", model: "test/cheap", mode: "ask" } as SessionSummary;
	const target = { id: "member", projectId: "p", missionId: "m" } as SessionSummary;
	await memory.authorizationCreate(
		createAuthorization(
			"approval",
			{
				scope: "requested work",
				level: "publish",
				targets: [{ kind: "project", id: "p" }],
				limits: { followUps: 3, budgetUsd: 10 },
			},
			{ conversationId: "1", submissionId: 1, entryId: 1, requestId: "user" },
		),
	);
	const authorized = { authorizationId: "approval", budgetUsd: 1, model: "test/cheap", mode: "ask" };
	const service = new ControlPilot({
		watches,
		isControl: (id) => id === "control",
		authorizations: () => memory,
		sessions: {
			list: () => [],
			get: (id) => ({ ...target, id }),
			history: async () => ({ entries: [], more: false }),
		},
		projects: () => [],
		missions: () => [{ id: "m", projectId: "p", coordinatorSessionId: "lead" }] as Mission[],
		linear: () => [],
		mutations: {
			audit: () => audit,
			startProject: async (request) => {
				assert.equal((await audit.page())[0]!.phase, "requested");
				calls.push(["project", request]);
				return chat;
			},
			startTask: async (...args) => {
				calls.push(["task", ...args]);
				return chat;
			},
			send: async (...args) => {
				calls.push(["send", ...args]);
				return { delivery: "queued", mode: "followUp" };
			},
		},
	});
	const project = { ...authorized, projectId: "p", message: "requested work", model: "test/cheap" };
	const result = await service.call("control", "start", project, "project");
	assert.deepEqual(await service.call("control", "start", project, "project"), result);
	assert.equal(calls.length, 1, "same call never starts twice");
	await service.call("control", "start", { ...authorized, missionId: "m", taskId: "2" }, "task");
	await service.call("control", "send", { ...authorized, sessionId: "member", message: "next" }, "send");
	await service.call(
		"control",
		"send",
		{ ...authorized, sessionId: "member", message: "direct", direct: true },
		"direct",
	);
	assert.deepEqual(calls.slice(1), [
		[
			"task",
			"m",
			"2",
			{ mode: "ask", model: "test/cheap" },
			{ authorizationId: "approval", level: "investigate" },
			"control:start:task",
			{ authorizationId: "approval", budgetUsd: 1 },
		],
		["send", "lead", "next", "control:send:send", "followUp"],
		["send", "member", "direct", "control:send:direct", "followUp"],
	]);
	const entries = await audit.page();
	assert.equal(entries.length, 8);
	assert.equal(published.length, 4);
	assert.ok(published.every((e) => e.phase === "succeeded" && e.caller === "control"));
	await assert.rejects(service.call("ordinary", "start", project, "denied"), /Only the control/);
	assert.equal((await audit.page()).length, 8);
	await assert.rejects(
		service.call("control", "start", { ...project, message: "changed" }, "project"),
		/identity reused/,
	);
	await assert.rejects(service.call("control", "start", { ...authorized, missionId: "m" }, "invalid"), /taskId/);
	await memory.auditAppend({
		operationId: "control:uncertain",
		action: "start",
		phase: "requested",
		at: 1,
		caller: "control",
		args: project,
	});
	await assert.rejects(service.call("control", "start", project, "uncertain"), /uncertain/);
	assert.equal(calls.length, 4);
	await assert.rejects(audit.page(undefined, 51), /Invalid audit page/);
});
