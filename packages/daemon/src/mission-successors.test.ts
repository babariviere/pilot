import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { planningWorkerFixture } from "./planning-workers.fixture.ts";

type Fixture = Awaited<ReturnType<typeof planningWorkerFixture>>;

/** A fresh enrollment that re-plans `replaces`, with the fixture's trusted setup. */
function replan(f: Fixture, replaces: string) {
	const request = { ...JSON.parse(f.enrollment.payload), ownerSessionId: randomUUID(), replaces };
	return f.operation(randomUUID(), request, request.configurationDigest);
}

async function get(f: Fixture, path: string) {
	const r = await fetch(`${f.base}${path}`, { headers: { "x-pilot-github-capability": f.capability } });
	assert.equal(r.status, 200, await r.clone().text());
	return r.json();
}

function stop(f: Fixture, oldMissionId: string, body: unknown, capability = f.capability) {
	return fetch(`${f.base}/api/missions/${oldMissionId}/successor`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-pilot-github-capability": capability },
		body: JSON.stringify(body),
	});
}

test("re-planning refuses with no side effects, links in the enrollment, reads expose it and Stop only abandons", {
	timeout: 60000,
}, async (t) => {
	const f = await planningWorkerFixture(t);
	assert.equal(f.hello.capabilities.missionReplanning, undefined, "the base hello has no daemon-only capability");
	assert.equal((await get(f, "/api/hello")).capabilities.missionReplanning, 1);
	const projectId = f.project.id;
	const old = f.store.create({ projectId, title: "Old mission", goal: "Ship the importer" });
	const archived = f.store.create({ projectId, title: "Archived mission" });
	f.store.lifecycle(archived.id, projectId, "active", "archive");
	const elsewhere = f.store.create({ projectId: "other-project", title: "Other project mission" });
	const refusals: Array<[string, string]> = [
		[randomUUID(), "does not exist"],
		[archived.id, "Only an active mission"],
		[elsewhere.id, "in another project"],
	];
	const before = f.store.list(projectId).length;
	for (const [id, reason] of refusals) {
		const receipt = await f.post(replan(f, id));
		assert.equal(receipt.state, "rejected", JSON.stringify(receipt));
		assert.match(receipt.reason, new RegExp(reason));
		assert.equal(f.store.successor(id), undefined);
	}
	assert.equal(f.store.list(projectId).length, before, "a refused re-plan creates no mission");
	assert.equal(f.specs.length, 0, "a refused re-plan starts no planner");

	const enrollment = replan(f, old.id);
	const enrolled = await f.post(enrollment);
	assert.equal(enrolled.state, "accepted", JSON.stringify(enrolled) + f.logs());
	const next = enrolled.result.missionId as string;
	assert.deepEqual(f.store.successor(old.id), { missionId: next, state: "planning" });
	assert.deepEqual(f.store.replaced(next), { missionId: old.id, state: "planning" });
	assert.equal(f.store.require(old.id).status, "active", "the old mission does not change");
	assert.equal((await f.post(enrollment, true)).state, "accepted", "lookup finds the saved enrollment");

	const again = await f.post(replan(f, old.id));
	assert.equal(again.state, "rejected");
	assert.match(again.reason, /already being re-planned/);
	const planned = await f.post(replan(f, next));
	assert.equal(planned.state, "rejected");
	assert.match(planned.reason, /already has a planning interview/);
	assert.equal(f.specs.length, 1);

	const day = await get(f, `/api/projects/${projectId}/day`);
	const row = (id: string) => day.dashboard.missions.items.find((m: { id: string }) => m.id === id);
	assert.deepEqual(row(old.id).successor, { missionId: next, state: "planning" });
	assert.equal(row(old.id).replaces, undefined);
	assert.deepEqual(row(next).replaces, { missionId: old.id, state: "planning" });
	assert.equal(row(old.id).needsYou, 0, "a re-planning link never needs the user");
	const inventory = await get(f, `/api/projects/${projectId}/planning-inventory`);
	assert.deepEqual(inventory.items.find((i: { missionId: string }) => i.missionId === next).replaces, {
		missionId: old.id,
		state: "planning",
	});

	assert.equal((await stop(f, old.id, { action: "abandon", newMissionId: next }, "")).status, 403);
	assert.equal((await stop(f, old.id, { action: "abandon", newMissionId: old.id })).status, 409);
	assert.equal((await stop(f, old.id, { action: "finish", newMissionId: next })).status, 400);
	for (let i = 0; i < 2; i++) {
		const stopped = await stop(f, old.id, { action: "abandon", newMissionId: next });
		assert.equal(stopped.status, 200);
		assert.deepEqual(await stopped.json(), { missionId: old.id, successor: { missionId: next, state: "abandoned" } });
	}
	assert.deepEqual(f.store.replaced(next), { missionId: old.id, state: "abandoned" });
	assert.equal(f.store.require(old.id).status, "active");
	assert.equal(f.store.require(next).status, "active", "the new mission stays");
	assert.doesNotThrow(() => f.store.assertReplaceable(old.id, projectId), "an abandoned link allows a new re-plan");
	await f.restart();
	assert.deepEqual(f.store.successor(old.id), { missionId: next, state: "abandoned" });
});
