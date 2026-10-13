import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Cassette, cassetteRunner, cassetteSource, loadCassette } from "./cassette.ts";

test("replay matches complete JSON requests in order, ignores object key order, and isolates responses", async (t) => {
	t.mock.method(globalThis, "fetch", () => assert.fail("cassette replay must remain offline"));
	const cassette = new Cassette("synthetic", [
		{ request: { tool: "issues", args: { team: "team", cursor: "next" } }, response: { issues: ["one"] } },
		{ request: { tool: "issues", args: { cursor: "next", team: "team" } }, response: { issues: ["one"] } },
	]);
	assert.throws(() => cassette.assertDone(), /2 unused/);
	assert.throws(
		() => cassette.replay({ tool: "issues", args: { team: "other", cursor: "next" } }),
		/unmatched request #1/,
	);
	const source = cassetteSource(cassette);
	const response = (await source("issues", { cursor: "next", team: "team", optional: undefined })) as {
		issues: string[];
	};
	response.issues.push("mutation");
	assert.deepEqual(await source("issues", { team: "team", cursor: "next" }), { issues: ["one"] });
	cassette.assertDone();
	await assert.rejects(source("issues", { team: "team" }), /unmatched request #3/);
});

test("runner replay never falls through, honors abort, and does not echo sensitive mismatches", async () => {
	const cassette = new Cassette("gh", [{ request: { file: "gh", args: ["api", "graphql"] }, response: "{}" }]);
	const run = cassetteRunner(cassette);
	await assert.rejects(
		run("gh", ["private-argument"], "/unused"),
		(error: Error) => !error.message.includes("private-argument"),
	);
	await assert.rejects(run("gh", ["api", "graphql"], "/unused", undefined, AbortSignal.abort()), /abort/i);
	assert.equal(await run("gh", ["api", "graphql"], "/unused"), "{}");
	cassette.assertDone();
	await assert.rejects(run("curl", ["https://example.test"], "/unused"), /unmatched/);
});

test("cassette documents are versioned and non-JSON values cannot silently match", async (t) => {
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	for (const response of [NaN, Infinity, () => {}, new Map(), new Date(), [undefined], cycle])
		assert.throws(() => new Cassette("invalid", [{ request: {}, response: response as never }]), /JSON/);
	const cassette = await loadCassette(new URL("../fixtures/cassettes/github-discovery.json", import.meta.url));
	assert.throws(() => cassette.assertDone(), /unused/);
	const root = await mkdtemp(join(tmpdir(), "pilot-cassette-validation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "invalid.json");
	for (const document of [
		{ version: 2, entries: [] },
		{ version: 1, entries: [{}] },
		{ version: 1, entries: "bad" },
	]) {
		await writeFile(path, JSON.stringify(document));
		await assert.rejects(loadCassette(pathToFileURL(path)), /Invalid cassette document/);
	}
});
