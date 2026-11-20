import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverTests, testLaneFiles, testLimits, testSuite, testWeight } from "./test-suites.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("a test's file name decides its suite", () => {
	for (const [path, suite] of [
		["packages/daemon/src/new-feature.test.ts", "integration"],
		["packages/kernel/src/model.integration.test.ts", "integration"],
		["packages/daemon/src/changes.stress.test.ts", "stress"],
		["packages/daemon/src/github.fast.test.ts", "fast"],
		["scripts/test-suites.fast.test.ts", "fast"],
		["apps/day/node-tests/refresh.test.ts", "integration"],
	])
		assert.equal(testSuite(path!), suite, path);
	assert.ok(
		testWeight("packages/daemon/src/shared-workspaces-import.integration.test.ts") >
			testWeight("packages/daemon/src/github.fast.test.ts"),
	);
});

test("discovery visits package sources, Day node tests and runner tests, never dependency trees", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-test-discovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const path of [
		"packages/a/src/nested/one.test.ts",
		"packages/a/node_modules/two.test.ts",
		"packages/a/test/legacy-fixture.ts",
		"apps/day/node-tests/three.test.ts",
		"apps/day/Screen.test.tsx",
		"scripts/runner.test.ts",
		"scripts/bench/nested.test.ts",
	]) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), "");
	}
	assert.deepEqual((await discoverTests(root)).sort(), [
		"apps/day/node-tests/three.test.ts",
		"packages/a/src/nested/one.test.ts",
		"scripts/runner.test.ts",
	]);
});

test("runner limits keep limited concurrency and the two-minute per-test deadline", () => {
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

test("the macos lane is a checked subset and stale configuration fails loudly", async () => {
	const files = await discoverTests(root);
	assert.deepEqual(testLaneFiles(files, "all"), files);
	const macos = testLaneFiles(files, "macos");
	assert.ok(macos.includes("packages/kernel/src/ask.integration.test.ts"));
	assert.ok(!macos.includes("packages/daemon/src/new-feature.test.ts"));
	assert.throws(
		() =>
			testLaneFiles(
				files.filter((path) => path !== "packages/kernel/src/ask.integration.test.ts"),
				"macos",
			),
		/Configured tests were not discovered: packages\/kernel\/src\/ask.integration.test.ts/,
	);
	assert.throws(
		() =>
			testLaneFiles(
				files.filter((path) => !path.includes("shared-workspaces-")),
				"all",
			),
		/Configured tests were not discovered: \/shared-workspaces-\//,
	);
});

test("runner lists a suite without running tests and refuses unknown options", async () => {
	const runner = fileURLToPath(new URL("./test.ts", import.meta.url));
	const files = await discoverTests(root);
	const listed = spawnSync(process.execPath, [runner, "--suite=fast", "--list"], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(listed.status, 0, listed.stderr);
	assert.deepEqual(
		listed.stdout.trim().split("\n").sort(),
		files.filter((path) => path.endsWith(".fast.test.ts")).sort(),
	);
	for (const [option, message] of [
		["--lane=portable", /Unknown test lane/],
		["--suite=typo", /Unknown test suite/],
	] as const) {
		const refused = spawnSync(process.execPath, [runner, option, "--list"], { encoding: "utf8" });
		assert.notEqual(refused.status, 0);
		assert.match(refused.stderr, message);
	}
	if (process.platform !== "darwin") {
		const native = spawnSync(process.execPath, [runner, "--lane=macos"], { encoding: "utf8" });
		assert.notEqual(native.status, 0);
		assert.match(native.stderr, /requires macOS/);
	}
});
