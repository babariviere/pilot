import assert from "node:assert/strict";
import { test } from "node:test";
import { mapSourceFixture } from "./map-source.fixture.ts";

test("drilldown fixture uses canonical records, cited history and passive reads after reopen", async (t) => {
	const records = await mapSourceFixture();
	const { f, decision, knowledge } = records;
	t.after(() => f.close());
	const read = () => f.read().then((r) => r.json());
	const before = await read();
	const headers = { "x-pilot-github-capability": f.capability };
	const original = await fetch(`${f.root}/api/projects/${f.project.id}/knowledge/${knowledge.entry.id}?revision=1`, {
		headers,
	});
	assert.equal(original.status, 200);
	assert.match((await original.json()).revision.body, /exact 💬 bytes/);
	const linked = await fetch(`${f.root}/api/missions/${f.missionId}/knowledge/${knowledge.entry.id}`, { headers });
	assert.equal(linked.status, 200);
	assert.equal((await linked.json()).linked, true);
	assert.equal(before.view.map.items[0].settledBy.id, decision.id);
	assert.equal(before.view.map.items[1].settledBy.id, knowledge.entry.id);
	await f.restart();
	assert.deepEqual((await read()).view.map, before.view.map);
	await records.append();
	await records.replace();
	const changed = await read();
	assert.equal(changed.view.map.items[0].settledBy.state, "missing");
	assert.equal(changed.view.map.items[1].settledBy.state, "changed");
	assert.equal(f.store.detail(f.missionId).decisions[0]!.text, decision.text);
	assert.equal(
		f.store.knowledge.detail(f.project.id, knowledge.entry.id, 1)!.revision.body,
		"# Question\r\nNative storage?\r\n# Findings\r\nObserved: exact 💬 bytes.\r\n# Limitations\r\nOne fixture only.",
	);
	assert.equal(f.store.plans.get(f.missionId)!.revision, 3);
	assert.equal(f.store.tasks(f.missionId).length, 0);
	assert.equal(f.store.interviews.latest(f.missionId)!.submission, null);
	await records.fillSummary();
	const limited = await read();
	assert.equal(limited.view.knowledge.entries.length, 40);
	assert.equal(
		limited.view.knowledge.entries.some((entry: { id: string }) => entry.id === knowledge.entry.id),
		false,
	);
	assert.equal(
		f.store.knowledge.link(f.missionId, knowledge.entry.id).linked,
		true,
		"a limited summary is not an access check",
	);
	await records.unlink();
	assert.equal((await read()).view.map.items[1].settledBy.state, "missing");
	f.coordinator = { ...f.coordinator!, mode: "ask" };
	assert.equal((await f.read()).status, 409);
});
