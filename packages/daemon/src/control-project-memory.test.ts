import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MemoryEntry } from "@pilot/protocol";
import { ControlActions } from "./control-actions.ts";
import { ControlMemory } from "./control-memory.ts";
import { ControlProjectMemory } from "./control-project-memory.ts";
import { ProjectMemoryService } from "./project-memory.ts";

test("control reads and appends across registered projects with live role checks, real origin and audit", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "control-project-memory-")),
		memory = new ProjectMemoryService(home),
		control = new ControlMemory(home);
	t.after(async () => {
		await control.stop();
		await memory.stop();
		await rm(home, { recursive: true, force: true });
	});
	let allowed = true;
	const audit = new ControlActions(
		control,
		(id) => allowed && id === "control",
		async () => {},
	);
	const access = new ControlProjectMemory(
		memory,
		(id) => {
			if (!["p", "q"].includes(id)) throw new Error("Unknown project");
		},
		(id) => allowed && id === "control",
		() => audit,
	);
	const args = { projectId: "q", text: "Fact from global control", sessionId: "forged" };
	const note = (await access.call("control", "note", args, "note")) as MemoryEntry;
	assert.equal(note.sessionId, "control");
	assert.equal(note.index, 0);
	assert.deepEqual(await access.call("control", "note", args, "note"), note);
	assert.equal((await memory.wake("q")).count, 1);
	await access.call("control", "note", { projectId: "p", text: "Other project fact" }, "other");
	await access.call("control", "note", { projectId: "q", text: "Second q fact" }, "second");
	for (const [action, extra] of [
		["wake", {}],
		["recall", { regex: "fact" }],
		["zoom", { lo: 0, hi: 1 }],
	] as const) {
		const result = (await access.call("control", action, { projectId: "q", ...extra })) as {
			untrusted: boolean;
			projectId: string;
		};
		assert.equal(result.untrusted, true);
		assert.equal(result.projectId, "q");
		assert.doesNotMatch(JSON.stringify(result), /Other project fact/);
	}
	assert.equal(
		(await audit.page()).filter((entry) => entry.phase === "succeeded" && entry.action === "memory_note").length,
		3,
	);
	await assert.rejects(access.call("control", "forget", { projectId: "q", lo: 0, hi: 1 }), /append-only/);
	assert.equal((await memory.wake("q")).count, 2);
	await assert.rejects(access.call("control", "wake", {}), /projectId/);
	await assert.rejects(access.call("control", "wake", { projectId: "unknown" }), /Unknown project/);
	await assert.rejects(access.call("control", "wake", { projectId: "../q" }), /projectId/);
	allowed = false;
	await assert.rejects(
		access.call("control", "note", { projectId: "p", text: "Denied" }, "denied"),
		/Only the control/,
	);
	await assert.rejects(access.call("ordinary", "wake", { projectId: "p" }), /Only the control/);
	assert.equal((await memory.wake("p")).count, 1);
});
