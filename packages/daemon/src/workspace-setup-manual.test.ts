// biome-ignore-all lint/complexity/useLiteralKeys: Offline lifecycle and persistence seams.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { Automation } from "@pilot/protocol";
import { ChatSettingsService } from "./chat-settings.ts";
import { GitHubSetupService } from "./github-setup.ts";
import { ModelCatalog } from "./models.ts";
import { createDaemonServer } from "./server.ts";
import { TerminalManager } from "./terminals.ts";
import { deferred, fixture, until } from "./testing/session-workspace.ts";

const hook = (id: string, on: Automation["on"] = ["workspace.created"]): Automation => ({
	id,
	name: id,
	enabled: true,
	on,
	action: { type: "shell", run: { shell: `printf '${id},' >> setup.log` } },
});

test("manual setup runs current create/restore hooks once in order without new model input", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	const chat = await f.spawn();
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [
			hook("create"),
			hook("restore", ["workspace.restored"]),
			hook("both", ["workspace.created", "workspace.restored"]),
			{ ...hook("disabled"), enabled: false },
			hook("check", ["run.finished"]),
		],
	});
	const workers = f.workers.length;
	const inputs = () => f.workers.flatMap((w) => w.requests).filter((r) => r.type === "input").length;
	const before = inputs();
	for (let attempt = 0; attempt < 2; attempt++) {
		const accepted = await f.sessions.rerunWorkspaceSetup(chat.id);
		assert.equal(accepted.workspaceSetup?.state, "pending");
		await f.sessions["workspaceSetups"].get(chat.id)?.done;
		await f.sessions["starting"].get(chat.id); // Drain the passive result activity on the existing worker.
		assert.equal(f.sessions.get(chat.id)?.workspaceSetup?.state, "ok");
	}
	assert.equal(await readFile(join(chat.cwd, "setup.log"), "utf8"), "create,restore,both,create,restore,both,");
	const runs = f.sessions.get(chat.id)!.automationRuns!;
	assert.equal(runs.length, 6);
	assert.ok(runs.every((run) => run.trigger === "manual" && run.definitionRevision === 1));
	assert.notEqual(runs[0]!.id, runs[3]!.id, "each explicit request has a fresh boundary");
	assert.equal(f.workers.length, workers);
	assert.equal(inputs(), before);
	await f.assertSourceUnchanged();
});

test("manual setup refuses disabled, ineligible and busy chats without changing setup", async (t) => {
	let enabled = true;
	const f = await fixture(t, { automationsEnabled: () => enabled });
	const chat = await f.spawn();
	await assert.rejects(f.sessions.rerunWorkspaceSetup(chat.id), /No enabled workspace setup hooks/);
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [hook("setup")] });
	enabled = false;
	await assert.rejects(f.sessions.rerunWorkspaceSetup(chat.id), /disabled/);
	enabled = true;
	const original = f.sessions["metas"].get(chat.id)!;
	for (const extra of [
		{ mode: "ask" as const },
		{ archivedAt: Date.now() },
		{ control: true },
		{ continuationOf: "previous" },
		{ continuedTo: "next" },
		{ continuationPending: { targetId: "next" } },
		{ workspaceOriginId: "parent" },
		{ workspace: undefined },
		{ working: true },
		{ initializing: true },
		{ kernelRestartPending: true },
		{ sleepPaused: true },
		{ updatePaused: true },
		{ workspaceRecovery: {} },
		{ pending: [{ type: "input", requestId: "queued", content: "queued" }] },
		{ subagents: [{ id: "child", state: "working" }] },
		{ automation: { runs: [], setup: { state: "pending" } } },
	]) {
		f.sessions["metas"].set(chat.id, { ...original, ...extra } as typeof original);
		await assert.rejects(f.sessions.rerunWorkspaceSetup(chat.id), JSON.stringify(extra));
	}
	f.sessions["metas"].set(chat.id, original);
	const thaw = f.sessions.freezeAdmissions();
	await assert.rejects(f.sessions.rerunWorkspaceSetup(chat.id), /update/);
	thaw();
	t.mock.method(
		f.sessions as unknown as { isMissionCoordinator(id: string): boolean },
		"isMissionCoordinator",
		() => true,
	);
	await assert.rejects(f.sessions.rerunWorkspaceSetup(chat.id));
	assert.equal(original.automation?.setup, undefined);
});

test("manual setup reserves before persistence, rejects overlap, and holds concurrent input", async (t) => {
	let enabled = false;
	let participants = 0;
	const entered = deferred(),
		release = deferred(),
		saveEntered = deferred(),
		saveRelease = deferred();
	t.after(() => {
		release.resolve();
		saveRelease.resolve();
	});
	const f = await fixture(t, {
		automationsEnabled: () => enabled,
		workspaceSetup: async () => {
			participants++;
			entered.resolve();
			await release.promise;
		},
	});
	const chat = await f.spawn();
	enabled = true;
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [hook("setup")] });
	const save = f.sessions["save"].bind(f.sessions);
	let first = true;
	t.mock.method(f.sessions as unknown as { save: typeof save }, "save", async (...args: Parameters<typeof save>) => {
		if (first && args[0].automation?.setup?.trigger === "manual") {
			first = false;
			saveEntered.resolve();
			await saveRelease.promise;
		}
		await save(...args);
	});
	const rerun = f.sessions.rerunWorkspaceSetup(chat.id);
	await saveEntered.promise;
	await assert.rejects(f.sessions.rerunWorkspaceSetup(chat.id), /idle/);
	assert.equal(participants, 0, "no setup effects before the admission write");
	assert.equal((await f.stored(chat.id)).automation?.setup, undefined);
	const inputs = () => f.workers.flatMap((w) => w.requests).filter((r) => r.type === "input").length;
	const before = inputs();
	const send = f.sessions.send(chat.id, "after setup");
	saveRelease.resolve();
	await rerun;
	await entered.promise;
	assert.equal((await f.stored(chat.id)).automation?.setup?.trigger, "manual");
	assert.equal(inputs(), before);
	release.resolve();
	await send;
	assert.equal(inputs(), before + 1);
});

test("manual setup cannot execute after a failed admission write", async (t) => {
	let enabled = false;
	let participants = 0;
	const f = await fixture(t, {
		automationsEnabled: () => enabled,
		workspaceSetup: async () => {
			participants++;
		},
	});
	const chat = await f.spawn();
	enabled = true;
	const save = f.sessions["save"].bind(f.sessions);
	let first = true;
	t.mock.method(f.sessions as unknown as { save: typeof save }, "save", async (...args: Parameters<typeof save>) => {
		if (first && args[0].automation?.setup?.trigger === "manual") {
			first = false;
			throw new Error("fixture write failure");
		}
		await save(...args);
	});
	await assert.rejects(f.sessions.rerunWorkspaceSetup(chat.id), /write failure/);
	await f.sessions["workspaceSetups"].get(chat.id)?.done;
	assert.equal(participants, 0);
	assert.equal(f.sessions.get(chat.id)?.workspaceSetup?.state, "failed");
});

test("manual setup exposes runner progress and Stop cancels remaining steps", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	const chat = await f.spawn();
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [
			{ ...hook("long"), action: { type: "shell", run: { shell: "printf started; sleep 60" } } },
			hook("never"),
		],
	});
	await f.sessions.rerunWorkspaceSetup(chat.id);
	await until(() => f.sessions.get(chat.id)?.automation?.state === "running");
	assert.equal(f.sessions.get(chat.id)?.automation?.name, "long");
	assert.equal(f.sessions.get(chat.id)?.automation?.trigger, "manual");
	await assert.rejects(f.sessions.rerunWorkspaceSetup(chat.id), /idle/);
	await f.sessions.stop(chat.id);
	assert.equal(f.sessions.get(chat.id)?.workspaceSetup?.state, "cancelled");
	assert.equal(f.sessions.get(chat.id)?.automation, undefined);
	assert.deepEqual(
		f.sessions.get(chat.id)?.automationRuns?.map((run) => run.state),
		["cancelled"],
	);
});

test("manual setup retains failure and recovery never repeats a finished step", async (t) => {
	const f = await fixture(t, { automationsEnabled: () => true });
	const chat = await f.spawn();
	await f.projects.updateAutomations(f.project.id, {
		expectedRevision: 0,
		items: [hook("once"), { ...hook("fail"), action: { type: "shell", run: { shell: "exit 7" } } }, hook("skip")],
	});
	await f.sessions.rerunWorkspaceSetup(chat.id);
	await f.sessions["workspaceSetups"].get(chat.id)?.done;
	assert.equal(f.sessions.get(chat.id)?.workspaceSetup?.state, "failed");
	assert.deepEqual(
		f.sessions.get(chat.id)?.automationRuns?.map((run) => run.state),
		["ok", "failed", "skipped"],
	);
	await f.sessions.shutdown();
	const stored = await f.stored(chat.id);
	stored.automation!.setup!.state = "pending";
	stored.automation!.setup!.hooks = f.projects.require(f.project.id).automations!.items;
	await writeFile(join(f.home, "sessions", chat.id, "meta.json"), JSON.stringify(stored));
	const restarted = await f.manager();
	await restarted["workspaceSetups"].get(chat.id)?.done;
	assert.equal(await readFile(join(chat.cwd, "setup.log"), "utf8"), "once,");
	assert.equal(restarted.get(chat.id)?.workspaceSetup?.state, "failed");
});

test("manual setup HTTP action requires the live setting and native authority", async (t) => {
	let settings: ChatSettingsService | undefined;
	const f = await fixture(t, { automationsEnabled: () => settings?.automationsEnabled() ?? false });
	settings = await ChatSettingsService.open(f.home);
	const chat = await f.spawn();
	await f.projects.updateAutomations(f.project.id, { expectedRevision: 0, items: [hook("setup")] });
	const native = new GitHubSetupService(
		f.home,
		{ hostId: "fixture", daemonId: "fixture", lineageId: "fixture" },
		{ userHome: f.home, env: {} },
	);
	await native.status();
	const token = JSON.parse(await readFile(join(f.home, "github-app-capability"), "utf8")).token as string;
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		new ModelCatalog(f.home),
		terminals,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		undefined,
		native,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		settings,
	);
	t.after(async () => {
		await terminals.shutdown();
		await native.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const post = (capability?: string, id = chat.id) =>
		fetch(`${base}/api/sessions/${id}/setup`, {
			method: "POST",
			headers: capability ? { "x-pilot-github-capability": capability } : {},
		});
	assert.equal((await post(token)).status, 404);
	await settings.update({ automations: true, expectedRevision: settings.settings().revision });
	assert.equal((await post()).status, 403);
	assert.equal((await post("wrong")).status, 403);
	assert.equal((await post(token, "missing")).status, 404);
	const meta = f.sessions["metas"].get(chat.id)!;
	meta.working = true;
	assert.equal((await post(token)).status, 409);
	meta.working = false;
	const response = await post(token);
	assert.equal(response.status, 202);
	assert.equal((await response.json()).workspaceSetup.state, "pending");
	await f.sessions["workspaceSetups"].get(chat.id)?.done;
	assert.equal(await readFile(join(chat.cwd, "setup.log"), "utf8"), "setup,");
});
