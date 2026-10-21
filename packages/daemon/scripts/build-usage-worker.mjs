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

export async function generatedModules(directory) {
	const outputs = new Map();
	for (const name of modules) {
		let code = stripTypeScriptTypes(await readFile(join(directory, `${name}.ts`), "utf8"));
		// Fail packaging if this deliberately closed leaf graph gains another runtime dependency.
		for (const [, dependency] of code.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
			assert.ok(dependency.startsWith("node:") || modules.some((module) => dependency === `./${module}.ts`));
		}
		for (const module of modules) code = code.replaceAll(`./${module}.ts`, `./${module}.mjs`);
		outputs.set(`${name}.mjs`, code);
	}
	return outputs;
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
		assert.equal((await store.clear()).retainedRows, 0);
	} finally {
		await store.close();
		await rm(home, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [action, directory] = process.argv.slice(2);
	assert.ok(
		directory && (action === "build" || action === "check"),
		"Usage: build-usage-worker.mjs build|check src-directory",
	);
	if (action === "build") await buildUsageWorker(resolve(directory));
	else await checkUsageWorker(resolve(directory));
}
