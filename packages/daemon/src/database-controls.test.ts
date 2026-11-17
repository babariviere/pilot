import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseService } from "./databases.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";

test("native revoke stays available for an ineligible agent, unlike new approvals", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const original = f.sessions.databaseControls.bind(f.sessions);
	t.mock.method(f.sessions, "databaseControls", async (projectId: string) => ({
		...(await original(projectId)),
		agents: [
			{
				id: "agent",
				title: "Inactive builder",
				provider: "test",
				eligible: false,
				grants: [{ env: "prod.eu-1", mode: "read" as const, scope: "scope" }],
				request: { id: "request", env: "prod.eu-1", mode: "read" as const, scope: "scope" },
			},
		],
	}));
	const revoked = t.mock.method(f.sessions, "revokeDatabaseAccess", async () => {});
	const r = await fetch(`${f.root}/api/database-controls?projectId=${f.project.id}`, {
		headers: { "x-pilot-github-capability": f.capability },
	});
	assert.equal(r.status, 200);
	const s = await r.json();
	const op = (action: string, value: unknown) =>
		f.operation(
			f.project.id,
			{ purpose: "database-controls", projectId: f.project.id, binding: s.binding, action, value },
			s.binding,
		);
	assert.equal(
		(await (await f.post(op("decide", { agentId: "agent", requestId: "request", allow: true }))).json()).state,
		"rejected",
	);
	assert.equal(
		(await (await f.post(op("revoke", { agentId: "agent", env: "prod.eu-1", mode: "read" }))).json()).state,
		"accepted",
	);
	assert.equal(revoked.mock.callCount(), 1);
});

test("native settings are passive, fenced and deduplicated through production HTTP", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "native-database-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let queries = 0;
	const db = new DatabaseService(dir, async () => {
		queries++;
		return [];
	});
	const f = await nativePlanningFixture({ databases: db });
	t.after(() => f.close());
	const headers = { "x-pilot-github-capability": f.capability };
	const url = `${f.root}/api/database-controls?projectId=${f.project.id}`;
	const read = async () => {
		const r = await fetch(url, { headers });
		assert.equal(r.status, 200);
		return r.json();
	};
	const denied = await fetch(url);
	assert.equal(denied.status, 403);
	await denied.arrayBuffer();
	const first = await read();
	await read();
	assert.equal(queries, 0);
	const op = (binding: string, value: unknown) =>
		f.operation(
			f.project.id,
			{ purpose: "database-controls", projectId: f.project.id, binding, action: "save", value },
			binding,
		);
	const save = op(first.binding, { environments: [{ name: "staging", read: { url: "postgres://reader@host/db" } }] });
	const receipt = await (await f.post(save)).json();
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.deepEqual(await (await f.post(save)).json(), receipt);
	assert.equal(queries, 0);
	const settings = await read();
	assert.equal(settings.settings.environments[0].read.host, "host");
	assert.equal(settings.settings.environments[0].read.access, "ask");
	const stale = await (await f.post(op(first.binding, { environments: [] }))).json();
	assert.equal(stale.state, "rejected");
	const unsafe = await (
		await f.post(
			op(settings.binding, { environments: [{ name: "bad", read: { url: "postgres://reader:secret@host/db" } }] }),
		)
	).json();
	assert.equal(unsafe.state, "rejected");
	assert.doesNotMatch(JSON.stringify(await read()), /secret/);
});
