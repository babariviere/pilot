import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentError, EnvironmentPlan } from "@pilot/protocol";
import { ENVIRONMENT_STATE_LIMITS, EnvironmentStateStore } from "./environment-state.ts";

const plan: EnvironmentPlan = {
	host: { daemonId: "d", platform: "darwin", arch: "arm64" },
	projectId: "p1",
	profileRevision: 1,
	overrideRevision: 0,
	planHash: "h",
	computedAt: 1,
	items: [
		{
			subject: "golangci-lint",
			required: "1.61.0",
			action: "install",
			installer: "mise",
			commands: [["mise", "install", "golangci-lint@1.61.0"]],
			approval: "plan",
			impact: { network: ["github.com"] },
		},
	],
};

function error(output: string, at = 1): EnvironmentError {
	return {
		step: "Start Postgres 16",
		host: { ref: { daemonId: "d", platform: "linux", arch: "x64" }, name: "devbox-1" },
		command: "pg_ctl start",
		outcome: "exit 1",
		output,
		fix: "Free disk space, then retry.",
		at,
	};
}

test("environment state persists privately, bounds errors and forgets removed projects", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-environment-state-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new EnvironmentStateStore(home);
	await store.load();
	await store.update("p1", { plan }, 10);
	const errors = Array.from({ length: 20 }, (_, index) => error(index === 19 ? "x".repeat(10_000) : "boom", index));
	const saved = await store.update("p2", { errors }, 11);
	assert.equal(saved.errors!.length, ENVIRONMENT_STATE_LIMITS.errors);
	assert.equal(saved.errors!.at(-1)!.at, 19, "newest errors are kept");
	assert.equal(Buffer.byteLength(saved.errors!.at(-1)!.output), ENVIRONMENT_STATE_LIMITS.errorOutputBytes);
	await store.flush();
	const file = join(home, "environment", "state.json");
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.equal((await stat(join(home, "environment"))).mode & 0o777, 0o700);

	const reloaded = new EnvironmentStateStore(home);
	await reloaded.load();
	assert.deepEqual(reloaded.get("p1"), { plan, updatedAt: 10 });
	await reloaded.retain(["p1"]);
	assert.equal(reloaded.get("p2"), undefined);
	await reloaded.flush();
	assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8")).projects), ["p1"]);
	await assert.rejects(
		reloaded.update("p1", { plan: { ...plan, items: [{ ...plan.items[0]!, note: "x".repeat(300_000) }] } }),
		/too large/,
	);
	assert.deepEqual(reloaded.get("p1"), { plan, updatedAt: 10 }, "an oversized update changes nothing");
});

test("a damaged state file is moved aside, never trusted", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-environment-state-damaged-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new EnvironmentStateStore(home);
	await store.load();
	await writeFile(join(home, "environment", "state.json"), "{not json");
	const reloaded = new EnvironmentStateStore(home);
	await reloaded.load();
	assert.equal(reloaded.get("p1"), undefined);
	const files = await readdir(join(home, "environment"));
	assert.ok(files.some((name) => name.startsWith("state.json.damaged-")));
	assert.ok(!files.includes("state.json"));
});
