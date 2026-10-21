/** Offline shipped-worker leaf probe. No install, live daemon, credentials or provider imports. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.argv[2] ?? fileURLToPath(new URL("../../", import.meta.url));
const variants = ["shipped", "nursery1", "js_worker", "js_worker_nursery1"];
const modules = ["usage-history", "usage-history-worker", "usage-history-disk", "usage-history-validation"];
const trials = Number(process.env.USAGE_BENCH_TRIALS ?? 3);
const batches = Number(process.env.USAGE_BENCH_BATCHES ?? 3);
const batchSize = Number(process.env.USAGE_BENCH_BATCH_SIZE ?? 500);
const cases = (process.env.USAGE_BENCH_CASES ?? "none,bare,empty,populated,queries,serialized_queries,writes").split(
	",",
);
assert.ok(Number.isInteger(trials) && trials > 0 && trials <= 5);
assert.ok(Number.isInteger(batches) && batches > 0 && batches <= 10);
assert.ok(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 2000 && batches * batchSize <= 10000);
assert.ok(cases.length > 0 && cases.length <= 7);
assert.ok(
	cases.every((kind) =>
		["none", "bare", "empty", "populated", "queries", "serialized_queries", "writes"].includes(kind),
	),
);
const selected = (process.env.USAGE_WORKER_VARIANTS ?? variants.join(",")).split(",");
assert.ok(selected.length > 0 && selected.length <= 4 && selected.every((variant) => variants.includes(variant)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const directory = await mkdtemp(join(tmpdir(), "usage-worker-"));
// Nothing from the agent environment is passed through except the offline fixture allowlist.
const env = Object.fromEntries(
	["PATH", "TMPDIR", "SYSTEMROOT"].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
);
Object.assign(env, { HOME: directory, PI_OFFLINE: "1" });
async function run(node, args) {
	const child = spawn(node, args, { env, cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const [code] = await once(child, "close");
	if (code !== 0) throw new Error(`Offline fixture failed (${code}): ${stderr}`);
	return stdout;
}
try {
	const generator = await readFile(join(root, "packages/daemon/scripts/build-usage-worker.mjs"));
	const generatorFile = join(directory, "build-usage-worker.mjs");
	await writeFile(generatorFile, generator);
	const { buildUsageWorker } = await import(pathToFileURL(generatorFile));
	const binary = await readFile(process.execPath);
	const node = join(directory, "runtime/node/bin/node");
	await mkdir(dirname(node), { recursive: true });
	await copyFile(process.execPath, node);
	const hashes = {};
	const sources = {};
	for (const name of [...modules, "usage-history.bench"]) {
		const bytes = await readFile(join(root, `packages/daemon/src/${name}.ts`));
		hashes[`${name}.ts`] = hash(bytes);
		sources[name] = bytes.toString("utf8");
	}
	console.log(
		JSON.stringify({
			metadata: {
				kind: "isolated-shipped-worker-leaf-not-installed-daemon",
				platform: process.platform,
				arch: process.arch,
				versions: process.versions,
				nodeSha256: hash(binary),
				sourceSha256: hashes,
				generatorSha256: hash(generator),
				trials,
				batches,
				batchSize,
				cases,
				variants: selected,
				environmentKeys: Object.keys(env).sort(),
				forcedGc: "none; source harness main_gc_only stage is a no-op without --expose-gc",
			},
		}),
	);
	for (const variant of selected) {
		const src = join(directory, variant, "runtime/packages/daemon/src");
		await mkdir(src, { recursive: true });
		await writeFile(join(src, "../package.json"), '{"type":"module"}');
		for (const [name, original] of Object.entries(sources)) {
			let code = original;
			if (name === "usage-history" && variant.includes("nursery1")) {
				assert.equal(code.split("workerData: { file:").length, 2);
				code = code.replace(
					"workerData: { file:",
					"resourceLimits: { maxYoungGenerationSizeMb: 1 },\n\t\t\tworkerData: { file:",
				);
			}
			await writeFile(join(src, `${name}.ts`), code);
		}
		if (variant.startsWith("js_worker")) {
			await buildUsageWorker(src);
			await run(node, [generatorFile, "check", src]);
		}
	}
	const now = Date.now();
	const seed = join(directory, "seed");
	const bench = (variant) => join(directory, variant, "runtime/packages/daemon/src/usage-history.bench.ts");
	// A separate exited process seeds; no measured process ever loads the 50k fixture into its allocator.
	await run(node, [bench(selected[0]), "--seed", seed, String(now)]);
	const results = [];
	for (let trial = 0; trial < trials; trial++) {
		// Reverse alternating pair order. Every case/variant gets a fresh process and fresh database copy.
		for (const variant of trial % 2 ? [...selected].reverse() : selected) {
			for (const kind of cases) {
				const home = join(directory, `sample-${trial}-${variant}-${kind}`);
				if (["populated", "queries", "serialized_queries", "writes"].includes(kind)) {
					await mkdir(join(home, "accounting"), { recursive: true });
					await copyFile(
						join(seed, "accounting/usage-history.sqlite"),
						join(home, "accounting/usage-history.sqlite"),
					);
				}
				// Match production ProgramArguments, with no --expose-gc or agent NODE_OPTIONS.
				const result = JSON.parse(
					await run(node, [
						bench(variant),
						"--sample",
						kind,
						home,
						String(now),
						String(batches),
						String(batchSize),
					]),
				);
				const record = { trial, variant, ...result };
				results.push(record);
				console.log(JSON.stringify(record));
				await rm(home, { recursive: true, force: true });
			}
		}
	}
	const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
	console.log(
		JSON.stringify({
			summary: selected.flatMap((variant) =>
				cases.map((kind) => {
					const rows = results.filter((row) => row.variant === variant && row.kind === kind);
					return {
						variant,
						kind,
						peaksMiB: rows.map((row) => row.activePeakRssDeltaMiB),
						medianPeakMiB: median(rows.map((row) => row.activePeakRssDeltaMiB)),
						medianCpuMs: median(rows.map((row) => row.cpuMs)),
						queryP95Ms: rows.map((row) => row.queryP95Ms),
						maxResponseBytes: Math.max(...rows.map((row) => row.maxResponseBytes)),
					};
				}),
			),
		}),
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
