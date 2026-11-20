/** Offline baseline/current comparison. node scripts/bench/startup-preparation.ts <baseline SHA> [pairs] */
import { SessionManager } from "../../packages/daemon/src/sessions.ts";
import { startupResponsiveness } from "../../packages/daemon/src/testing/startup-responsiveness.ts";
import { loadBaseline } from "./baseline.ts";

const baseline = process.argv[2];
const pairs = Number(process.argv[3] ?? 3);
if (!baseline || !Number.isSafeInteger(pairs) || pairs < 1 || pairs > 10)
	throw new Error("Pass a baseline SHA and 1-10 sample pairs");
const loaded = await loadBaseline<{ SessionManager: typeof SessionManager }>(
	baseline,
	new URL("../../packages/daemon/src/sessions.ts", import.meta.url),
);
try {
	const { SessionManager: Baseline } = loaded.module;
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
	await loaded.cleanup();
}
