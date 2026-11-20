import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readonlyModelsStore } from "./readonly-models-store.ts";

test("the read-only catalog store serves the published provider entry and ignores writes", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-catalog-store-"));
	try {
		const path = join(root, "models-store.json");
		writeFileSync(
			path,
			JSON.stringify({
				minimax: {
					models: [{ id: "MiniMax-M3.1-Flash", provider: "minimax", api: "anthropic-messages" }],
					lastModified: 1792673387000,
					checkedAt: 1793003917142,
					etag: 'W/"abc"',
				},
			}),
		);
		const store = readonlyModelsStore(path);
		const entry = await store.read("minimax");
		assert.equal(entry?.models.length, 1);
		assert.equal(entry?.models[0]?.id, "MiniMax-M3.1-Flash");
		assert.equal(entry?.lastModified, 1792673387000);
		assert.equal(await store.read("zai"), undefined);
		// The daemon owns the catalog: a worker never writes it, and a write never fails a refresh.
		await store.write("minimax", { models: [] });
		assert.equal((await store.read("minimax"))?.models.length, 1);
		await store.delete("minimax");
		assert.equal((await store.read("minimax"))?.models.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a missing or malformed catalog store is reported, not guessed", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-catalog-store-"));
	try {
		const missing = readonlyModelsStore(join(root, "absent.json"));
		assert.equal(await missing.read("minimax"), undefined);
		const path = join(root, "models-store.json");
		writeFileSync(path, "{not json");
		const broken = readonlyModelsStore(path);
		await assert.rejects(broken.read("minimax"), /JSON/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
