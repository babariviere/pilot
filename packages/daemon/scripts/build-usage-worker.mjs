/** Release-time only. Keep accounting's isolated worker free of the per-isolate TS parser. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const modules = ["usage-history-worker", "usage-history-disk", "usage-history-validation"];
const sourceEntry = 'new URL("./usage-history-worker.ts", import.meta.url)';
const generatedEntry = 'new URL("./usage-history-worker.mjs", import.meta.url)';

export async function generatedModules(directory, names = modules) {
	const outputs = new Map();
	for (const name of names) {
		let code = stripTypeScriptTypes(await readFile(join(directory, `${name}.ts`), "utf8"));
		// Fail packaging if this deliberately closed leaf graph gains another runtime dependency.
		// Match import/export clauses, not ordinary query field strings such as ["from", "to"].
		for (const [, dependency] of code.matchAll(
			/\b(?:import|export)\s*(?:\(\s*|[^;"']*?\bfrom\s*)?["']([^"']+)["']/g,
		)) {
			assert.ok(dependency.startsWith("node:") || names.some((module) => dependency === `./${module}.ts`));
		}
		for (const module of names) code = code.replaceAll(`./${module}.ts`, `./${module}.mjs`);
		outputs.set(`${name}.mjs`, code);
	}
	return outputs;
}

const fundingModules = ["funding-worker", "funding-disk", "funding-errors"];
const fundingSource = 'new URL("./funding-worker.ts", import.meta.url)';
const fundingGenerated = 'new URL("./funding-worker.mjs", import.meta.url)';
export async function buildFundingWorker(directory) {
	const file = join(directory, "funding.ts"),
		source = await readFile(file, "utf8");
	assert.equal(
		source.split(fundingSource).length + source.split(fundingGenerated).length,
		3,
		"Expected one funding worker entry",
	);
	for (const [name, code] of await generatedModules(directory, fundingModules))
		await writeFile(join(directory, name), code);
	await writeFile(file, source.replace(fundingSource, fundingGenerated));
}
export async function checkFundingWorker(directory) {
	const source = await readFile(join(directory, "funding.ts"), "utf8");
	assert.ok(
		source.includes(fundingGenerated) && !source.includes(fundingSource),
		"Generated funding worker is not selected",
	);
	for (const [name, code] of await generatedModules(directory, fundingModules))
		assert.equal(await readFile(join(directory, name), "utf8"), code, `Stale generated funding module: ${name}`);
	const { Funding } = await import(pathToFileURL(join(directory, "funding.ts")));
	const home = await mkdtemp(join(tmpdir(), "funding-runtime-smoke-")),
		funding = new Funding(join(home, "funding.sqlite"));
	try {
		const owner = { kind: "quick_fix", id: "runtime-smoke" };
		await funding.open(owner, 1000);
		await funding.reserve(owner, "one", {
			provider: "fixture",
			model: "fixture",
			inputTokens: 10,
			outputTokens: 10,
			rate: { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 },
		});
		assert.equal((await funding.read()).accounts[0].uncertainMicros, 30);
		await funding.settle(owner, "one", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
		assert.equal((await funding.read()).accounts[0].spentMicros, 2);
	} finally {
		await funding.close();
		await rm(home, { recursive: true, force: true });
	}
}

export async function buildUsageWorker(directory) {
	const file = join(directory, "usage-history.ts");
	const source = await readFile(file, "utf8");
	assert.equal(source.split(sourceEntry).length + source.split(generatedEntry).length, 3, "Expected one worker entry");
	const outputs = await generatedModules(directory);
	for (const [name, code] of outputs) await writeFile(join(directory, name), code);
	// Switch the release copy only, after all generated dependencies exist. Developer sources stay TS.
	await writeFile(file, source.replace(sourceEntry, generatedEntry));
}

export async function checkUsageWorker(directory) {
	const source = await readFile(join(directory, "usage-history.ts"), "utf8");
	assert.ok(source.includes(generatedEntry) && !source.includes(sourceEntry), "Generated worker is not selected");
	for (const [name, code] of await generatedModules(directory)) {
		assert.equal(await readFile(join(directory, name), "utf8"), code, `Stale generated worker module: ${name}`);
	}
	const { UsageHistoryStore } = await import(pathToFileURL(join(directory, "usage-history.ts")));
	const home = await mkdtemp(join(tmpdir(), "usage-runtime-smoke-"));
	const now = Date.now();
	const store = new UsageHistoryStore(home, () => now);
	try {
		const status = await store.status();
		assert.equal(
			await store.put({
				schemaVersion: 1,
				generation: status.generation,
				sourceId: "11111111-1111-4111-8111-111111111111",
				operationId: "runtime-smoke",
				revision: 1,
				kind: "request",
				scope: "direct",
				observedAt: now,
				completedAt: now,
				coverage: "committed",
				purpose: "other",
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoningStatus: "unavailable" },
				cost: { estimateStatus: "unavailable", billedStatus: "unavailable", subscriptionCoverage: "unknown" },
			}),
			"stored",
		);
		const page = await store.page({ kind: "request", from: now - 1, to: now + 1 });
		assert.equal(page.rows.length, 1);
		assert.equal(page.rows[0].operationId, "runtime-smoke");
		const summary = await store.analytics({ version: 1, view: "summary", from: now - 1, to: now + 1 });
		assert.equal(summary.total.records, 1);
		assert.equal(summary.total.metrics.input.value, 1);
		assert.equal(summary.total.metrics.reasoning.value, undefined);
		assert.equal(summary.total.metrics.reasoning.unknown, 1);
		assert.equal(summary.reconciliation.records, 0);
		assert.equal((await store.clear()).retainedRows, 0);
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [action, directory, layout, ...extra] = process.argv.slice(2);
	assert.ok(
		directory &&
			(action === "build" || action === "check") &&
			(layout === undefined || layout === "--usage-only") &&
			!extra.length,
		"Usage: build-usage-worker.mjs build|check <src-directory> (or <usage-directory> --usage-only)",
	);
	// Packagers always require both leaves. Only isolated probes pass a standalone usage directory.
	const usageOnly = layout === "--usage-only";
	const usage = usageOnly ? resolve(directory) : resolve(directory, "models/usage");
	const funding = resolve(directory, "models/funding");
	if (action === "build") {
		await buildUsageWorker(usage);
		if (!usageOnly) await buildFundingWorker(funding);
	} else {
		await checkUsageWorker(usage);
		if (!usageOnly) await checkFundingWorker(funding);
	}
}
