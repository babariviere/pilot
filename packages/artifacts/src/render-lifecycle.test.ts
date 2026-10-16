import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildLibrary, prepareArtifact } from "./render.ts";

function children(): Promise<Set<number>> {
	return new Promise((resolve, reject) => {
		execFile("pgrep", ["-P", String(process.pid)], { timeout: 5_000 }, (error, stdout) => {
			if (error && (error as { code?: unknown }).code !== 1) return reject(error);
			resolve(new Set(stdout.trim().split(/\s+/).filter(Boolean).map(Number)));
		});
	});
}

async function released(baseline: Set<number>) {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const remaining = [...(await children())].filter((pid) => !baseline.has(pid));
		if (!remaining.length) return;
		assert.ok(Date.now() < deadline, `Artifact build left child processes: ${remaining.join(", ")}`);
		await delay(10);
	}
}

test("artifact builds release their helper after concurrent success, failure and reuse without touching other children", async (t) => {
	const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(unrelated, "spawn");
	t.after(async () => {
		if (unrelated.exitCode !== null || unrelated.signalCode !== null) return;
		const exited = once(unrelated, "exit");
		unrelated.kill();
		await exited;
	});
	const baseline = await children();
	assert.ok(baseline.has(unrelated.pid!));
	const source = "export default function Artifact(){return <p>lifecycle-ok</p>}";
	const results = await Promise.allSettled([
		prepareArtifact({ title: "React", kind: "react", source }),
		buildLibrary("react"),
		prepareArtifact({ title: "Invalid", kind: "react", source: "import x from 'node:fs'; export default x" }),
	]);
	assert.equal(results[0]!.status, "fulfilled");
	assert.equal(results[1]!.status, "fulfilled");
	assert.equal(results[2]!.status, "rejected");
	await released(baseline);
	assert.equal(unrelated.exitCode, null);
	assert.equal(unrelated.signalCode, null);
	assert.match((await prepareArtifact({ title: "Again", kind: "react", source })).html, /artifact-root/);
	await released(baseline);
	await assert.rejects(
		prepareArtifact({ title: "Invalid again", kind: "react", source: "export const x = 1" }),
		/default/,
	);
	await released(baseline);
});
