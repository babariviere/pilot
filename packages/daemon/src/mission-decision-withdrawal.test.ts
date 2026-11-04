import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MissionStore } from "./missions.ts";

for (const planningVersion of [undefined, 1] as const) {
	test(`withdrawal requires explicit user acceptance, planning ${planningVersion ?? "legacy"}`, async (t) => {
		const store = new MissionStore(":memory:");
		t.after(() => store.close());
		const { id } = store.create({ projectId: "p", title: "Choices", planningVersion });
		store.join("lead", id);
		store.join("worker", id);
		store.update(id, { coordinatorSessionId: "lead" });
		const lead = { sessionId: "lead" };
		const old = store.addDecision(id, "User-imposed constraint", lead, "all");
		const task = store.addTask(id, { title: "Pinned", decisionIds: [old.id] });
		const reason = " No longer needed\nby explicit user choice. ";
		const propose = () => store.proposeWithdrawal(id, "D1", reason, "request", lead);
		const proposal = propose();
		assert.equal(proposal.kind, "withdraw");
		assert.equal(proposal.text, undefined);
		assert.equal(proposal.reason, reason);
		assert.deepEqual(store.detail(id).decisions[0], old, "coordinator authorship grants no revocation authority");
		assert.deepEqual(propose(), proposal);
		for (const actor of [lead, { sessionId: "worker" }]) {
			assert.throws(() => store.resolveProposal(id, proposal.id, true, undefined, actor), /Only the user/);
			assert.throws(() => store.removeDecision(id, old.id, actor), /Only the user/);
		}
		let changes = 0;
		let hints = 0;
		store.onChange(() => changes++);
		store.onKnowledgeChange(() => hints++);
		const before = store.detail(id).events;
		const accepted = store.resolveProposal(id, proposal.id, true);
		const saved = store.detail(id).decisions[0]!;
		assert.deepEqual(saved, {
			...old,
			updatedAt: saved.updatedAt,
			withdrawn: { at: saved.updatedAt, reason, proposalId: proposal.id },
		});
		assert.deepEqual(store.task(id, task.id).decisionIds, [old.id]);
		assert.ok(before.every((e) => store.detail(id).events.some((n) => n.id === e.id && n.text === e.text)));
		assert.ok(store.detail(id).events.some((e) => e.text.includes("withdrawn") && !e.sessionId));
		const events = store.detail(id).events;
		assert.deepEqual(store.resolveProposal(id, proposal.id, true), accepted);
		assert.deepEqual(propose(), accepted);
		assert.throws(() => store.resolveProposal(id, proposal.id, false), /different outcome/);
		assert.throws(() => store.resolveProposal(id, proposal.id, true, "edit"), /no replacement text/);
		assert.deepEqual(store.detail(id).events, events);
		assert.equal(changes, 1);
		assert.equal(hints, 1);
		await store.durable();
	});
}

test("withdrawal validates authority, inputs, retry identity and conflicting proposals without effects", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "Choices" });
	store.join("lead", id);
	store.join("worker", id);
	store.update(id, { coordinatorSessionId: "lead" });
	const lead = { sessionId: "lead" };
	store.addDecision(id, "Protected user rule");
	store.addDecision(id, "Other");
	const other = store.create({ projectId: "q", title: "Other" });
	const foreign = store.addDecision(other.id, "Foreign");
	const before = store.detail(id);
	for (const actor of [{}, { sessionId: "worker" }, { sessionId: "missing" }])
		assert.throws(() => store.proposeWithdrawal(id, "D1", "Reason", "op", actor), /Only the mission coordinator/);
	for (const value of [undefined, null, true, 1, "", "   ", "x".repeat(8001)])
		assert.throws(() => store.proposeWithdrawal(id, "D1", value, "op", lead), /reason/);
	for (const value of [undefined, null, false, 2, "", " ", "x".repeat(129)])
		assert.throws(() => store.proposeWithdrawal(id, "D1", "Reason", value, lead), /operationId/);
	for (const ref of [foreign.id, "D99"])
		assert.throws(() => store.proposeWithdrawal(id, ref, "Reason", "op", lead), /Unknown decision/);
	assert.deepEqual(store.detail(id), before);
	const proposal = store.proposeWithdrawal(id, "D1", "Reason", "op", lead);
	assert.throws(() => store.proposeWithdrawal(id, "D2", "Reason", "op", lead), /different request/);
	assert.throws(() => store.proposeWithdrawal(id, "D1", "Reason ", "op", lead), /different request/);
	assert.throws(() => store.proposeWithdrawal(id, "D1", "Reason", "new", lead), /pending/);
	assert.throws(() => store.proposeDecision(id, "D1", "Edit", undefined, "Reason", lead), /pending withdrawal/);
	const rejected = store.resolveProposal(id, proposal.id, false);
	assert.equal(store.detail(id).decisions[0]!.withdrawn, undefined);
	assert.deepEqual(store.resolveProposal(id, proposal.id, false), rejected);
	assert.throws(() => store.resolveProposal(id, proposal.id, true), /different outcome/);
	assert.deepEqual(store.proposeWithdrawal(id, "D1", "Reason", "op", lead), rejected);
	const next = store.proposeWithdrawal(id, "D1", "Reason", "new", lead);
	store.updateDecision(id, "D1", "New user constraint");
	assert.equal(store.proposals(id).find((p) => p.id === next.id)!.status, "rejected");
	assert.throws(() => store.resolveProposal(id, next.id, true), /different outcome/);
	const pending = store.proposeWithdrawal(id, "D1", "Reason", "third", lead);
	store.join("lead", other.id);
	assert.throws(() => store.proposeWithdrawal(id, "D1", "Reason", "third", lead), /coordinator|not in this mission/);
	assert.equal(store.proposals(id).find((p) => p.id === pending.id)!.status, "pending");
});

test("withdrawal and replacement are mutually exclusive terminal transitions", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "Choices" });
	store.join("lead", id);
	store.update(id, { coordinatorSessionId: "lead" });
	const lead = { sessionId: "lead" };
	for (const text of ["One", "Two", "Three", "Four"]) store.addDecision(id, text);
	const stale = store.proposeWithdrawal(id, "D1", "Reason", "old", lead);
	store.supersedeDecision(id, "D1", "D2", lead);
	assert.throws(() => store.resolveProposal(id, stale.id, true), /Only active/);
	store.resolveProposal(id, stale.id, false);
	assert.throws(() => store.proposeWithdrawal(id, "D1", "Reason", "retry", lead), /Only active/);
	const proposal = store.proposeWithdrawal(id, "D3", "Reason", "third", lead);
	store.resolveProposal(id, proposal.id, true);
	assert.throws(() => store.supersedeDecision(id, "D3", "D4", lead), /Withdrawn/);
	assert.throws(() => store.supersedeDecision(id, "D4", "D3", lead), /withdrawn/);
	assert.throws(() => store.proposeWithdrawal(id, "D3", "Reason", "again", lead), /Only active/);
	const edit = store.proposeDecision(id, "D4", "Other", undefined, "Clarify", lead);
	assert.throws(() => store.proposeWithdrawal(id, "D4", "Reason", "fourth", lead), /pending/);
	store.resolveProposal(id, edit.id, false);
});

test("failed acceptance rolls back the marker, proposal outcome and event history together", (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "Choices" });
	store.join("lead", id);
	store.update(id, { coordinatorSessionId: "lead" });
	store.addDecision(id, "Rule");
	const proposal = store.proposeWithdrawal(id, "D1", "Reason", "request", { sessionId: "lead" });
	const before = store.detail(id);
	let changes = 0;
	store.onChange(() => changes++);
	const failure = t.mock.method(store.knowledge, "invalidateMission", () => {
		throw new Error("Synthetic storage failure");
	});
	assert.throws(() => store.resolveProposal(id, proposal.id, true), /Synthetic storage failure/);
	assert.deepEqual(store.detail(id), before);
	assert.equal(changes, 0);
	failure.mock.restore();
	assert.equal(store.resolveProposal(id, proposal.id, true).status, "accepted");
});

test("withdrawal history, retry identities and pins survive reopen; legacy records get no inferred markers", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "decision-withdrawal-"));
	const file = join(dir, "missions.sqlite");
	let store = new MissionStore(file);
	t.after(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const { id } = store.create({ projectId: "p", title: "Choices" });
	store.join("lead", id);
	store.update(id, { coordinatorSessionId: "lead" });
	const old = store.addDecision(id, "Uncertain legacy constraint");
	const task = store.addTask(id, { title: "Work", decisionIds: [old.id] });
	await store.close();
	const legacy = new DatabaseSync(file);
	legacy.exec(
		"DROP INDEX decision_proposal_operations; ALTER TABLE decisions DROP COLUMN withdrawn; ALTER TABLE decision_proposals DROP COLUMN operation_id",
	);
	legacy.close();
	store = new MissionStore(file);
	assert.equal(store.detail(id).decisions[0]!.withdrawn, undefined);
	const proposal = store.proposeWithdrawal(id, "D1", "Reason", "request", { sessionId: "lead" });
	await store.durable();
	await store.close();
	store = new MissionStore(file);
	assert.deepEqual(store.proposals(id), [proposal]);
	assert.equal(store.detail(id).decisions[0]!.withdrawn, undefined);
	const accepted = store.resolveProposal(id, proposal.id, true);
	const saved = store.detail(id).decisions[0];
	store.addDecision(id, "Other rule");
	const rejectedProposal = store.proposeWithdrawal(id, "D2", "Reason", "rejected-request", { sessionId: "lead" });
	const rejected = store.resolveProposal(id, rejectedProposal.id, false);
	await store.durable();
	await store.close();
	store = new MissionStore(file);
	assert.deepEqual(store.detail(id).decisions[0], saved);
	assert.deepEqual(store.task(id, task.id).decisionIds, [old.id]);
	assert.deepEqual(
		store.proposals(id).find((p) => p.id === rejected.id),
		rejected,
	);
	assert.equal(store.detail(id).decisions[1]!.withdrawn, undefined);
	assert.deepEqual(store.resolveProposal(id, proposal.id, true), accepted);
	assert.deepEqual(store.proposeWithdrawal(id, "D1", "Reason", "request", { sessionId: "lead" }), accepted);
});
