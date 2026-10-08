import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readModelSettings } from "./model-settings.ts";

const lockfile = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("proper-lockfile") as {
	lock(path: string, options: { realpath: false }): Promise<() => Promise<void>>;
};

test("async settings keep SDK merge, migrations, BOM handling and per-scope malformed-file fallback", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-model-settings-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agent = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agent);
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(
		join(agent, "settings.json"),
		`\uFEFF${JSON.stringify({ defaultProvider: "test", defaultModel: "global", enabledModels: ["test/global"], queueMode: "all", websockets: true })}`,
	);
	await writeFile(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ defaultModel: "project", enabledModels: ["test/project:high"] }),
	);
	const expected = SettingsManager.create(cwd, agent);
	const loaded = await readModelSettings(cwd, agent);
	assert.deepEqual(loaded.getSettings(), expected.getSettings());
	assert.deepEqual(loaded.getGlobalSettings(), expected.getGlobalSettings());
	assert.deepEqual(loaded.getProjectSettings(), expected.getProjectSettings());
	await writeFile(join(cwd, ".pi", "settings.json"), "malformed");
	const malformed = await readModelSettings(cwd, agent);
	assert.deepEqual(malformed.getSettings(), SettingsManager.create(cwd, agent).getSettings());
	assert.equal(malformed.drainErrors()[0]?.scope, "project");
	assert.deepEqual((await readModelSettings(join(root, "missing"), join(root, "missing-agent"))).getSettings(), {});
});

test("SDK settings lock contention waits without blocking timers, then reads the locked file after release", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-model-settings-lock-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	await writeFile(path, JSON.stringify({ enabledModels: ["test/scoped"] }));
	const release = await lockfile.lock(path, { realpath: false });
	try {
		const pending = readModelSettings(root, root);
		assert.equal(await Promise.race([pending.then(() => "settings"), delay(0).then(() => "timer")]), "timer");
		await release();
		assert.deepEqual((await pending).getEnabledModels(), ["test/scoped"]);
	} finally {
		await release().catch(() => undefined);
	}
});

test("aborted lock waits cancel promptly and never replace scoped settings with defaults", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-model-settings-abort-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	await writeFile(path, JSON.stringify({ enabledModels: ["test/scoped"] }));
	const release = await lockfile.lock(path, { realpath: false });
	try {
		const controller = new AbortController();
		const pending = readModelSettings(root, root, controller.signal);
		await delay(0);
		controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
	} finally {
		await release();
	}
});
