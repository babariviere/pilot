import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import type { UserFeedbackProposal } from "@pilot/protocol";
import { planningWorkerFixture } from "../workers/planning-workers.fixture.ts";
import { UserFeedbackWorkService } from "../../../day/feedback/user-feedback-work.ts";

const DIGEST = "a".repeat(64);
const PROPOSAL: UserFeedbackProposal = {
	summary: "Exported chat names collide",
	duplicates: [],
	next: "new-mission",
	detail: "Exports with the same title overwrite each other.",
	missionId: null,
	goal: "Keep every chat export",
};

/** Saved feedback with a finished triage in the fixture's project, and a plan payload that names it. */
async function planned(t: TestContext) {
	const f = await planningWorkerFixture(t);
	const feedbackId = randomUUID(),
		triageSessionId = randomUUID();
	f.store.feedback.add({
		id: feedbackId,
		text: "Exporting twice overwrote my first file",
		origin: null,
		recordedAt: 1,
		operationId: randomUUID(),
	});
	f.store.feedback.addWork(
		feedbackId,
		{ operationId: randomUUID(), recordedAt: 2, kind: "triage", sessionId: triageSessionId, projectId: f.project.id },
		() => {},
	);
	await f.store.durable();
	let digest = DIGEST;
	t.mock.method(UserFeedbackWorkService.prototype, "proposal", async (sessionId: string) =>
		sessionId === triageSessionId ? { value: PROPOSAL, digest } : undefined,
	);
	const plan = (feedback: unknown) => {
		const payload = { ...JSON.parse(f.enrollment.payload), ownerSessionId: randomUUID(), feedback };
		return f.operation(randomUUID(), payload, payload.configurationDigest);
	};
	const from = { feedbackId, triageSessionId, proposalDigest: DIGEST };
	return { f, from, plan, changeProposal: () => (digest = "b".repeat(64)) };
}

test("a mission planned from feedback saves the feedback's link with the exact proposal in its creation", {
	timeout: 60000,
}, async (t) => {
	const { f, from, plan } = await planned(t);
	const op = plan(from);
	const enrolled = await f.post(op);
	assert.equal(enrolled.state, "accepted", JSON.stringify(enrolled) + f.logs());
	const missionId = enrolled.result.missionId as string;
	const link = f.store.feedback.work(from.feedbackId).find((w) => w.kind === "mission");
	assert.deepEqual(
		link && { ...link, recordedAt: 0 },
		{
			operationId: op.operationId,
			recordedAt: 0,
			kind: "mission",
			missionId,
			projectId: f.project.id,
			triageSessionId: from.triageSessionId,
			proposalDigest: from.proposalDigest,
		},
		"the link is the creation's own step, named by its operation",
	);
	// A lost acknowledgement is looked up, never entered again: still one link.
	assert.equal((await f.post(op, true)).state, "accepted");
	assert.equal(f.store.feedback.work(from.feedbackId).filter((w) => w.kind === "mission").length, 1);
	// The same suggestion cannot plan a second mission.
	const again = await f.post(plan(from));
	assert.equal(again.state, "rejected");
	assert.match(again.reason, /already planned from this suggestion/);
});

test("planning from changed, resolved or another project's feedback is refused with nothing created", {
	timeout: 60000,
}, async (t) => {
	const { f, from, plan, changeProposal } = await planned(t);
	const before = f.store.list(f.project.id).length;
	const refused = async (feedback: unknown, reason: RegExp) => {
		const r = await f.post(plan(feedback));
		assert.equal(r.state, "rejected", JSON.stringify(r));
		assert.match(r.reason, reason);
	};
	await refused({ ...from, feedbackId: randomUUID() }, /no longer exists/);
	await refused({ ...from, triageSessionId: randomUUID() }, /not about this feedback/);
	await refused({ ...from, proposalDigest: "short" }, /Invalid feedback proposal digest/);
	await refused({ ...from, extra: true }, /./);
	changeProposal();
	await refused(from, /suggestion changed/);
	const other = randomUUID();
	f.store.feedback.addWork(
		from.feedbackId,
		{ operationId: randomUUID(), recordedAt: 3, kind: "triage", sessionId: other, projectId: "another-project" },
		() => {},
	);
	await refused({ ...from, triageSessionId: other }, /different project/);
	f.store.feedback.addWork(from.feedbackId, { operationId: randomUUID(), recordedAt: 4, kind: "resolved" }, () => {});
	await refused(from, /resolved/);
	assert.equal(f.store.list(f.project.id).length, before);
	assert.equal(f.store.feedback.work(from.feedbackId).filter((w) => w.kind === "mission").length, 0);
	assert.equal(f.specs.length, 0);
});
