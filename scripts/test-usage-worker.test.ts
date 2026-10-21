import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./bench/usage-worker.mjs", import.meta.url));
function fixture(overrides: NodeJS.ProcessEnv, args = [script]) {
	const home = mkdtempSync(join(tmpdir(), "usage-probe-test-"));
	try {
		return spawnSync(process.execPath, args, {
			env: { PATH: process.env.PATH, HOME: home, PI_OFFLINE: "1", ...overrides },
			encoding: "utf8",
			timeout: 120_000,
			maxBuffer: 1024 * 1024,
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("offline worker probe rejects unknown variants/cases and unbounded work before seeding", () => {
	for (const overrides of [
		{ USAGE_BENCH_TRIALS: "6" },
		{ USAGE_BENCH_BATCHES: "0" },
		{ USAGE_BENCH_BATCHES: "10", USAGE_BENCH_BATCH_SIZE: "2000" },
		{ USAGE_BENCH_CASES: "live" },
		{ USAGE_WORKER_VARIANTS: "unknown" },
	]) {
		const result = fixture(overrides);
		assert.equal(result.status, 1, result.stderr);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /AssertionError/);
	}
});

test("release generator is deterministic, relocatable and fails closed on missing/stale dependencies", () => {
	const root = mkdtempSync(join(tmpdir(), "usage-release-test-"));
	const builder = fileURLToPath(new URL("../packages/daemon/scripts/build-usage-worker.mjs", import.meta.url));
	const source = fileURLToPath(new URL("../packages/daemon/src/", import.meta.url));
	let directory = root;
	try {
		writeFileSync(join(directory, "package.json"), '{"type":"module"}');
		for (const name of ["usage-history", "usage-history-worker", "usage-history-disk", "usage-history-validation"])
			copyFileSync(join(source, `${name}.ts`), join(directory, `${name}.ts`));
		const run = (action: string) => fixture({}, [builder, action, directory]);
		assert.equal(run("build").status, 0);
		const original = readFileSync(join(directory, "usage-history-disk.mjs"), "utf8");
		assert.equal(run("build").status, 0, "rebuilding must refresh outputs, not select stale ones");
		assert.equal(readFileSync(join(directory, "usage-history-disk.mjs"), "utf8"), original);
		renameSync(directory, `${root}-relocated`);
		directory = `${root}-relocated`;
		assert.equal(run("check").status, 0, "real generated worker must survive relocation");
		writeFileSync(join(directory, "usage-history-disk.mjs"), `${original}\n// stale`);
		assert.match(run("check").stderr, /Stale generated worker module/);
		assert.equal(run("build").status, 0);
		rmSync(join(directory, "usage-history-validation.mjs"));
		assert.notEqual(run("check").status, 0, "missing dependency must fail the package gate");
		assert.equal(run("build").status, 0);
		const worker = join(directory, "usage-history-worker.ts");
		writeFileSync(worker, `${readFileSync(worker, "utf8")}\nimport "unexpected-sdk";`);
		assert.notEqual(run("build").status, 0, "new runtime dependencies require explicit review");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("offline shipped and diagnostic worker graphs run with provenance and bounded synthetic work", () => {
	const result = fixture({
		USAGE_BENCH_TRIALS: "1",
		USAGE_BENCH_BATCHES: "1",
		USAGE_BENCH_BATCH_SIZE: "1",
		USAGE_BENCH_CASES: "empty,serialized_queries,writes",
	});
	assert.equal(result.status, 0, result.stderr);
	const lines = result.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const metadata = lines.shift().metadata;
	assert.equal(metadata.kind, "isolated-shipped-worker-leaf-not-installed-daemon");
	assert.match(metadata.nodeSha256, /^[a-f0-9]{64}$/);
	assert.equal(Object.keys(metadata.sourceSha256).length, 5);
	assert.ok(!metadata.environmentKeys.includes("NODE_OPTIONS"));
	assert.deepEqual(metadata.environmentKeys, ["HOME", "PATH", "PI_OFFLINE"]);
	const summary = lines.pop().summary;
	assert.equal(lines.length, 12);
	assert.equal(summary.length, 12);
	for (const row of lines) {
		assert.equal(row.batches * row.batchSize, 1);
		assert.ok(Number.isFinite(row.activePeakRssDeltaMiB));
		if (row.kind === "serialized_queries") {
			assert.ok(row.maxResponseBytes > 0 && row.maxResponseBytes <= 512 * 1024);
			assert.ok(row.queryP95Ms > 0);
		}
	}
});
