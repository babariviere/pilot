/** Offline baseline/current comparison. node scripts/bench/startup-preparation.ts <baseline SHA> [pairs] */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "../../packages/daemon/src/sessions.ts";
import { startupResponsiveness } from "../../packages/daemon/src/testing/startup-responsiveness.ts";

const baseline = process.argv[2];
const pairs = Number(process.argv[3] ?? 3);
if (!baseline || !/^[a-f\d]{6,40}$/.test(baseline) || !Number.isSafeInteger(pairs) || pairs < 1 || pairs > 10)
	throw new Error("Pass a baseline SHA and 1-10 sample pairs");
const root = fileURLToPath(new URL("../../", import.meta.url));
// Under the ignored dependency directory so the snapshot resolves identical installed packages.
const directory = await mkdtemp(join(root, "packages/daemon/node_modules/.startup-probe-"));
try {
	const source = execFileSync("git", ["show", `${baseline}:packages/daemon/src/sessions.ts`], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	}).replaceAll('from "./', `from "${join(root, "packages/daemon/src")}/`);
	const file = join(directory, "baseline.mjs");
	await writeFile(file, stripTypeScriptTypes(source));
	const { SessionManager: Baseline } = (await import(pathToFileURL(file).href)) as {
		SessionManager: typeof SessionManager;
	};
	for (let round = 0; round <= pairs; round++) {
		const variants = [
			{ variant: "baseline", Manager: Baseline },
			{ variant: "current", Manager: SessionManager },
		];
		if (round % 2) variants.reverse();
		for (const { variant, Manager } of variants) {
			const metrics = await startupResponsiveness(150, 256_000, Manager);
			console.log(JSON.stringify({ variant, round, warmup: round === 0, ...metrics }));
		}
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
