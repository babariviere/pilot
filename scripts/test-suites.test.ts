import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverTests, testInLane, testLaneFiles, testLimits, testSuite, testWeight } from "./test-suites.ts";

test("suite defaults and explicit classifications keep integration out of the fast path", () => {
	for (const [path, suite] of [
		["packages/daemon/src/new-feature.test.ts", "integration"],
		["packages/kernel/src/model.integration.test.ts", "integration"],
		["packages/daemon/src/changes.stress.test.ts", "stress"],
		["packages/daemon/src/github.test.ts", "fast"],
		["scripts/test-suites.test.ts", "fast"],
		["scripts/new-runner.test.ts", "integration"],
	])
		assert.equal(testSuite(path!), suite, path);
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
		"packages/a/test/legacy-fixture.ts",
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

test("CI lane selection validates configured paths and defaults new tests to Linux", async () => {
	const files = await discoverTests(fileURLToPath(new URL("../", import.meta.url)));
	assert.deepEqual(testLaneFiles(files, "all"), files);
	assert.deepEqual(testLaneFiles(files, "portable"), files);
	assert.equal(testInLane("packages/daemon/src/new-feature.test.ts", "portable"), true);
	assert.equal(testInLane("packages/daemon/src/new-feature.test.ts", "macos"), false);
	assert.equal(testInLane("packages/kernel/src/ask.integration.test.ts", "portable"), true);
	assert.equal(testInLane("packages/kernel/src/ask.integration.test.ts", "macos"), true);
	assert.deepEqual(
		testLaneFiles(files, "macos"),
		files.filter((path) => testInLane(path, "macos")),
	);
	assert.throws(
		() =>
			testLaneFiles(
				files.filter((path) => path !== "packages/kernel/src/ask.integration.test.ts"),
				"macos",
			),
		/Configured macos tests were not discovered: packages\/kernel\/src\/ask.integration.test.ts/,
	);
});

test("runner lists lane and suite intersections without running tests, and rejects unknown lanes", async () => {
	const runner = fileURLToPath(new URL("./test.ts", import.meta.url));
	const root = fileURLToPath(new URL("../", import.meta.url));
	const files = await discoverTests(root);
	for (const lane of ["all", "portable", "macos"] as const) {
		for (const suite of ["all", "fast", "integration", "stress"] as const) {
			const expected = files.filter(
				(path) => testInLane(path, lane) && (suite === "all" || testSuite(path) === suite),
			);
			const result = spawnSync(process.execPath, [runner, `--lane=${lane}`, `--suite=${suite}`, "--list"], {
				encoding: "utf8",
				timeout: 10_000,
			});
			if (!expected.length) {
				assert.notEqual(result.status, 0);
				assert.match(result.stderr, /No tests in suite/);
			} else {
				assert.equal(result.status, 0, result.stderr);
				assert.deepEqual(result.stdout.trim().split("\n").sort(), expected.sort());
			}
		}
	}
	const invalid = spawnSync(process.execPath, [runner, "--lane=typo", "--list"], { encoding: "utf8" });
	assert.notEqual(invalid.status, 0);
	assert.match(invalid.stderr, /Unknown test lane/);
	if (process.platform !== "darwin") {
		const native = spawnSync(process.execPath, [runner, "--lane=macos"], { encoding: "utf8" });
		assert.notEqual(native.status, 0);
		assert.match(native.stderr, /requires macOS/);
	}
});
