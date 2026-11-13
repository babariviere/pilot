import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import type {
	DeliveredWork,
	DurableOperation,
	SessionSummary,
	UserVerificationIntent,
	VerificationSubject,
} from "@pilot/protocol";
import { MissionControls } from "./mission-controls.ts";
import { MissionStore } from "./missions.ts";
import { OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";
import { UserVerifications } from "./user-verification.ts";

const host = { hostId: "daemon", daemonId: "daemon", lineageId: "lineage" };
function operation(
	page: DeliveredWork,
	action: UserVerificationIntent["action"] = "done",
	note = "",
): DurableOperation {
	const payload = JSON.stringify({
		purpose: "user-verification",
		subject: page.subject,
		deliveryId: page.deliveryId,
		expectedRevision: page.verificationRevision,
		action,
		note,
	});
	return {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: { ...host, hostId: "local" },
		destination: host,
		kind: "user-verification",
		targetId: page.targetId,
		bindingId: page.deliveryId!,
		bindingGeneration: 1,
		payload,
		payloadHash: payloadHash(payload),
	};
}
async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "user-verification-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home });
	let store = new MissionStore(join(home, "missions.sqlite"));
	let journal = new OperationJournal(join(home, "operations"), host);
	const mission = store.create({ projectId: project.id, title: "Isolated fake work" });
	store.join("worker", mission.id);
	store.join("completion-lead", mission.id);
	store.update(mission.id, { coordinatorSessionId: "completion-lead" });
	const task = store.addTask(mission.id, { title: "Delivered result", sessionId: "worker" });
	let chat: SessionSummary = {
		id: "worker",
		title: "Fake agent",
		projectId: project.id,
		cwd: home,
		createdAt: 1,
		updatedAt: 2,
		state: "idle",
		missionId: mission.id,
		inputGeneration: 0,
	};
	const sends: Array<{ id: string; message: string; operationId: string }> = [];
	let send: "ok" | "lost" | "race" = "ok";
	const sessions = {
		get: (id: string) => (id === chat.id ? structuredClone(chat) : undefined),
		async sendDurable(
			id: string,
			message: string,
			_mode: unknown,
			operationId: string,
			options?: { admissionGuard?: () => void },
		) {
			if (send === "race") store.updateTask(mission.id, task.id, { body: "new definition" });
			options?.admissionGuard?.();
			sends.push({ id, message, operationId });
			if (send === "lost") throw new Error("Fake input admitted, ACK lost");
		},
	};
	let service = new UserVerifications({ store, journal, projects, sessions });
	const subject: VerificationSubject = { kind: "task", projectId: project.id, missionId: mission.id, taskId: task.id };
	const deliver = () =>
		store.completeTask(mission.id, task.id, "completion-lead", {
			commit: "a".repeat(40),
			checks: "Fake checks",
			issues: "",
		});
	const run = (op: DurableOperation) => journal.execute(op, (o, entry) => service.admit(o, entry.firstEntry));
	const reopenStorage = async (beforeOpen?: () => void) => {
		await store.durable();
		store.close();
		beforeOpen?.();
		store = new MissionStore(join(home, "missions.sqlite"));
		journal = new OperationJournal(join(home, "operations"), host);
		service = new UserVerifications({ store, journal, projects, sessions });
	};
	t.after(async () => {
		await store.durable();
		store.close();
		await rm(home, { recursive: true, force: true });
	});
	return {
		home,
		project,
		projects,
		mission,
		task,
		subject,
		deliver,
		run,
		sends,
		sessions,
		get store() {
			return store;
		},
		get journal() {
			return journal;
		},
		get service() {
			return service;
		},
		setChat: (value: Partial<SessionSummary>) => {
			chat = { ...chat, ...value };
		},
		setSend: (v: typeof send) => {
			send = v;
		},
		reopenStorage,
	};
}

test("Done, Send back and Reopen are immutable revisions, not task/merge/release acceptance", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.service.read(f.subject)).deliveryId, null);
	f.store.updateTask(f.mission.id, f.task.id, { status: "done" });
	assert.equal((await f.service.read(f.subject)).deliveryId, null, "task status alone is not delivered output");
	f.deliver();
	const before = f.store.task(f.mission.id, f.task.id);
	const page = await f.service.read(f.subject),
		done = operation(page);
	assert.equal(page.production, "not_tracked");
	const ack = await f.run(done);
	assert.equal(ack.state, "accepted");
	assert.deepEqual(await f.run(done), ack, "exact retry cannot add a revision");
	const pair = await f.service.lookup(done);
	assert.equal(pair.verificationReceipt?.state, "accepted");
	assert.deepEqual(pair.verificationReceipt?.verification, ack.result);
	assert.equal((await f.service.read(f.subject)).verification?.revision, 1);
	assert.equal((await f.run(operation(page, "send_back", "stale note"))).state, "rejected");
	assert.equal(
		(await f.run(operation(await f.service.read(f.subject), "send_back", "must reopen"))).state,
		"rejected",
	);
	assert.equal((await f.run(operation(await f.service.read(f.subject), "reopen"))).state, "accepted");
	const note = "  Keep exact note 🐦\nPlease fix the result.  ";
	const back = operation(await f.service.read(f.subject), "send_back", note);
	assert.equal((await f.run(back)).state, "accepted");
	assert.deepEqual(f.sends, [{ id: "worker", message: note, operationId: back.operationId }]);
	assert.equal((await f.service.read(f.subject)).verification?.messageReceipt?.requestId, back.operationId);
	assert.deepEqual(f.store.task(f.mission.id, f.task.id), before);
	await f.reopenStorage();
	assert.equal((await f.service.read(f.subject)).verification?.state, "sent_back");
	assert.equal((await f.service.read(f.subject)).verification?.revision, 3);
	assert.deepEqual(await f.service.lookup(done), pair, "historical exact receipt survives reopen");
	assert.equal((await f.service.lookup(back)).receipt.state, "accepted");
});

test("discovery starts fresh once, keeps history and uses one durable cutoff across projects", async (t) => {
	const f = await fixture(t);
	f.deliver();
	const old = await f.service.read(f.subject);
	const first = await f.service.list(f.project.id);
	assert.equal(first.items.length, 0);
	assert.equal(first.complete, true);
	assert.ok(first.baseline.sourceSequence > 0);
	assert.equal(old.verification, null);
	await mkdir(join(f.home, "other"));
	const other = await f.projects.create({ path: join(f.home, "other") });
	const mission = f.store.create({ projectId: other.id, title: "Other project" });
	f.store.join("other-lead", mission.id);
	f.store.update(mission.id, { coordinatorSessionId: "other-lead" });
	const task = f.store.addTask(mission.id, { title: "New other delivery" });
	f.store.completeTask(mission.id, task.id, "other-lead", { commit: "b".repeat(40), checks: "Synthetic", issues: "" });
	const list = await f.service.list(other.id);
	assert.deepEqual(list.baseline, first.baseline, "a later project read does not move the profile cutoff");
	assert.deepEqual(list.items[0]?.subject, {
		kind: "task",
		projectId: other.id,
		missionId: mission.id,
		taskId: task.id,
	});
	assert.equal(list.items[0]?.snapshot.production, "not_tracked");
	assert.equal((await f.service.list(f.project.id)).items.length, 0);
	await f.reopenStorage();
	assert.deepEqual((await f.service.list(other.id)).baseline, first.baseline);
	assert.equal((await f.service.list(other.id)).items.length, 1, "pending across restart without any acceptance");
	assert.equal((await f.service.read(f.subject)).deliveryId, old.deliveryId, "history remains readable");
	assert.equal((await f.service.read(f.subject)).verification, null);
	assert.equal(f.sends.length, 0);
});

test("discovery hides only exact acknowledged Done or Sent back and keeps Unknown", async (t) => {
	const f = await fixture(t);
	const baseline = (await f.service.list(f.project.id)).baseline;
	f.deliver();
	assert.equal((await f.service.list(f.project.id)).items.length, 1);
	const page = await f.service.read(f.subject);
	assert.equal((await f.run(operation(page))).state, "accepted");
	assert.equal((await f.service.list(f.project.id)).items.length, 0);
	assert.equal((await f.run(operation(await f.service.read(f.subject), "reopen"))).state, "accepted");
	assert.equal((await f.service.list(f.project.id)).items.length, 1);
	assert.equal((await f.run(operation(await f.service.read(f.subject), "send_back", "Fix"))).state, "accepted");
	assert.equal((await f.service.list(f.project.id)).items.length, 0);
	// A canonical new record changes identity; the earlier assessment stays historical.
	f.store.writeBrief(f.mission.id, "Second delivery", 0);
	f.store.saveNonCodeDelivery(f.mission.id, f.task.id, "worker", {
		kind: "non-code",
		references: [{ kind: "brief", revision: 1 }],
		checks: "Synthetic",
		limitations: "Not released",
	});
	assert.equal((await f.service.list(f.project.id)).items.length, 1);
	f.setSend("lost");
	const back = operation(await f.service.read(f.subject), "send_back", "Again");
	assert.equal((await f.run(back)).state, "pending");
	await f.reopenStorage();
	const list = await f.service.list(f.project.id);
	assert.deepEqual(list.baseline, baseline);
	assert.equal(list.items[0]?.snapshot.pendingOperationId, back.operationId);
	assert.equal(f.sends.length, 2, "passive reads never resend Unknown");
});

test("discovery is bounded and page cursors never advance the cutoff or erase pending checks", async (t) => {
	const f = await fixture(t);
	const first = await f.service.list(f.project.id);
	for (let i = 0; i < 22; i++) {
		const task = f.store.addTask(f.mission.id, { title: `Delivery ${i}` });
		f.store.completeTask(f.mission.id, task.id, "completion-lead", {
			commit: "a".repeat(40),
			checks: "Synthetic",
			issues: "",
		});
	}
	const page = await f.service.list(f.project.id);
	assert.equal(page.items.length, 20);
	assert.equal(page.more, true);
	assert.equal(page.complete, false);
	const next = await f.service.list(f.project.id, page.nextCursor!);
	assert.equal(next.items.length, 2);
	assert.equal(next.complete, true);
	assert.equal(next.more, false);
	assert.deepEqual(next.baseline, first.baseline);
	assert.equal(new Set([...page.items, ...next.items].map((i) => i.snapshot.targetId)).size, 22);
	assert.deepEqual(
		(await f.service.list(f.project.id)).items,
		page.items,
		"reopen/filter returns the still-pending first page",
	);
	await assert.rejects(f.service.list(f.project.id, -1));
	await assert.rejects(f.service.list(f.project.id, Number.MAX_SAFE_INTEGER));
	assert.equal(f.sends.length, 0);
});

test("pre-cutoff definition, PR and status changes do not rediscover historical output", async (t) => {
	const f = await fixture(t);
	f.deliver();
	const baseline = (await f.service.list(f.project.id)).baseline;
	f.store.updateTask(f.mission.id, f.task.id, { body: "Changed definition", status: "todo" });
	f.store.addResource(f.mission.id, {
		taskId: f.task.id,
		url: "https://github.com/example/repo/pull/1",
		relationship: "reference",
	});
	assert.equal((await f.service.list(f.project.id)).items.length, 0);
	f.store.writeBrief(f.mission.id, "New delivery", 0);
	f.store.saveNonCodeDelivery(f.mission.id, f.task.id, "worker", {
		kind: "non-code",
		references: [{ kind: "brief", revision: 1 }],
		checks: "Synthetic",
		limitations: "Not released",
	});
	assert.deepEqual((await f.service.list(f.project.id)).baseline, baseline);
	assert.equal((await f.service.list(f.project.id)).items.length, 1);
});

test("older canonical records are indexed once without accepting or flooding history", async (t) => {
	const f = await fixture(t);
	f.deliver();
	await f.reopenStorage(() => {
		const disk = new DatabaseSync(join(f.home, "missions.sqlite"));
		disk.exec("DROP TABLE delivery_sources; DROP TABLE delivery_source_clock;");
		disk.close();
	});
	const list = await f.service.list(f.project.id);
	assert.equal(list.items.length, 0);
	assert.ok(list.baseline.sourceSequence > 0);
	assert.equal((await f.service.read(f.subject)).verification, null);
	await f.reopenStorage();
	assert.deepEqual((await f.service.list(f.project.id)).baseline, list.baseline);
});

test("source identities never reuse a deleted latest delivery after restart", async (t) => {
	const f = await fixture(t);
	f.deliver();
	const first = await f.service.list(f.project.id);
	f.store.remove(f.mission.id);
	await f.reopenStorage();
	const mission = f.store.create({ projectId: f.project.id, title: "Later work" });
	f.store.join("lead", mission.id);
	f.store.update(mission.id, { coordinatorSessionId: "lead" });
	const task = f.store.addTask(mission.id, { title: "Later result" });
	f.store.completeTask(mission.id, task.id, "lead", { commit: "c".repeat(40), checks: "Synthetic", issues: "" });
	const list = await f.service.list(f.project.id);
	assert.deepEqual(list.baseline, first.baseline);
	assert.ok(list.items[0]!.sourceSequence > first.sourceCursor);
	assert.equal(list.items.length, 1);
});

test("new task delivery identity invalidates old Done and old Send back CAS", async (t) => {
	const f = await fixture(t);
	f.deliver();
	const old = await f.service.read(f.subject);
	assert.equal((await f.run(operation(old))).state, "accepted");
	// Canonical evidence revision is a new delivery, even when legacy completion stays immutable.
	f.store.writeBrief(f.mission.id, "New result", 0);
	f.store.saveNonCodeDelivery(f.mission.id, f.task.id, "worker", {
		kind: "non-code",
		references: [{ kind: "brief", revision: 1 }],
		checks: "New report",
		limitations: "Not released",
	});
	const latest = await f.service.read(f.subject);
	assert.notEqual(latest.deliveryId, old.deliveryId);
	assert.equal(latest.verificationCurrent, false);
	assert.equal(
		(await f.run(operation({ ...old, verificationRevision: latest.verificationRevision }, "send_back", "old result")))
			.state,
		"rejected",
	);
	assert.equal((await f.run(operation(latest))).state, "accepted");
	assert.equal(f.sends.length, 0);
});

test("lost input ACK stays Unknown across reopen; Check and recovery never resend", async (t) => {
	const f = await fixture(t);
	f.deliver();
	f.setSend("lost");
	const back = operation(await f.service.read(f.subject), "send_back", "Correct this");
	assert.equal((await f.run(back)).state, "pending");
	assert.equal(f.sends.length, 1);
	assert.equal((await f.service.lookup(back)).verificationReceipt?.state, "pending");
	assert.equal((await f.service.read(f.subject)).verification, null);
	await f.reopenStorage();
	await f.journal.recover((op) => f.service.admit(op, false));
	assert.equal((await f.run(back)).state, "pending");
	assert.equal((await f.service.lookup(back)).receipt.state, "pending");
	assert.equal((await f.run(operation(await f.service.read(f.subject)))).state, "rejected");
	assert.equal(f.sends.length, 1);
});

test("final admission guard rejects changed delivery after reservation, with no note sent", async (t) => {
	const f = await fixture(t);
	f.deliver();
	f.setSend("race");
	const op = operation(await f.service.read(f.subject), "send_back", "Correct this");
	assert.equal((await f.run(op)).state, "pending");
	assert.equal(f.sends.length, 0);
	assert.equal((await f.service.lookup(op)).verificationReceipt?.state, "pending");
});

test("standalone outcomes are exact, scoped and separate from task status and agent questions", async (t) => {
	const f = await fixture(t);
	f.store.leave("worker");
	f.setChat({ missionId: undefined, outcome: "question", outcomeAt: 30 });
	const subject: VerificationSubject = { kind: "chat", projectId: f.project.id, sessionId: "worker" };
	assert.equal((await f.service.read(subject)).deliveryId, null);
	f.setChat({ outcome: "done", outcomeAt: 40, outcomeReason: "Fake delivered answer" });
	const page = await f.service.read(subject);
	assert.equal((await f.run(operation(page))).state, "accepted");
	f.setChat({ outcomeAt: 50 });
	assert.equal((await f.service.read(subject)).verificationCurrent, false);
	assert.equal(
		(await f.run(operation({ ...page, verificationRevision: 1 }, "send_back", "old outcome"))).state,
		"rejected",
	);
	assert.equal((await f.run(operation(await f.service.read(subject)))).state, "accepted");
	await f.reopenStorage();
	assert.equal((await f.service.read(subject)).verification?.revision, 2);
	await assert.rejects(f.service.read({ ...subject, projectId: "foreign" }));
});

test("entered domain success without outer receipt remains Unknown, and malformed bytes cannot replay", async (t) => {
	const f = await fixture(t);
	await f.service.list(f.project.id);
	f.deliver();
	const op = operation(await f.service.read(f.subject));
	await f.journal.reserve(op);
	await f.service.admit(op, true); // simulate outer receipt publication loss
	const pair = await f.service.lookup(op);
	assert.equal(pair.receipt.state, "pending");
	assert.equal(pair.verificationReceipt?.state, "accepted");
	await f.reopenStorage();
	const page = await f.service.read(f.subject);
	assert.equal(page.verificationCurrent, false, "domain success alone cannot show Done after reopen");
	assert.equal((await f.service.list(f.project.id)).items[0]?.snapshot.pendingOperationId, op.operationId);
	assert.equal(page.verificationReceiptState, "unknown");
	assert.equal(page.pendingOperationId, op.operationId);
	assert.equal((await f.run(operation(page, "reopen"))).state, "rejected");
	assert.equal((await f.run(op)).state, "pending");
	assert.deepEqual(await f.service.lookup(op), pair);
	await assert.rejects(f.service.lookup({ ...op, producerId: "changed" }), /immutable/);
	await assert.rejects(f.service.lookup({ ...op, origin: host }), /native/);
});

test("task status and PR merge observations never turn into verification or production", async (t) => {
	const f = await fixture(t);
	f.deliver();
	const pr = f.store.addResource(f.mission.id, {
		taskId: f.task.id,
		relationship: "reference",
		url: "https://github.com/example/repo/pull/2",
	});
	const page = await f.service.read(f.subject);
	assert.equal((await f.run(operation(page))).state, "accepted");
	f.store.updateTask(f.mission.id, f.task.id, { status: "in_progress" });
	f.store.updatePullRequest({
		number: 2,
		url: pr.url,
		title: "Fake merge",
		state: "merged",
		checkedAt: 100,
		mergedAt: 90,
	});
	const merged = await f.service.read(f.subject);
	assert.equal(merged.deliveryId, page.deliveryId);
	assert.equal(merged.verificationCurrent, true);
	assert.equal(merged.production, "not_tracked");
	assert.equal(f.sends.length, 0);
});

test("concurrent CAS admits one assessment; fresh operation IDs cannot bypass it", async (t) => {
	const f = await fixture(t);
	f.deliver();
	const page = await f.service.read(f.subject);
	const results = await Promise.all([f.run(operation(page)), f.run(operation(page, "send_back", "Fix it"))]);
	assert.deepEqual(results.map((r) => r.state).sort(), ["accepted", "rejected"]);
	assert.equal((await f.service.read(f.subject)).verificationRevision, 1);
});

for (const hold of ["archivedAt", "sleepPaused", "offlinePaused", "subscriptionPause"] as const)
	test(`Send back refuses ${hold} without restoring or resuming work`, async (t) => {
		const f = await fixture(t);
		f.deliver();
		f.setChat(
			hold === "archivedAt"
				? { archivedAt: 1 }
				: hold === "subscriptionPause"
					? { subscriptionPause: { windows: [] } }
					: { [hold]: true },
		);
		const op = operation(await f.service.read(f.subject), "send_back", "Fix it");
		assert.equal((await f.run(op)).state, "rejected");
		assert.equal((await f.service.read(f.subject)).pendingOperationId, null);
		assert.equal(f.sends.length, 0);
	});

test("new canonical submission supersedes checked delivery without inheriting verification", async (t) => {
	const f = await fixture(t);
	const mission = f.store.create({ projectId: f.project.id, title: "Versioned deliveries", planningVersion: 1 });
	f.store.join("author", mission.id);
	f.store.join("lead", mission.id);
	f.store.update(mission.id, { coordinatorSessionId: "lead" });
	const task = f.store.addTask(mission.id, {
		title: "Report",
		sessionId: "author",
		assignment: {
			version: 1,
			expectedRevision: 0,
			expectedDefinitionRevision: 0,
			intent: "Report",
			scope: "One result",
			criteria: ["Evidence"],
		},
	});
	f.store.writeBrief(mission.id, "Canonical source", 0);
	const subject: VerificationSubject = {
		kind: "task",
		projectId: f.project.id,
		missionId: mission.id,
		taskId: task.id,
	};
	const submit = (expectedSubmissionId: string | null) =>
		f.store.submitDeliveryEvidence(
			mission.id,
			task.id,
			"author",
			{
				version: 1,
				operationId: randomUUID(),
				expectedSubmissionId,
				definitionRevision: f.store.sharedDefinitionRevision(task.id),
				assignment: task.assignment,
				kind: "research",
				claim: expectedSubmissionId ? "Revised result" : "First result",
				limitations: "Agent claim only",
				evidence: [{ kind: "brief", revision: 1 }],
				coverage: [[0]],
			},
			async (reference) => ({
				reference,
				sourceOwnerSessionId: null,
				sha256: "a".repeat(64),
				availability: "retained",
			}),
		);
	const first = await submit(null);
	const baseline = (await f.service.list(f.project.id)).baseline;
	assert.equal((await f.service.list(f.project.id)).items.length, 0, "first submission is historical at first use");
	const old = await f.service.read(subject);
	assert.equal(old.submissionId, first.id);
	assert.equal(old.submission?.claim, "First result");
	assert.equal((await f.run(operation(old))).state, "accepted");
	const next = await submit(first.id);
	const discovered = await f.service.list(f.project.id);
	assert.deepEqual(discovered.baseline, baseline);
	assert.equal(discovered.items[0]?.snapshot.submissionId, next.id, "new canonical submission crosses the cutoff");
	const current = await f.service.read(subject);
	assert.equal(current.submissionId, next.id);
	assert.notEqual(current.deliveryId, old.deliveryId);
	assert.equal(current.verificationCurrent, false);
	assert.equal((await f.run(operation({ ...old, verificationRevision: 1 }, "send_back", "Stale"))).state, "rejected");
	assert.equal((await f.run(operation(current))).state, "accepted");
});

test("task mission hold is enforced from canonical membership even without a summary missionId", async (t) => {
	const f = await fixture(t);
	f.deliver();
	f.setChat({ missionId: undefined });
	const controls = new MissionControls(f.store, {
		checkpointMission: async () => "paused",
		resumeMission: async () => "resumed",
	});
	controls.setScheduleDrain(async () => {});
	await controls.execute(f.mission.id, {
		version: 1,
		operationId: randomUUID(),
		home: host,
		projectId: f.project.id,
		coordinatorSessionId: f.store.require(f.mission.id).coordinatorSessionId ?? null,
		expectedRevision: 0,
		action: "pause",
	});
	const back = operation(await f.service.read(f.subject), "send_back", "Do not resume");
	assert.equal((await f.run(back)).state, "rejected");
	assert.equal(f.sends.length, 0);
});
