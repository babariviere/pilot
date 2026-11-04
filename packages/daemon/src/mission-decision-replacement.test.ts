import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MissionStore } from "./missions.ts";

for (const planningVersion of [undefined, 1] as const) {
	test(`decision replacement is coordinator/user-only with planning ${planningVersion ?? "legacy"}`, (t) => {
		const store = new MissionStore(":memory:");
		t.after(() => store.close());
		const { id } = store.create({ projectId: "p", title: "Choices", planningVersion });
		store.join("lead", id);
		store.join("worker", id);
		store.update(id, { coordinatorSessionId: "lead" });
		const lead = { sessionId: "lead" };
		const old = store.addDecision(id, "Original authorized text", lead, "all");
		const replacement = store.addDecision(id, "Already agreed replacement", lead, "reference");
		const task = store.addTask(id, { title: "Pinned", decisionIds: ["D1"] });
		const proposal = store.proposeDecision(id, "D1", "Proposed wording", undefined, "Clarify", lead);
		const events = store.detail(id).events;
		assert.throws(
			() => store.supersedeDecision(id, "D1", "D2", { sessionId: "worker" }),
			/Only the mission coordinator/,
		);
		assert.throws(() => store.supersedeDecision(id, "D1", "D2", { sessionId: "outsider" }), /not in this mission/);
		assert.deepEqual(store.detail(id).events, events);
		let changes = 0;
		let hints = 0;
		store.onChange(() => changes++);
		store.onKnowledgeChange((projectId) => {
			assert.equal(projectId, "p");
			hints++;
		});
		const saved = store.supersedeDecision(id, "D1", "d2", lead);
		assert.deepEqual(saved, {
			...old,
			updatedAt: saved.updatedAt,
			replacement: { id: replacement.id, number: 2, at: saved.updatedAt },
		});
		assert.deepEqual(store.task(id, task.id).decisionIds, [old.id]);
		assert.deepEqual(store.proposals(id), [proposal], "recording a link neither accepts nor deletes a proposal");
		assert.deepEqual(store.detail(id).decisions[1], replacement);
		assert.ok(
			events.every((event) =>
				store.detail(id).events.some((current) => current.id === event.id && current.text === event.text),
			),
		);
		assert.equal(changes, 1);
		assert.equal(hints, 1);
		const after = store.detail(id).events;
		assert.equal(after[0]!.text, "Decision D1 replaced by D2");
		assert.equal(after[0]!.sessionId, "lead");
		assert.deepEqual(store.supersedeDecision(id, old.id, replacement.id, lead), saved);
		assert.deepEqual(store.supersedeDecision(id, "D1", "D2"), saved);
		assert.equal(changes, 1);
		assert.equal(hints, 1);
		assert.deepEqual(store.detail(id).events, after);
		assert.throws(() => store.updateDecision(id, old.id, "Changed", lead), /Only the user/);
		assert.throws(() => store.removeDecision(id, old.id, lead), /Only the user/);
		assert.throws(() => store.resolveProposal(id, proposal.id, true, undefined, lead), /Only the user/);
		assert.equal(store.updateDecision(id, old.id, "User edit").replacement?.id, replacement.id);
		const third = store.addDecision(id, "Third");
		assert.equal(
			store.supersedeDecision(id, replacement.id, third.id).replacement?.id,
			third.id,
			"user can record links too",
		);
		store.removeDecision(id, third.id);
		assert.equal(
			store.detail(id).decisions[1]!.replacement?.id,
			third.id,
			"user removal preserves the recorded target identity",
		);
		assert.equal(
			store.supersedeDecision(id, replacement.id, "D3").replacement?.id,
			third.id,
			"retry remains harmless after target removal",
		);
	});
}

test("replacement rejects self, cross-mission, missing, cyclic and conflicting links without effects", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "Choices" });
	const choices = ["One", "Two", "Three", "Four"].map((text) => store.addDecision(id, text));
	const other = store.create({ projectId: "p", title: "Other" });
	const foreign = store.addDecision(other.id, "Elsewhere");
	store.supersedeDecision(id, "D1", "D2");
	store.supersedeDecision(id, "D2", "D3");
	const before = store.detail(id);
	let hints = 0;
	store.onChange(() => hints++);
	store.onKnowledgeChange(() => hints++);
	for (const [from, to, error] of [
		["D4", "D4", /self-referential/],
		["D4", choices[3]!.id, /self-referential/],
		["D3", "D1", /cyclic/],
		["D1", "D3", /different replacement/],
		["D4", foreign.id, /Unknown decision/],
		[foreign.id, "D4", /Unknown decision/],
		["D4", "D99", /Unknown decision/],
	] as const)
		assert.throws(() => store.supersedeDecision(id, from, to), error);
	assert.deepEqual(store.detail(id), before);
	assert.equal(hints, 0);
});

test("replacement metadata and historical pins persist durably, without legacy backfill", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "decision-replacement-"));
	const file = join(dir, "missions.sqlite");
	let store = new MissionStore(file);
	t.after(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const { id } = store.create({ projectId: "p", title: "Choices", tasks: [{ title: "Work" }] });
	const old = store.addDecision(id, "Keep this exact text");
	store.addDecision(id, "Replacement");
	store.updateTask(id, "1", { decisionIds: [old.id] });
	await store.durable();
	await store.close();
	const legacy = new DatabaseSync(file);
	legacy.exec("ALTER TABLE decisions DROP COLUMN replacement");
	legacy.close();
	store = new MissionStore(file);
	assert.ok(store.detail(id).decisions.every((d) => d.replacement === undefined));
	const saved = store.supersedeDecision(id, "D1", "D2");
	await store.durable();
	await store.close();
	store = new MissionStore(file);
	assert.deepEqual(store.detail(id).decisions[0], saved);
	assert.deepEqual(store.resolveTask(id, "1").decisionIds, [old.id]);
	const eventCount = store.detail(id).events.length;
	assert.deepEqual(store.supersedeDecision(id, "D1", "D2"), saved);
	assert.equal(store.detail(id).events.length, eventCount);
});
