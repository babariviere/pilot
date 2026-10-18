import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { readSessionSnapshot } from "./snapshot.ts";
import { openSessionStorage } from "./storage.ts";

test("automatic provenance survives SQLite restart and cold replay, while quoted user text stays user-authored", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-input-provenance-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const directory = join(home, "durable");
	const sender = "F8D1C654-6FF8-4D41-96E9-CEBD36A88C4A";
	const text = '"From the Global coordinator" should be a system event';
	const owned = await openSessionStorage(directory);
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "missing", modelId: "offline" } } });
		await root.commit(async (tx) => {
			for (const requestId of [
				`mission:send:from:${sender}:mission:delivery`,
				"control:send:delivery",
				"watch-notice:1",
				"typed-id",
			]) {
				const entry = await tx.appendEntry(root.id, {
					kind: "pi.user",
					model: [{ role: "user", content: text, timestamp: 1 }],
				});
				await tx.createSubmission({
					conversationId: root.id,
					requestId,
					type: "input",
					status: "placed",
					entry: entry.id,
				});
			}
		}, context);
	} finally {
		await harness.close(context);
		owned.release();
	}
	const read = async () => {
		const snapshot = (await readSessionSnapshot(directory, home)).events[0];
		assert.equal(snapshot?.type, "snapshot");
		return snapshot.entries.filter((entry) => entry.kind === "pi.user");
	};
	const before = await read();
	assert.deepEqual(
		before.map((entry) => ({
			origin: (entry as unknown as { origin?: string }).origin,
			sender: (entry as unknown as { sourceSessionId?: string }).sourceSessionId,
		})),
		[
			{ origin: "coordinator", sender },
			{ origin: "control", sender: undefined },
			{ origin: "watch", sender: undefined },
			{ origin: undefined, sender: undefined },
		],
	);
	const reopened = await openSessionStorage(directory);
	const recovered = await Harness.open(
		reopened.storage,
		{ models: createModels(), registry: createRegistry() },
		context,
	);
	try {
		assert.deepEqual(await read(), before, "reopening the writer never changes the original history or attribution");
	} finally {
		await recovered.close(context);
		reopened.release();
	}
});
