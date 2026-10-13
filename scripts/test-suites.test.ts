import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverTests, testLimits, testSuite, testWeight } from "./test-suites.ts";

test("suites partition every test, keeping new tests and integration files out of the fast path", async () => {
	const files = await discoverTests(fileURLToPath(new URL("../", import.meta.url)));
	const groups = ["fast", "integration", "stress"] as const;
	assert.equal(
		groups.reduce((count, group) => count + files.filter((file) => testSuite(file) === group).length, 0),
		files.length,
	);
	assert.equal(testSuite("packages/daemon/src/new-feature.test.ts"), "integration");
	assert.equal(testSuite("packages/kernel/src/model.integration.test.ts"), "integration");
	assert.equal(testSuite("packages/daemon/src/changes.stress.test.ts"), "stress");
	assert.equal(testSuite("packages/daemon/src/github.test.ts"), "fast");
	assert.ok(
		testWeight("packages/daemon/src/shared-workspaces-import.integration.test.ts") >
			testWeight("packages/daemon/src/github.test.ts"),
	);
});

test("discovery visits package sources, never dependency trees, and includes runner tests", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-test-discovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const path of [
		"packages/a/src/nested/one.test.ts",
		"packages/a/node_modules/two.test.ts",
		"scripts/runner.test.ts",
	]) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), "");
	}
	assert.deepEqual((await discoverTests(root)).sort(), [
		"packages/a/src/nested/one.test.ts",
		"scripts/runner.test.ts",
	]);
});

test("runner limits preserve bounded concurrency and the two-minute per-test deadline", () => {
	assert.deepEqual(testLimits({}), { concurrency: 2, timeoutMs: 120_000 });
	assert.deepEqual(testLimits({ PILOT_TEST_CONCURRENCY: "4", PILOT_TEST_TIMEOUT_MS: "5000" }), {
		concurrency: 4,
		timeoutMs: 5_000,
	});
	for (const name of ["PILOT_TEST_CONCURRENCY", "PILOT_TEST_TIMEOUT_MS"]) {
		for (const value of ["", "0", "-1", "1.5", "Infinity", "no", "9999999999999999999"])
			assert.throws(() => testLimits({ [name]: value }), /positive integer/);
	}
});
