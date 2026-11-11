import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation, TodayIntake } from "@pilot/protocol";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";
import { payloadHash } from "./operation-journal.ts";

test("authenticated HTTP intake, exact receipts and project-pinned durable Build without external I/O", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const read = (token = f.capability) =>
		fetch(`${f.root}/api/projects/${f.project.id}/intake`, { headers: { "x-pilot-github-capability": token } });
	const denied = await read("wrong");
	assert.notEqual(denied.status, 200);
	await denied.arrayBuffer();
	let page = (await (await read()).json()) as TodayIntake;
	assert.equal(page.projectId, f.project.id);
	assert.equal(page.sources[1]!.total, 2);
	assert.equal(page.sources[1]!.complete, true);
	const operation = (purpose: string, fields: object): DurableOperation => {
		const item = page.sources[1]!.items[0]!;
		const payload = JSON.stringify({
			purpose,
			projectId: f.project.id,
			itemId: item.id,
			revision: item.revision,
			contextDigest: page.contextDigest,
			...fields,
		});
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.host, hostId: "local" },
			destination: f.host,
			kind: purpose,
			targetId: item.id,
			payload,
			payloadHash: payloadHash(payload),
			bindingId: page.contextDigest,
			bindingGeneration: 1,
		};
	};
	const post = (op: DurableOperation, lookup = false, token = f.capability) =>
		fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pilot-github-capability": token },
			body: JSON.stringify(op),
		});
	const later = operation("intake-triage", { state: "later" });
	assert.equal((await (await post(later)).json()).state, "accepted");
	page = (await (await read()).json()) as TodayIntake;
	assert.equal(page.sources[1]!.items[0]!.triageState, "later");
	assert.equal((await (await post(operation("intake-triage", { state: "new" }))).json()).state, "accepted");
	page = (await (await read()).json()) as TodayIntake;
	const sessionId = randomUUID(),
		start = operation("intake-start", { sessionId });
	const ack = await (await post(start)).json();
	assert.equal(ack.state, "accepted", JSON.stringify(ack));
	const meta = JSON.parse(await readFile(join(f.home, "sessions", sessionId, "meta.json"), "utf8"));
	assert.equal(meta.projectId, f.project.id);
	assert.equal(meta.mode, "build");
	assert.equal(meta.model, "fake/model");
	assert.equal(meta.createOperationId, start.operationId);
	assert.equal(meta.pending[0].requestId, start.operationId);
	assert.deepEqual(await (await post(start, true)).json(), ack);
	assert.deepEqual(await (await post(start)).json(), ack);
	const hidden = await post(start, true, "wrong");
	assert.notEqual(hidden.status, 200);
	await hidden.arrayBuffer();
	assert.equal(f.stats().sessions, 1);
	assert.equal(f.stats().external, 0);
	assert.equal((await f.items.require(start.targetId)).sessionId, sessionId);
	await f.projects.update(f.project.id, { tracking: { linearTeam: "CHANGED", slackChannels: [] } });
	// Changed configuration is not allowed to expose previously synced team rows.
	// Add the old checkpoint explicitly because initial fixture rows predate any sync.
	await f.items.commit(f.project.id, "linear", [], { configKey: "old-team", lastPolledAt: 1 });
	page = (await (await read()).json()) as TodayIntake;
	assert.equal(page.sources[1]!.items.length, 0);
	assert.equal(page.sources[1]!.status, "idle");
});
