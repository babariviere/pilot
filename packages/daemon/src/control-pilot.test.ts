import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mission, Project, SessionSummary } from "@pilot/protocol";
import { createPilotTool } from "../../kernel/src/pilot-tool.ts";
import { ControlPilot } from "./control-pilot.ts";
import type { SessionManager } from "./sessions.ts";

function chat(id: string, projectId = "p", missionId?: string): SessionSummary {
	return {
		id,
		title: `chat ${id}`,
		projectId,
		...(missionId ? { missionId } : {}),
		cwd: "/unused",
		createdAt: 0,
		updatedAt: 0,
		state: "parked",
		pullRequests: [
			{ number: 1, url: "https://example.com/pr/1", title: "quoted title", state: "open", checkedAt: 0 },
		],
	};
}
function fixture(count = 3) {
	let allowed = true,
		reads = 0;
	const chats = Array.from({ length: count }, (_, i) =>
		chat(String(i), i === 1 ? "q" : "p", i === 2 ? "m" : undefined),
	);
	const service = new ControlPilot({
		isControl: (id) => allowed && id === "control",
		sessions: {
			list: (query) =>
				chats.filter(
					(chat) =>
						(!query?.projectId || chat.projectId === query.projectId) &&
						(!query?.missionId || chat.missionId === query.missionId),
				),
			get: (id) => chats.find((chat) => chat.id === id),
			history: async (_id, _before, limit) => {
				reads++;
				assert.ok(limit <= 64);
				return {
					more: true,
					entries: [
						{
							id: 1,
							kind: "pi.assistant",
							model: [
								{
									role: "assistant",
									content: [
										{ type: "thinking", thinking: "hidden" },
										{ type: "text", text: `quoted result ${"x".repeat(20_000)}` },
									],
								},
							],
						},
					],
				} as unknown as Awaited<ReturnType<SessionManager["history"]>>;
			},
		},
		projects: () =>
			[
				{ id: "p", name: "Project" },
				{ id: "q", name: "Other" },
			] as Project[],
		missions: () =>
			[{ id: "m", projectId: "p", title: "Mission", status: "active", tasksDone: 1, tasksTotal: 2 }] as Mission[],
		linear: (id) => [{ id: `${id}-ticket`, title: "quoted ticket", missionId: "m" }],
	});
	return {
		service,
		revoke: () => {
			allowed = false;
		},
		reads: () => reads,
	};
}
test("status is bounded, filters every resource, and reads only cached state", async () => {
	const f = fixture(500);
	const status = (await f.service.call("control", "status", { missionId: "m" })) as {
		chats: Array<{ id: string }>;
		missions: Array<{ id: string }>;
		linear: Array<{ projectId: string }>;
		source: string;
		untrusted: boolean;
	};
	assert.deepEqual(
		status.chats.map((c) => c.id),
		["2"],
	);
	assert.deepEqual(
		status.missions.map((m) => m.id),
		["m"],
	);
	assert.ok(status.linear.every((item) => item.projectId === "p"));
	assert.equal(status.source, "daemon-memory");
	assert.equal(status.untrusted, true);
	assert.equal(f.reads(), 0);
	const all = (await f.service.call("control", "status", {})) as { truncated: boolean };
	assert.ok(Buffer.byteLength(JSON.stringify(all)) <= 24_000);
	assert.equal(all.truncated, true);
	await assert.rejects(f.service.call("control", "status", { projectId: "q", missionId: "m" }), /another project/);
	await assert.rejects(f.service.call("control", "status", { projectId: "unknown" }), /Unknown project/);
});
test("read is a single bounded cold tail/result, quotes data and omits thoughts", async () => {
	const f = fixture();
	const result = (await f.service.call("control", "read", { sessionId: "0" })) as {
		quotedContent: Array<{ text: string }>;
		untrusted: boolean;
		truncated: boolean;
	};
	assert.equal(f.reads(), 1);
	assert.equal(result.untrusted, true);
	assert.equal(result.truncated, true);
	assert.equal(result.quotedContent[0]!.text.length, 12_000);
	assert.doesNotMatch(JSON.stringify(result), /hidden/);
	await f.service.call("control", "read", { sessionId: "0", view: "tail", limit: 40 });
	assert.equal(f.reads(), 2);
	await assert.rejects(f.service.call("control", "read", { sessionId: "0", limit: 41 }));
	await assert.rejects(f.service.call("control", "read", { sessionId: "unknown" }));
	f.revoke();
	await assert.rejects(f.service.call("control", "read", { sessionId: "0" }), /Only the control/);
	assert.equal(f.reads(), 2);
});
test("pilot has a short schema and forwards only supplied arguments", async () => {
	const calls: unknown[] = [];
	const tool = createPilotTool(async (action, args) => {
		calls.push([action, args]);
		return { untrusted: true };
	});
	assert.ok(tool.description.length < 200);
	await tool.execute(
		"read",
		{ action: "read", sessionId: "target", view: "tail", limit: 10 },
		undefined,
		undefined,
		{} as never,
	);
	assert.deepEqual(calls, [["read", { sessionId: "target", view: "tail", limit: 10 }]]);
	for (const action of ["stop", "pause", "resume", "redirect"] as const) {
		const args = {
			sessionId: "target",
			authorizationId: "approval",
			direct: true,
			...(action === "resume" || action === "redirect" ? { budgetUsd: 1 } : {}),
			...(action === "redirect" ? { message: "New instruction" } : {}),
		};
		await tool.execute(action, { action, ...args }, undefined, undefined, {} as never);
		assert.deepEqual(calls.at(-1), [action, args]);
	}
});
