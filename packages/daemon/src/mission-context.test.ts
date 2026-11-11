import assert from "node:assert/strict";
import { test } from "node:test";
import type { MissionContext } from "@pilot/kernel";
import { decisionNotice } from "../../kernel/src/mission-decisions.ts";
import { operations } from "./event-loop-watchdog.ts";
import { missionContextFixture } from "./testing/mission-context.ts";

test("decision routing uses current owned pins, explicit invariants and coordinator uncertainty", (t) => {
	const f = missionContextFixture(3, 4);
	t.after(() => f.store.close());
	const [lead, worker, other, idle] = f.members as [string, string, string, string];
	const scoped = f.store.addDecision(f.id, "Scoped rule");
	const unknown = f.store.addDecision(f.id, "Unassociated guidance");
	const global = f.store.addDecision(f.id, "Safety invariant", {}, "all");
	const coordinator = f.store.addDecision(f.id, "Coordination only", {}, "coordinator");
	const unassigned = f.service.context(worker)!;
	f.store.updateTask(f.id, "1", { sessionId: worker, decisionIds: [scoped.id] });
	const before = f.service.context(worker)!;
	assert.equal(decisionNotice(unassigned, before)?.urgent, true, "a live new assignment gets its current pins");
	assert.equal(before.decisionRoutes?.[scoped.id], "relevant");
	assert.equal(f.service.context(other)?.decisionRoutes?.[scoped.id], "unrelated");
	assert.equal(f.service.context(lead)?.decisionRoutes?.[scoped.id], "unrelated");
	assert.equal(f.service.context(lead)?.decisionRoutes?.[unknown.id], "unknown");
	assert.equal(f.service.context(idle)?.decisionRoutes?.[unknown.id], "unrelated");
	assert.equal(f.service.context(idle)?.decisionRoutes?.[global.id], "relevant");
	assert.equal(f.service.context(worker)?.decisionRoutes?.[coordinator.id], "unrelated");
	const unrelatedBefore = f.service.context(other)!;
	f.store.updateDecision(f.id, scoped.id, "Changed current rule");
	assert.deepEqual(
		f.store.noticeDeadlines(Date.now()),
		[],
		"routed context must not also wake a classifier/coordinator",
	);
	assert.equal(decisionNotice(before, f.service.context(worker)!)?.urgent, true);
	assert.equal(decisionNotice(unrelatedBefore, f.service.context(other)!), undefined);
	// New assignment/reassignment derives context from the current owner, not historical membership.
	const newOwnerBefore = f.service.context(other)!;
	f.store.updateTask(f.id, "1", { sessionId: other });
	assert.equal(f.service.context(worker)?.decisionRoutes?.[scoped.id], "unrelated");
	assert.equal(f.service.context(other)?.decisionRoutes?.[scoped.id], "relevant");
	assert.match(decisionNotice(newOwnerBefore, f.service.context(other)!)!.detail, /Changed current rule/);
	const assigned = f.service.context(other)!;
	f.store.updateTask(f.id, "1", { sessionId: worker });
	assert.equal(
		decisionNotice(assigned, f.service.context(other)!),
		undefined,
		"releasing a task sends no old guidance",
	);
	f.store.leave(worker);
	assert.equal(f.service.context(worker), undefined);
	assert.equal(f.service.context(lead)?.decisionRoutes?.[scoped.id], "unknown");
});

test("replacement and withdrawal notify pinned current owners without repinning or changing history", (t) => {
	const f = missionContextFixture(2, 3);
	t.after(() => f.store.close());
	const worker = f.members[1]!;
	const old = f.store.addDecision(f.id, "Old guidance");
	const next = f.store.addDecision(f.id, "Scoped successor", {}, "coordinator");
	f.store.updateTask(f.id, "1", { sessionId: worker, decisionIds: [old.id] });
	const before = f.service.context(worker)!;
	f.store.supersedeDecision(f.id, old.id, next.id);
	const after = f.service.context(worker)!;
	assert.equal(decisionNotice(before, after)?.urgent, true);
	assert.match(decisionNotice(before, after)!.detail, /no longer binding/);
	assert.doesNotMatch(decisionNotice(before, after)!.detail, /Scoped successor/);
	assert.deepEqual(f.store.resolveTask(f.id, "1").decisionIds, [old.id]);
	assert.equal(f.store.detail(f.id).decisions.find((d) => d.id === old.id)?.text, "Old guidance");
	const active = f.store.addDecision(f.id, "Withdraw this");
	f.store.updateTask(f.id, "2", { sessionId: worker, decisionIds: [active.id] });
	const prior = f.service.context(worker)!;
	const proposal = f.store.proposeWithdrawal(f.id, active.id, "Obsolete", "withdraw-one", { sessionId: f.members[0] });
	f.store.resolveProposal(f.id, proposal.id, true);
	assert.match(decisionNotice(prior, f.service.context(worker)!)!.detail, /Withdrawn/);
	assert.deepEqual(f.store.resolveTask(f.id, "2").decisionIds, [active.id]);
	assert.equal(f.store.detail(f.id).decisions.find((d) => d.id === active.id)?.text, "Withdraw this");
});

test("mission change context publication never materializes unrelated task bodies or detail", (t) => {
	const f = missionContextFixture(48, 40);
	t.after(() => f.store.close());
	const detail = t.mock.method(f.store, "detail");
	const timing = t.mock.method(operations, "time");
	f.store.log(f.id, { text: "Synthetic activity" });
	assert.equal(f.delivered.size, f.members.length);
	assert.equal(detail.mock.calls.length, 0, "context fan-out must not rebuild full detail for every member");
	assert.equal(f.store.memberContext(f.members[1]!)?.tasks.length, 0);
	assert.equal(timing.mock.calls.filter((call) => call.arguments[0] === "missions.context.publish").length, 1);
});

test("narrow context exactly matches the full-detail projection across roles, phases, pins and links", (t) => {
	const f = missionContextFixture(4, 3);
	t.after(() => f.store.close());
	const [lead, member, other] = f.members as [string, string, string];
	const first = f.store.addPhase(f.id, { name: "First" });
	const second = f.store.addPhase(f.id, { name: "Second" });
	const pinned = f.store.addDecision(f.id, "Pinned reference");
	f.store.addDecision(f.id, "Coordinator", {}, "coordinator");
	f.store.updateTask(f.id, "1", { sessionId: other, phaseId: first.id });
	f.store.updateTask(f.id, "2", { sessionId: member, phaseId: second.id, decisionIds: [pinned.id] });
	f.store.updateTask(f.id, "3", { sessionId: member, status: "done" });
	f.store.updateTask(f.id, "4", { sessionId: member, status: "dropped" });
	f.store.update(f.id, { phaseGating: true });
	for (const taskId of [undefined, "1", "2", "3", "4"])
		f.store.addResource(f.id, { url: `https://linear.app/fixture/issue/TEST-${taskId ?? "0"}`, taskId });
	f.store.addResource(f.id, { url: "https://example.test/unrelated" });
	const compare = () => {
		const actual = f.members.map((id) => f.service.context(id));
		const legacy = t.mock.method(f.store, "memberContext", (sessionId: string) => {
			const id = f.store.missionOf(sessionId);
			return id ? f.store.detail(id, false) : undefined;
		});
		const expected = f.members.map((id) => f.service.context(id));
		legacy.mock.restore();
		assert.deepEqual(actual, expected);
		return actual;
	};
	let contexts = compare();
	assert.equal(contexts[1]?.tasks[0]?.status, "blocked");
	assert.equal(contexts[1]?.tickets?.length, 1);
	assert.equal(contexts[0]?.tickets?.length, 1);
	assert.ok(contexts[1]?.decisions.includes("D61: Pinned reference"));
	const inputs = f.store.memberContext(member)!;
	assert.equal(inputs.tasks.length, 1);
	assert.equal(inputs.tasks[0]?.body, undefined, "task bodies are not context inputs");
	f.store.updateTask(f.id, "1", { status: "done" });
	contexts = compare();
	assert.equal(contexts[1]?.tasks[0]?.status, "todo");
	f.store.updateTask(f.id, "2", { status: "delegated" });
	compare();
	f.store.updateTask(f.id, "2", { sessionId: other, decisionIds: [] });
	f.store.update(f.id, { coordinatorSessionId: other });
	compare();
	f.store.updateDecision(f.id, pinned.id, "Changed reference");
	f.store.update(f.id, { status: "archived" });
	compare();
	f.store.leave(member);
	assert.equal(f.service.context(member), undefined);
	f.store.remove(f.id);
	assert.equal(f.service.context(lead), undefined);
});

test("publication rereads current context after a synchronous listener changes ownership", (t) => {
	const f = missionContextFixture(1, 3);
	t.after(() => f.store.close());
	const member = f.members[1]!;
	let changed = false;
	const seen: MissionContext[] = [];
	t.mock.method(f.sessions, "missionChanged", (id: string, context?: MissionContext) => {
		if (id === member && context) seen.push(context);
		if (changed) return;
		changed = true;
		f.store.updateTask(f.id, "1", { sessionId: member });
	});
	f.store.log(f.id, { text: "Trigger" });
	assert.equal(changed, true);
	assert.ok(seen.length > 0);
	assert.ok(
		seen.every((context) => context.tasks[0]?.number === 1),
		"no cached pre-change context reaches the member",
	);
});

test("log-only changes stay deduplicated and passive lifecycle keeps its publication flag", (t) => {
	const f = missionContextFixture(1, 3);
	t.after(() => f.store.close());
	const changed = t.mock.method(f.sessions, "missionChanged");
	f.store.log(f.id, { text: "First" });
	assert.equal(changed.mock.calls.length, 3);
	f.store.log(f.id, { text: "Second" });
	assert.equal(changed.mock.calls.length, 3);
	f.store.lifecycle(f.id, "fixture", "active", "archive");
	assert.equal(changed.mock.calls.length, 6);
	assert.ok(changed.mock.calls.slice(3).every((call) => call.arguments[2] === true));
});
