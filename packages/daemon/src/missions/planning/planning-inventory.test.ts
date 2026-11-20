import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { interviewDigest } from "../interviews/mission-interview-contract.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";

test("passive inventory lists several saved rounds across restart without writes or continuation", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const second = await f.createPlanning("Second planning mission");
	const third = await f.createPlanning("Third planning mission");
	const otherProject = await f.projects.create({ path: await mkdtemp(join(f.home, "other-")), workspace: "direct" });
	await f.createPlanning("Different project", otherProject.id);
	const before = await (await f.inventory()).json();
	assert.equal(before.status, "available");
	assert.equal(before.total, 3);
	assert.deepEqual(
		new Set(before.items.map((i: { missionId: string }) => i.missionId)),
		new Set([f.missionId, second, third]),
	);
	for (const item of before.items) {
		assert.equal(item.stage, "questions");
		assert.equal(item.pendingQuestions, 1);
		assert.equal(item.needsYou, true);
		assert.equal(item.round.missionId, item.missionId);
		assert.equal(item.round.questionSetRevision, 1);
		assert.equal(item.interviewRevision, 1);
		assert.equal(item.planRevision, null);
		assert.equal(f.store.tasks(item.missionId).length, 0);
	}
	await f.restart();
	assert.deepEqual(await (await f.inventory()).json(), before);
	assert.equal((await f.inventory("")).status, 403);
	assert.equal((await f.inventory(f.capability, "missing-project")).status, 404);
	assert.equal(
		(await fetch(`${f.root}/api/projects/${f.project.id}/planning-inventory`, { method: "POST" })).status,
		405,
	);
});

test("inventory waits for a durable submission, then identifies the next interview", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const replacement = { ...f.question, id: "alternate", prompt: "What else should change?" };
	await f.questions([f.question, replacement]);
	const item = async () => (await (await f.inventory()).json()).items[0];
	assert.equal((await item()).pendingQuestions, 2);
	const answer = (q: typeof f.question) => ({
		questionId: q.id,
		questionDigest: interviewDigest(q),
		selectedOption: null,
		text: "Keep the semantics",
	});
	const notices: string[] = [];
	const stop = f.store.interviews.onChange((id) => notices.push(id));
	t.after(stop);
	const write = async (request: { purpose: string; answers?: ReturnType<typeof answer>[] }) => {
		const read = await (await f.read()).json();
		const { fence, revision } = read.view.interview;
		const op = f.operation(f.missionId, { ...request, expected: { fence, revision } }, read.contextDigest);
		const receipt = await (await f.post(op)).json();
		assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	};
	await write({ purpose: "interview-save", answers: [answer(f.question)] });
	assert.ok(notices.includes(f.missionId), "answer saves invalidate the passive inventory");
	assert.equal((await item()).pendingQuestions, 1);
	await write({ purpose: "interview-save", answers: [answer(f.question), answer(replacement)] });
	const before = await item();
	assert.equal(before.pendingQuestions, 0);
	assert.equal(before.stage, "questions", "a complete draft is still not submitted");
	await write({ purpose: "interview-submit" });
	assert.equal((await item()).stage, "submitted");
	assert.equal((await item()).pendingQuestions, undefined);
	notices.length = 0;
	await f.questions([{ ...f.question, id: "clarification", prompt: "What should the new round produce?" }], "revisit");
	const next = await item();
	assert.equal(next.stage, "questions");
	assert.equal(next.pendingQuestions, 1, "saved answers from the earlier round do not answer the new question");
	assert.ok(next.round.questionSetRevision > before.round.questionSetRevision);
	assert.ok(notices.includes(f.missionId), "new rounds invalidate the passive inventory");
});

test("an interview save invalidates connected Today without putting answers on the wire", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const socket = new WebSocket(`${f.root.replace("http:", "ws:")}/api/ws`);
	try {
		await once(socket, "open", { signal: AbortSignal.timeout(5000) });
		const notice = new Promise<unknown>((resolve, reject) => {
			const deadline = setTimeout(() => reject(new Error("No inventory invalidation")), 5000);
			socket.on("message", (bytes) => {
				const event = JSON.parse(String(bytes));
				if (event.type !== "mission-catalog.changed") return;
				clearTimeout(deadline);
				resolve(event);
			});
		});
		await f.questions([{ ...f.question, id: "new-question" }]);
		assert.deepEqual(await notice, { type: "mission-catalog.changed" });
	} finally {
		socket.terminate();
	}
});

test("review stage names the exact current saved round and proposal revision", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	await f.plan({
		purpose: "plan-map",
		expectedRevision: 0,
		destination: "Importer",
		sources: [],
		questions: [],
		fog: [],
	} as { purpose: string });
	await f.plan({
		purpose: "plan-propose",
		expectedRevision: 1,
		spec: {
			problem: "Problem",
			solution: "Solution",
			stories: [{ id: "story", text: "Read imports" }],
			implementation: ["Parser"],
			testing: ["Fixture"],
			exclusions: ["Format changes"],
		},
		slices: [
			{
				id: "slice",
				title: "Importer",
				outcome: "Read archive",
				acceptance: ["Exact bytes"],
				storyIds: ["story"],
				dependsOn: [],
				owners: ["sol-backend"],
			},
		],
	} as { purpose: string });
	await f.plan({ purpose: "plan-review", expectedRevision: 2 } as { purpose: string });
	const read = await (await f.read()).json();
	const response = await f.inventory();
	assert.equal(response.status, 200);
	const item = (await response.json()).items[0];
	assert.equal(item.stage, "review");
	assert.equal(item.needsYou, true);
	assert.deepEqual(item.round, read.view.interview.fence);
	assert.equal(item.planRevision, read.view.plan.revision);
	assert.equal(item.interviewRevision, read.view.interview.revision);
	assert.equal(f.store.tasks(f.missionId).length, 0);
});

test("revoked owner or changed project during durability refuses the entire read", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	await f.createPlanning("Another mission");
	const owner = f.coordinator;
	f.coordinator = undefined;
	assert.equal((await f.inventory()).status, 409, "not a successful partial list");
	f.coordinator = owner;
	const durable = f.store.durable.bind(f.store);
	f.store.durable = async () => {
		await durable();
		f.coordinator = { ...owner!, projectId: "revoked-project" };
	};
	assert.equal((await f.inventory()).status, 409, "post-I/O owner/project check stays fail closed");
	f.store.durable = durable;
});

test("round changes and inventory additions across the durability barrier refuse stale lists", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const durable = f.store.durable.bind(f.store);
	f.store.durable = async () => {
		await durable();
		const current = f.store.interviews.latest(f.missionId)!;
		f.store.interviews.write(
			f.operation(f.missionId, { purpose: "interview-save" }),
			{
				purpose: "interview-save",
				expected: { fence: current.fence, revision: current.revision },
				answers: [],
			},
			() => {},
		);
	};
	const raced = await f.inventory();
	assert.equal(raced.status, 409, "never serves an old question/answer revision");
	assert.equal((await raced.json()).code, "planning_inventory_race");
	f.store.durable = durable;
	assert.equal((await f.inventory()).status, 200);
	// A mission created after the empty-list barrier must not disappear as successful emptiness.
	f.store.update(f.missionId, { status: "archived" });
	let inserted = false;
	f.store.durable = async () => {
		await durable();
		if (inserted) return;
		inserted = true;
		f.store.interviews.create(
			f.operation("fresh-enrollment", { purpose: "interview-create" }),
			{ projectId: f.project.id, title: "Created during read" },
			f.owner,
			[f.question],
		);
	};
	assert.equal((await f.inventory()).status, 409, "empty-list currentness includes candidate membership");
	f.store.durable = durable;
});

test("unavailable differs from a successful empty project inventory", async (t) => {
	const f = await nativePlanningFixture({ native: false });
	t.after(() => f.close());
	const unavailable = await f.inventory();
	assert.equal(unavailable.status, 503);
	assert.deepEqual(await unavailable.json(), { error: "Native planning unavailable" });
	const available = await nativePlanningFixture();
	t.after(() => available.close());
	available.store.update(available.missionId, { status: "archived" });
	const response = await available.inventory();
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		version: 1,
		projectId: available.project.id,
		status: "available",
		limit: 100,
		total: 0,
		items: [],
	});
});

test("inventory refuses capacity overflow instead of treating a first page as success", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	for (let n = 1; n < 100; n++) await f.createPlanning(`Planning ${n}`);
	const start = performance.now();
	assert.equal((await (await f.inventory()).json()).total, 100);
	t.diagnostic(`100-mission inventory HTTP read: ${(performance.now() - start).toFixed(1)} ms`);
	await f.createPlanning("Beyond capacity");
	const response = await f.inventory();
	assert.equal(response.status, 503);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), {
		version: 1,
		code: "planning_inventory_capacity",
		projectId: f.project.id,
		limit: 100,
		error: "Planning inventory exceeds limit",
	});
	const denied = await f.inventory("");
	assert.equal(denied.status, 403, "overflow does not bypass authentication");
	assert.equal((await denied.json()).code, undefined);
});
