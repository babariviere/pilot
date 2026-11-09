import assert from "node:assert/strict";
import { test } from "node:test";
import type { InterviewWrite, MissionInterview } from "@pilot/protocol";
import { interviewHistoryFixture } from "./interview-history.fixture.ts";

test("complete submitted rounds retain exact snapshots and opening context after restart", async (t) => {
	const { f, nextRound } = await interviewHistoryFixture();
	t.after(() => f.close());
	const read = async () => {
		const r = await f.read();
		assert.equal(r.status, 200);
		return r.json();
	};
	assert.deepEqual((await read()).view.interviewHistory, []);
	const saved: { interview: MissionInterview; plan: unknown }[] = [];
	for (let n = 0; n < 3; n++) {
		let v = await read();
		const q = v.view.interview.questions[0];
		const post = async (request: InterviewWrite) => {
			const op = f.operation(f.missionId, request, v.contextDigest);
			const r = await (await f.post(op)).json();
			assert.equal(r.state, "accepted", JSON.stringify(r));
			v = await read();
		};
		const expected = () => ({ fence: v.view.interview.fence, revision: v.view.interview.revision });
		await post({
			purpose: "interview-save",
			expected: expected(),
			answers: [
				{
					questionId: q.id,
					questionDigest: v.questionDigests[q.id],
					selectedOption: q.options[0],
					text: `  round ${n}\n💬 exact  `,
				},
			],
		});
		assert.deepEqual(v.view.interviewHistory, saved, "drafts never count as submissions");
		const context = v.view.plan;
		await post({ purpose: "interview-submit", expected: expected() });
		saved.push({ interview: v.view.interview, plan: context });
		assert.deepEqual(v.view.interviewHistory, saved);
		await nextRound();
		assert.deepEqual((await read()).view.interviewHistory, saved, "new questions never rewrite history");
	}
	await f.restart();
	let current = await read();
	assert.deepEqual(current.view.interviewHistory, saved);
	assert.equal(current.view.interview.submission, null);
	assert.notEqual(saved[2]!.interview.fence.questionSetRevision, current.view.interview.fence.questionSetRevision);
	assert.notEqual((saved[2]!.plan as typeof current.view.plan).review.digest, current.view.plan.review.digest);
	await assert.rejects(
		f.plan({ purpose: "plan-publish", expectedRevision: current.view.plan.revision } as { purpose: string }),
		/Exact submitted proposal approval required/,
	);
	assert.equal(f.store.tasks(f.missionId).length, 0);
	const old = saved[0]!.interview;
	const stale = f.operation(
		f.missionId,
		{ purpose: "interview-submit", expected: { fence: old.fence, revision: old.revision } } as InterviewWrite,
		current.contextDigest,
	);
	assert.equal((await (await f.post(stale)).json()).state, "rejected");
	current = await read();
	assert.deepEqual(current.view.interviewHistory, saved);
	assert.equal(f.store.workflowConfirmations.latest(f.missionId, false), undefined);
	const owner = f.coordinator;
	const durable = f.store.durable.bind(f.store);
	t.mock.method(f.store, "durable", async () => {
		await durable();
		f.coordinator = undefined;
	});
	assert.equal((await f.read()).status, 409, "history cannot escape a late owner revocation");
	t.mock.restoreAll();
	f.coordinator = undefined;
	assert.equal((await f.read()).status, 409, "revoked access is not an empty history");
	f.coordinator = owner;
	f.store.leave(f.owner);
	f.store.join(f.owner, f.missionId);
	assert.equal((await f.read()).status, 409, "owner ABA cannot read earlier history");
});
