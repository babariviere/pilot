// biome-ignore-all lint/complexity/useLiteralKeys: Exercise the private start boundary without a model process.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

test("reserved create recovers exact metadata and opening admission, and send reuses its pending key", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-reserved-create-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const targetId = randomUUID();
	const operationId = randomUUID();
	const create = () => {
		const manager = new SessionManager(home, new ProjectStore(home));
		t.mock.method(manager as unknown as { start(): Promise<Map<string, Error>> }, "start", async () => new Map());
		return manager;
	};
	const first = create();
	const request = { cwd: home, message: "opening input" };
	const created = await first.spawnDurable(request, targetId, operationId);
	assert.equal(created.id, targetId);
	const retry = await first.spawnDurable(request, targetId, operationId);
	assert.equal(retry.id, targetId);
	assert.equal(first.list().length, 1);
	const metadata = () => readFile(join(home, "sessions", targetId, "meta.json"), "utf8").then(JSON.parse);
	const opening = await metadata();
	assert.equal(opening.createOperationId, operationId);
	assert.equal(opening.pending.length, 1);
	assert.equal(opening.pending[0].requestId, operationId);
	const reopened = create();
	await reopened.load();
	t.after(() => reopened.shutdown());
	assert.equal((await reopened.spawnDurable(request, targetId, operationId)).id, targetId);
	await assert.rejects(reopened.spawnDurable(request, targetId, randomUUID()), /another operation/);
	const sendId = randomUUID();
	await reopened.sendDurable(targetId, "second input", "followUp", sendId);
	await reopened.sendDurable(targetId, "second input", "followUp", sendId);
	assert.equal(
		(await metadata()).pending.filter((item: { requestId: string }) => item.requestId === sendId).length,
		1,
	);
});
