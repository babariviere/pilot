// biome-ignore-all lint/complexity/useLiteralKeys: Offline lifecycle and durable recovery seams.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Automation } from "@pilot/protocol";
import { deferred, fixture, until } from "./testing/session-workspace.ts";

const hook = (id: string, shell: string): Automation => ({
	id,
	name: id,
	enabled: true,
	on: ["workspace.created", "workspace.restored"],
	action: { type: "shell", run: { shell } },
});

test("setup waits before first input, runs sequentially once, and never tears down on archive", async (t) => {
	const entered = deferred(),
		release = deferred();
	t.after(() => release.resolve());
	const f = await fixture(t, {
		automationsEnabled: () => true,
		workspaceSetup: async (context) => {
			assert.equal(context.trigger, "workspace.created");
			assert.equal(context.projectId, f.project.id);
			entered.resolve();
			await release.promise;
		},
	});
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [hook("first", "printf first > setup.log"), hook("second", "printf second >> setup.log")],
	});
	const chat = await f.sessions.spawn({ projectId: f.project.id, message: "start" });
	await entered.promise;
	assert.equal(f.workers.length, 0, "no kernel or input before setup");
	const retained = await f.stored(chat.id);
	assert.ok(retained.workspace);
	assert.equal(retained.automation?.setup?.state, "pending");
	release.resolve();
	await f.sessions["starting"].get(chat.id);
	assert.equal(await readFile(join(chat.cwd, "setup.log"), "utf8"), "firstsecond");
	assert.equal(f.sessions.get(chat.id)?.workspaceSetup?.state, "ok");
	assert.deepEqual(
		f.sessions.get(chat.id)?.automationRuns?.map((run) => run.state),
		["ok", "ok"],
	);
	await f.sessions.stop(chat.id);
	await f.sessions.archive(chat.id);
	await f.sessions.restore(chat.id);
	assert.equal(f.sessions.get(chat.id)?.automationRuns?.length, 2, "intact restore does not run setup");
	await f.sessions.send(chat.id, "again");
	assert.equal(await readFile(join(chat.cwd, "setup.log"), "utf8"), "firstsecond");
});

test("setup failure is retained and reported without failing or withholding the user's turn", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [hook("install", "printf 'API_KEY=secret'; exit 7"), hook("never", "touch should-not-exist")],
	});
	const chat = await f.spawn();
	assert.equal(f.sessions.get(chat.id)?.workspaceSetup?.state, "failed");
	assert.match(f.sessions.get(chat.id)?.workspaceSetup?.detail ?? "", /install.*exit 7/);
	assert.equal(existsSync(join(chat.cwd, "should-not-exist")), false);
	const runs = f.sessions.get(chat.id)?.automationRuns;
	assert.deepEqual(
		runs?.map((run) => run.state),
		["failed", "skipped"],
	);
	assert.doesNotMatch(runs![0]!.excerpt, /secret/);
	assert.equal(f.specs[0]?.pilot?.workspaceSetup?.state, "failed");
	const activity = f.workers.flatMap((w) => w.requests).find((r) => r.type === "activity");
	assert.ok(activity && activity.type === "activity" && activity.text.includes("Setup failed"));
	assert.equal(activity.event?.kind, "automation_failed");
	assert.match(activity.event?.text ?? "", /^Setup failed/);
	assert.equal(f.workers.flatMap((w) => w.requests).filter((r) => r.type === "input").length, 1);
});

test("snapshot restore runs setup again, without starting a model or touching the source checkout", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [hook("deps", "mkdir -p node_modules; printf ready > node_modules/ready")],
	});
	const chat = await f.spawn();
	await f.sessions.archive(chat.id);
	await f.sessions.reclaimWorkspace(chat.id);
	const before = f.workers.length;
	await f.sessions.restore(chat.id);
	await f.sessions["workspaceSetups"].get(chat.id)?.done;
	assert.equal(await readFile(join(chat.cwd, "node_modules/ready"), "utf8"), "ready");
	assert.equal(f.workers.length, before, "restore setup runs in the daemon, not a model");
	assert.deepEqual(
		f.sessions.get(chat.id)?.automationRuns?.map((run) => run.trigger),
		["workspace.created", "workspace.restored"],
	);
	await f.assertSourceUnchanged();
});

test("disabled and direct workspaces never enqueue setup or catch up after enabling", async (t) => {
	let enabled = false;
	let calls = 0;
	const f = await fixture(t, {
		automationsEnabled: () => enabled,
		workspaceSetup: async () => {
			calls++;
		},
	});
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [hook("setup", "touch should-not-exist")],
	});
	const chat = await f.spawn();
	enabled = true;
	await f.sessions.send(chat.id, "continue");
	assert.equal(existsSync(join(chat.cwd, "should-not-exist")), false);
	await f.spawn("direct");
	assert.equal(calls, 0);
});

test("a short first-turn hold releases input while setup continues", async (t) => {
	const release = deferred();
	t.after(() => release.resolve());
	const f = await fixture(t, {
		automationsEnabled: () => true,
		workspaceSetupHoldMs: 1,
		workspaceSetup: async () => release.promise,
	});
	const chat = await f.sessions.spawn({ projectId: f.project.id, message: "start" });
	await f.sessions["starting"].get(chat.id);
	assert.equal(f.specs[0]?.pilot?.workspaceSetup?.state, "pending");
	assert.equal(f.sessions.get(chat.id)?.working, true);
	release.resolve();
	await f.sessions["workspaceSetups"].get(chat.id)?.done;
	assert.equal(f.sessions.get(chat.id)?.workspaceSetup?.state, "ok");
});

test("Stop cancels the setup hold, prevents later steps, and does not replay on the next input", async (t) => {
	const entered = deferred();
	const f = await fixture(t, {
		automationsEnabled: () => true,
		workspaceSetup: async ({ signal }) => {
			entered.resolve();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		},
	});
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [hook("never", "touch should-not-exist")],
	});
	const chat = await f.sessions.spawn({ projectId: f.project.id, message: "start" });
	await entered.promise;
	await f.sessions.stop(chat.id);
	assert.equal(f.sessions.get(chat.id)?.workspaceSetup?.state, "cancelled");
	assert.equal(existsSync(join(chat.cwd, "should-not-exist")), false);
	await f.sessions.send(chat.id, "continue");
	assert.equal(existsSync(join(chat.cwd, "should-not-exist")), false);
});

test("a durable pending trigger recovers once, but completed commands never repeat", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [hook("once", "printf x >> count.log")],
	});
	const chat = await f.spawn();
	await f.sessions.shutdown();
	const stored = await f.stored(chat.id);
	stored.automation!.setup!.state = "pending";
	stored.automation!.setup!.hooks = f.projects.require(f.project.id).automations!.items;
	await writeFile(join(f.home, "sessions", chat.id, "meta.json"), JSON.stringify(stored));
	const restarted = await f.manager();
	await restarted["workspaceSetups"].get(chat.id)?.done;
	assert.equal(await readFile(join(chat.cwd, "count.log"), "utf8"), "x");
	assert.equal(restarted.get(chat.id)?.automationRuns?.[0]?.attempt, 1);
	assert.equal(restarted.get(chat.id)?.workspaceSetup?.state, "ok");
});

test("completed-step cursor survives the bounded result tail", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: Array.from({ length: 21 }, (_, index) => hook(`step-${index}`, "printf x >> count.log")),
	});
	const chat = await f.spawn();
	assert.equal((await readFile(join(chat.cwd, "count.log"), "utf8")).length, 21);
	await f.sessions.shutdown();
	const stored = await f.stored(chat.id);
	assert.equal(stored.automation!.runs.length, 20);
	stored.automation!.setup!.state = "pending";
	stored.automation!.setup!.hooks = f.projects.require(f.project.id).automations!.items;
	await writeFile(join(f.home, "sessions", chat.id, "meta.json"), JSON.stringify(stored));
	const restarted = await f.manager();
	await restarted["workspaceSetups"].get(chat.id)?.done;
	assert.equal((await readFile(join(chat.cwd, "count.log"), "utf8")).length, 21);
});

test("interrupted setup retries once and stops after a second interruption", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [hook("retry", "printf x >> count.log")],
	});
	const chat = await f.spawn();
	await f.sessions.shutdown();
	const stored = await f.stored(chat.id);
	stored.automation!.setup!.state = "pending";
	stored.automation!.setup!.hooks = f.projects.require(f.project.id).automations!.items;
	stored.automation!.setup!.finished = {};
	stored.automation!.runs[0]!.state = "interrupted";
	await writeFile(join(f.home, "sessions", chat.id, "meta.json"), JSON.stringify(stored));
	const restarted = await f.manager();
	await restarted["workspaceSetups"].get(chat.id)?.done;
	assert.equal(await readFile(join(chat.cwd, "count.log"), "utf8"), "xx");
	assert.equal(restarted.get(chat.id)?.automationRuns?.[0]?.attempt, 2);
	await restarted.shutdown();
	const twice = await f.stored(chat.id);
	twice.automation!.setup!.state = "pending";
	twice.automation!.setup!.hooks = f.projects.require(f.project.id).automations!.items;
	twice.automation!.setup!.finished = {};
	twice.automation!.runs[0]!.state = "interrupted";
	await writeFile(join(f.home, "sessions", chat.id, "meta.json"), JSON.stringify(twice));
	const final = await f.manager();
	await final["workspaceSetups"].get(chat.id)?.done;
	assert.equal(await readFile(join(chat.cwd, "count.log"), "utf8"), "xx");
	assert.equal(final.get(chat.id)?.workspaceSetup?.state, "failed");
	assert.match(final.get(chat.id)?.automationRuns?.[0]?.reason ?? "", /interrupted twice/);
});

test("turning off during setup finishes admitted work but skips later commands", async (t) => {
	const entered = deferred(),
		release = deferred();
	t.after(() => release.resolve());
	let enabled = true;
	const f = await fixture(t, {
		automationsEnabled: () => enabled,
		workspaceSetup: async () => {
			entered.resolve();
			await release.promise;
		},
	});
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [hook("later", "touch should-not-exist")],
	});
	const chat = await f.sessions.spawn({ projectId: f.project.id, message: "start" });
	await entered.promise;
	enabled = false;
	release.resolve();
	await f.sessions["starting"].get(chat.id);
	assert.equal(existsSync(join(chat.cwd, "should-not-exist")), false);
	assert.equal(f.sessions.get(chat.id)?.automationRuns?.[0]?.state, "skipped");
	assert.equal(f.sessions.get(chat.id)?.workspaceSetup?.state, "failed");
});

test("read-only and coordinator contexts cannot queue workspace setup", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	const chat = await f.spawn();
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [hook("setup", "true")] });
	const original = f.sessions["metas"].get(chat.id)!;
	for (const extra of [
		{ mode: "ask" as const },
		{ control: true },
		{ continuedTo: "next" },
		{ continuationOf: "previous" },
		{ workspaceOriginId: "parent" },
	]) {
		const meta = { ...original, ...extra };
		f.sessions["queueWorkspaceSetup"](meta, "workspace.created", "workspace.created");
		assert.equal(meta.automation?.setup, undefined);
	}
	t.mock.method(
		f.sessions as unknown as { isMissionCoordinator(id: string): boolean },
		"isMissionCoordinator",
		() => true,
	);
	f.sessions["queueWorkspaceSetup"](original, "workspace.created", "workspace.created");
	assert.equal(original.automation?.setup, undefined);
});

test("restoring pruned generated files uses the restore trigger too", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [hook("deps", "mkdir -p node_modules; touch node_modules/ready")],
	});
	const chat = await f.spawn();
	await f.sessions.archive(chat.id);
	await f.sessions["pruneWorkspace"](chat.id);
	assert.equal(existsSync(join(chat.cwd, "node_modules/ready")), false);
	await f.sessions.restore(chat.id);
	await f.sessions["workspaceSetups"].get(chat.id)?.done;
	assert.equal(existsSync(join(chat.cwd, "node_modules/ready")), true);
	assert.equal(f.sessions.get(chat.id)?.automationRuns?.at(-1)?.trigger, "workspace.restored");
});

test("a runtime lease defers setup without releasing its first input", async (t) => {
	const entered = deferred();
	const f = await fixture(t, { automationsEnabled: () => true });
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [hook("setup", "touch ready")] });
	const save = f.sessions["save"].bind(f.sessions);
	let thaw: (() => void) | undefined;
	t.after(() => thaw?.());
	t.mock.method(f.sessions as unknown as { save: typeof save }, "save", async (...args: Parameters<typeof save>) => {
		await save(...args);
		if (!thaw && args[0].workspace && args[0].automation?.setup?.state === "pending") {
			thaw = f.sessions.freezeAdmissions();
			entered.resolve();
		}
	});
	const chat = await f.sessions.spawn({ projectId: f.project.id, message: "start" });
	await entered.promise;
	await until(() => f.sessions["workspaceSetupWaiters"].has(chat.id));
	assert.equal(f.workers.length, 0);
	assert.equal(existsSync(join(chat.cwd, "ready")), false);
	thaw!();
	await f.sessions.resumeMaintenance();
	await f.sessions["starting"].get(chat.id);
	assert.equal(existsSync(join(chat.cwd, "ready")), true);
	assert.equal(f.sessions.get(chat.id)?.workspaceSetup?.state, "ok");
});

test("sleep preserves the pending setup boundary and wake resumes it before input", async (t) => {
	const entered = deferred();
	let calls = 0;
	const f = await fixture(t, {
		automationsEnabled: () => true,
		workspaceSetup: async ({ signal }) => {
			calls++;
			if (calls > 1) return;
			entered.resolve();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		},
	});
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [hook("setup", "touch ready")] });
	const chat = await f.sessions.spawn({ projectId: f.project.id, message: "start" });
	await entered.promise;
	await f.sessions.pauseForSleep();
	assert.equal(f.workers.length, 0);
	assert.equal((await f.stored(chat.id)).automation?.setup?.state, "pending");
	await f.sessions.resumeAfterSleep();
	await f.sessions["starting"].get(chat.id);
	assert.equal(calls, 2);
	assert.equal(existsSync(join(chat.cwd, "ready")), true);
	assert.equal(f.sessions.get(chat.id)?.workspaceSetup?.state, "ok");
});
