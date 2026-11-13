import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { missionPrompt } from "../../kernel/src/policy.ts";
import type { MissionRevisionDelta } from "../../protocol/src/mission-revision.ts";
import { MissionReports } from "./mission-reports.ts";
import { MissionStore } from "./missions.ts";
import { missionContextFixture } from "./testing/mission-context.ts";

function proposal(store: MissionStore, id: string, delta: MissionRevisionDelta) {
	return store.revisions.propose(
		id,
		{ operationId: randomUUID(), source: store.revisions.source(id), summary: "Reviewed scope change", delta },
		{},
	);
}
function pauseFixture(store: MissionStore, id: string) {
	const current = store.controls.current(id);
	store.controls.write(
		{
			version: 1,
			missionId: id,
			state: "acknowledged",
			ownerFence: "synthetic",
			command: {
				version: 1,
				operationId: randomUUID(),
				home: { daemonId: "test", lineageId: "test" },
				projectId: store.require(id).projectId,
				coordinatorSessionId: store.require(id).coordinatorSessionId ?? null,
				expectedRevision: current.revision,
				action: "pause",
			},
			control: { ...current, revision: current.revision + 1, held: true, state: "paused" },
			members: [],
		},
		current.revision,
	);
}

test("Revisit re-preview after Pause creates fresh exact bytes, never confirms or resumes", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "M", brief: "Kept agreement", tasks: [{ title: "Open" }] });
	store.join("lead", id);
	store.update(id, { coordinatorSessionId: "lead" });
	const original = await proposal(store, id, { markdown: "Reviewed replacement" });
	assert.equal(store.revisions.pending(id)?.proposal.id, original.id);
	assert.equal(store.revisions.pending(id)?.current, true);
	pauseFixture(store, id);
	const control = store.controls.current(id);
	assert.equal(store.revisions.pending(id)?.current, false);
	await assert.rejects(
		store.revisions.confirm(id, original.id, { digest: original.digest, humanSource: "user" }),
		/source changed/,
	);
	const input = { operationId: randomUUID(), source: store.revisions.source(id), digest: original.digest };
	const fresh = await store.revisions.repreview(id, original.id, input);
	assert.deepEqual(store.revisions.lookup(id, input.operationId), fresh);
	assert.equal(store.revisions.lookup(id, "missing"), null);
	assert.notEqual(fresh.id, original.id);
	assert.notEqual(fresh.digest, original.digest);
	assert.deepEqual(fresh.delta, original.delta);
	assert.deepEqual(fresh.repreviewOf, { id: original.id, digest: original.digest });
	assert.equal(store.brief(id)?.markdown, "Kept agreement");
	await store.revisions.confirm(id, fresh.id, { digest: fresh.digest, humanSource: "user:new-preview" });
	assert.equal(store.brief(id)?.markdown, "Reviewed replacement");
	assert.deepEqual(store.controls.current(id), control);
	assert.equal(store.revisions.get(id, original.id).confirmation, undefined);
	assert.equal(store.revisions.pending(id), null);
	assert.deepEqual(store.revisions.lookup(id, input.operationId), store.revisions.get(id, fresh.id));
	assert.deepEqual(await store.revisions.repreview(id, original.id, input), store.revisions.get(id, fresh.id));
	await assert.rejects(store.revisions.repreview(id, original.id, { ...input, source: "changed" }), /different bytes/);
	await assert.rejects(
		store.revisions.repreview(id, fresh.id, { ...input, operationId: randomUUID(), digest: fresh.digest }),
		/history/,
	);
});

test("Revisit fresh preview still fences later edits, Stop, changed digests and task history", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "M", tasks: [{ title: "Open" }] });
	const original = await proposal(store, id, { tasks: [{ id: "1", title: "New title" }] });
	const input = () => ({ operationId: randomUUID(), source: store.revisions.source(id), digest: original.digest });
	await assert.rejects(store.revisions.repreview(id, original.id, { ...input(), digest: "wrong" }), /digest/);
	const fresh = await store.revisions.repreview(id, original.id, input());
	store.controls.stop(id);
	await assert.rejects(
		store.revisions.confirm(id, fresh.id, { digest: fresh.digest, humanSource: "user" }),
		/source changed/,
	);
	store.updateTask(id, "1", { status: "done" });
	await assert.rejects(store.revisions.repreview(id, original.id, input()), /historical/);
});

test("proposals are inert; exact user confirmation appends history and never edits completed work", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({
		projectId: "p",
		title: "M",
		brief: "Old agreement",
		tasks: [{ title: "Open" }, { title: "Finished" }],
	});
	store.updateTask(id, "2", { status: "done" });
	const done = store.resolveTask(id, "2");
	const old = store.addDecision(id, "Old choice", {}, "all");
	const p = await proposal(store, id, {
		markdown: "New agreement",
		tasks: [{ id: "1", title: "Changed", drop: true }],
		decisions: [{ id: old.id, action: "replace", text: "New choice", reason: "New evidence" }],
		corrections: [
			{ kind: "instruction", text: "Suggested coordination" },
			{ kind: "permission", text: "Separate approval needed" },
		],
	});
	assert.equal(store.brief(id)?.markdown, "Old agreement");
	assert.equal(store.resolveTask(id, "1").title, "Open");
	await assert.rejects(store.revisions.confirm(id, p.id, { digest: "wrong", humanSource: "user:answer" }), /digest/);
	const confirmed = await store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "user:answer" });
	assert.equal(confirmed.confirmation?.by, "user");
	assert.equal(store.brief(id, 1)?.markdown, "Old agreement");
	assert.equal(store.brief(id)?.markdown, "New agreement");
	assert.equal(store.resolveTask(id, "1").status, "dropped");
	assert.deepEqual(store.resolveTask(id, "2"), done);
	const history = store.detail(id).decisions;
	assert.equal(history[0]?.text, "Old choice");
	assert.equal(history[0]?.replacement?.reason, "New evidence");
	assert.equal(history[0]?.replacement?.humanSource, "user:answer");
	assert.equal(history[1]?.text, "New choice");
	assert.equal(store.controls.current(id).revision, 0);
	const head = store.sharedHead();
	assert.deepEqual(
		await store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "user:answer" }),
		confirmed,
	);
	assert.equal(store.sharedHead(), head, "retry is a receipt, not another application");
	await assert.rejects(proposal(store, id, { tasks: [{ id: "2", title: "Rewrite history" }] }), /historical/);
});

test("concurrent edits, owner ABA, Stop and Pause invalidate reviewed sources", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "M", tasks: [{ title: "Open" }] });
	for (const change of [
		() => store.updateTask(id, "1", { body: "Concurrent edit" }),
		() => {
			store.join("lead", id);
			store.update(id, { coordinatorSessionId: "lead" });
			store.update(id, { coordinatorSessionId: null });
			store.leave("lead");
		},
		() => store.controls.stop(id),
		() => pauseFixture(store, id),
	]) {
		const p = await proposal(store, id, { goal: "New goal" });
		change();
		await assert.rejects(
			store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "user:answer" }),
			/source changed/,
		);
		assert.equal(store.require(id).goal, "");
	}
});

test("running assignments require a safe Pause; apply keeps holds and invalidates old report sources", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "M", planningVersion: 1, tasks: [{ title: "Work" }] });
	store.join("worker", id);
	store.updateTask(id, "1", { sessionId: "worker" });
	const first = await proposal(store, id, { tasks: [{ id: "1", body: "New scope" }] });
	await assert.rejects(
		store.revisions.confirm(id, first.id, { digest: first.digest, humanSource: "user:answer" }),
		/Pause/,
	);
	pauseFixture(store, id);
	await store.durable();
	const reports = new MissionReports(store),
		old = reports.source(id, "worker", store.resolveTask(id, "1").id);
	const held = store.controls.current(id);
	const p = await proposal(store, id, {
		tasks: [
			{
				id: "1",
				body: "New scope",
				assignment: {
					version: 1,
					expectedRevision: 0,
					intent: "New outcome",
					scope: "Narrow scope",
					criteria: ["Checked"],
				},
			},
		],
	});
	await store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "user:answer" });
	assert.deepEqual(store.controls.current(id), held);
	assert.equal(store.resolveTask(id, "1").sessionId, "worker");
	assert.equal(store.resolveTask(id, "1").assignment?.revision, 1);
	assert.notEqual(reports.source(id, "worker", store.resolveTask(id, "1").id).source, old.source);
	await assert.rejects(
		reports.write(id, "worker", {
			version: 1,
			reportId: randomUUID(),
			taskId: old.taskId,
			source: old.source,
			expectedPreviousId: old.expectedPreviousId,
			movement: "moving",
			summary: "Old assignment",
			nextStep: "Wait",
			evidence: [],
		}),
		/changed|stale/i,
	);
});

test("durable reopen keeps proposal identity, replacement chains, provenance and lookup-only receipts", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mission-revision-"));
	let store = new MissionStore(join(dir, "missions.sqlite"));
	t.after(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const { id } = store.create({ projectId: "p", title: "M" });
	const first = store.addDecision(id, "First");
	const p = await proposal(store, id, {
		decisions: [{ id: first.id, action: "replace", text: "Second", reason: "First correction" }],
	});
	store.close();
	store = new MissionStore(join(dir, "missions.sqlite"));
	assert.deepEqual(store.revisions.get(id, p.id), p);
	await store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "user:one" });
	const second = store.detail(id).decisions[1]!;
	const next = await proposal(store, id, {
		decisions: [{ id: second.id, action: "withdraw", reason: "Misclassified instruction" }],
	});
	await store.revisions.confirm(id, next.id, { digest: next.digest, humanSource: "user:two" });
	store.close();
	store = new MissionStore(join(dir, "missions.sqlite"));
	assert.equal(store.detail(id).decisions[0]?.replacement?.id, second.id);
	assert.equal(store.detail(id).decisions[1]?.withdrawn?.humanSource, "user:two");
	const head = store.sharedHead();
	await store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "user:one" });
	assert.equal(store.sharedHead(), head);
});

test("default context and decision reads exclude retired bodies; explicit history remains exact", async (t) => {
	const f = missionContextFixture(2, 2);
	t.after(() => f.store.close());
	f.store.writeBrief(f.id, "Prior full plan", 0);
	f.store.writeBrief(f.id, "Current agreement", 1);
	const retired = f.store.addDecision(f.id, "SECRET_RETIRED_BODY", {}, "all");
	const active = f.store.addDecision(f.id, "Current guidance", {}, "all");
	f.store.supersedeDecision(f.id, retired.id, active.id);
	const context = f.service.context(f.members[0]!)!;
	assert.doesNotMatch(JSON.stringify(context), /SECRET_RETIRED_BODY|Prior full plan/);
	assert.match(missionPrompt(context), /Current agreement/);
	assert.match(missionPrompt(context), /never reset or compact automatically/);
	const current = await f.service.call(f.members[0]!, "decisions", {});
	assert.doesNotMatch(JSON.stringify(current), /SECRET_RETIRED_BODY/);
	const history = await f.service.call(f.members[0]!, "decisions", { filter: "all" });
	assert.match(JSON.stringify(history), /SECRET_RETIRED_BODY.*historical.*binding/);
	const brief = await f.service.call(f.members[0]!, "brief", { revision: 1 });
	assert.match(JSON.stringify(brief), /Prior full plan.*historical.*binding/);
	await assert.rejects(f.service.call(f.members[1]!, "revision-propose", {}), /coordinator/);
});

test("concurrent confirmations serialize and failed applications roll back without notices", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({
		projectId: "p",
		title: "M",
		brief: "Original",
		tasks: [{ title: "One" }, { title: "Two" }],
	});
	const one = await proposal(store, id, { markdown: "First" });
	const two = await proposal(store, id, { markdown: "Second" });
	const outcomes = await Promise.allSettled(
		[one, two].map((p) => store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "user:answer" })),
	);
	assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(store.briefRevisions(id).length, 2);
	const rollback = await proposal(store, id, { markdown: "Not committed", tasks: [{ id: "1", body: "Changed" }] });
	const before = store.detail(id),
		changes: string[] = [],
		knowledge: string[] = [];
	store.onChange((id) => changes.push(id));
	store.onKnowledgeChange((id) => knowledge.push(id));
	const fail = t.mock.method(store, "updateTask", () => {
		throw new Error("Injected storage failure");
	});
	await assert.rejects(
		store.revisions.confirm(id, rollback.id, { digest: rollback.digest, humanSource: "user:answer" }),
		/Injected/,
	);
	fail.mock.restore();
	assert.deepEqual(store.detail(id), before);
	assert.deepEqual(changes, []);
	assert.deepEqual(knowledge, []);
	assert.equal(store.revisions.get(id, rollback.id).confirmation, undefined);
});

test("Unknown controls refuse application and lost durable acknowledgement never reapplies", async (t) => {
	const store = new MissionStore(":memory:");
	t.after(() => store.close());
	const { id } = store.create({ projectId: "p", title: "M", brief: "Original" });
	const p = await proposal(store, id, { markdown: "Confirmed" });
	const fail = t.mock.method(store, "durable", async () => {
		throw new Error("Unknown save acknowledgement");
	});
	await assert.rejects(store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "user:answer" }), /Unknown/);
	fail.mock.restore();
	const receipt = await store.revisions.confirm(id, p.id, { digest: p.digest, humanSource: "user:answer" });
	assert.equal(receipt.confirmation?.by, "user");
	assert.equal(store.briefRevisions(id).length, 2, "no duplicate brief after lost acknowledgement");
	store.join("worker", id);
	pauseFixture(store, id);
	await store.durable();
	const control = store.controls.current(id);
	store.controls.write(
		{
			version: 1,
			missionId: id,
			state: "unknown",
			ownerFence: "synthetic",
			command: {
				version: 1,
				operationId: randomUUID(),
				home: { daemonId: "test", lineageId: "test" },
				projectId: "p",
				coordinatorSessionId: null,
				expectedRevision: control.revision,
				action: "pause",
			},
			control: { ...control, revision: control.revision + 1, state: "unknown" },
			members: [{ sessionId: "worker", state: "unknown" }],
		},
		control.revision,
	);
	await store.durable();
	const unknown = await proposal(store, id, { goal: "Changed" });
	await assert.rejects(
		store.revisions.confirm(id, unknown.id, { digest: unknown.digest, humanSource: "user:answer" }),
		/Pause/,
	);
	assert.equal(store.controls.current(id).state, "unknown");
});
