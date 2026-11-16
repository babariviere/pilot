import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("packaged funding worker uses only generated JavaScript and verifies its exact source before smoke checks", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "funding-package-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const name of ["funding", "funding-worker", "funding-disk", "funding-errors"])
		await copyFile(fileURLToPath(new URL(`./${name}.ts`, import.meta.url)), join(directory, `${name}.ts`));
	const { buildFundingWorker, checkFundingWorker } = await import(
		new URL("../scripts/build-usage-worker.mjs", import.meta.url).href
	);
	await buildFundingWorker(directory);
	assert.match(await readFile(join(directory, "funding.ts"), "utf8"), /funding-worker\.mjs/);
	assert.doesNotMatch(await readFile(join(directory, "funding-worker.mjs"), "utf8"), /\.ts["']/);
	await checkFundingWorker(directory);
	await writeFile(
		join(directory, "funding-disk.ts"),
		`${await readFile(join(directory, "funding-disk.ts"), "utf8")}\n// changed after build\n`,
	);
	await assert.rejects(checkFundingWorker(directory), /Stale generated funding/);
});
