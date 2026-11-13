import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectPreferences } from "@pilot/protocol";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";

test("project preference HTTP reads/history and native exact operation ACKs stay project-scoped", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const path = `/api/projects/${f.project.id}/preferences`;
	const read = async (suffix = "") => {
		const res = await fetch(f.root + path + suffix);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("cache-control"), "no-store");
		return res.json();
	};
	assert.equal((await read()).revision, 0);
	const op = f.operation(f.project.id, {
		purpose: "project-preferences-update",
		projectId: f.project.id,
		expectedRevision: 0,
		entries: [{ id: "style", text: "Use short paragraphs." }],
		reason: "Explicit user edit",
	} as { purpose: string });
	const denied = await f.post(op, false, "wrong");
	assert.notEqual(denied.status, 200);
	await denied.arrayBuffer();
	assert.equal((await read()).revision, 0);
	assert.equal((await (await f.post(op, true)).json()).state, "unknown");
	const receipt = await (await f.post(op)).json();
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.equal((receipt.result as ProjectPreferences).revision, 1);
	assert.deepEqual(receipt.result.entries[0].source, { type: "user" });
	assert.deepEqual(await (await f.post(op, true)).json(), receipt);
	assert.deepEqual(await (await f.post(op)).json(), receipt);
	assert.equal((await read()).revision, 1);
	const stale = f.operation(f.project.id, { ...JSON.parse(op.payload), reason: "Stale edit" });
	assert.equal((await (await f.post(stale)).json()).state, "rejected");
	const foreign = f.operation("foreign-project", JSON.parse(op.payload));
	assert.equal((await (await f.post(foreign)).json()).state, "rejected");
	const changed = { ...op, payload: `${op.payload} ` };
	const mismatch = await f.post(changed, true);
	assert.notEqual(mismatch.status, 200);
	await mismatch.arrayBuffer();
	const unknown = await fetch(`${f.root}/api/projects/missing/preferences`);
	assert.equal(unknown.status, 404);
	await unknown.arrayBuffer();
	const deniedPut = await fetch(f.root + path, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	assert.notEqual(deniedPut.status, 200);
	await deniedPut.arrayBuffer();
	const direct = await fetch(f.root + path, {
		method: "PUT",
		headers: { "content-type": "application/json", "x-pilot-github-capability": f.capability },
		body: JSON.stringify({ operationId: "direct-user", expectedRevision: 1, entries: [], reason: "User correction" }),
	});
	assert.equal(direct.status, 200);
	const domain = await direct.json();
	assert.equal(domain.state, "committed");
	assert.equal(domain.snapshot.revision, 2);
	assert.deepEqual(
		(await read("/history?limit=1")).revisions.map((r: ProjectPreferences) => r.revision),
		[2],
	);
	assert.deepEqual(
		(await read("/history?before=2")).revisions.map((r: ProjectPreferences) => r.revision),
		[1],
	);
	assert.deepEqual(await read("/operations/direct-user"), domain);
	await f.restart();
	assert.deepEqual(await (await f.post(op, true)).json(), receipt);
	assert.equal((await read()).revision, 2);
});
