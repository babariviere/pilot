// biome-ignore-all lint/complexity/useLiteralKeys: Exercise scheduler and admission seams without real repositories.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelCommand } from "@pilot/kernel";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

async function fixture(t: TestContext, working = false) {
	const home = await mkdtemp(join(tmpdir(), "pilot-main-refresh-"));
	const commands: KernelCommand[] = [];
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		title: async () => undefined,
		worker: (_spec, report) => {
			assert.ok(working, "scheduler fixture must not start a worker");
			return {
				ready: Promise.resolve(),
				state: "working",
				busy: true,
				send: (command) => {
					commands.push(command);
					if (command.type === "update.pause") report({ type: "update.paused", id: command.id });
				},
				request: async () => {},
				close: async () => {},
			};
		},
	});
	t.after(async () => {
		await sessions.shutdown();
		await rm(home, { recursive: true, force: true });
	});
	let now = 0;
	// UpdateGate uses a monotonic clock, which Node's timer mocks do not advance.
	t.mock.method(sessions["updateGate"] as unknown as { now(): number }, "now", () => now);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const tick = (ms: number) => {
		now += ms;
		t.mock.timers.tick(ms);
	};
	return { sessions, tick, home, commands };
}

test("a working agent stays paused through refresh callbacks, update retries and shutdown", async (t) => {
	const { sessions, tick, home, commands } = await fixture(t, true);
	await sessions.load();
	const chat = await sessions.spawn({ cwd: home, message: "unfinished work" });
	await Promise.all(sessions["starting"].values());
	const calls: string[] = [];
	let finish!: () => void;
	const fetching = new Promise<void>((resolve) => {
		finish = resolve;
	});
	t.mock.method(sessions, "refreshProjectMain", async (id: string) => {
		calls.push(id);
		await fetching;
	});
	for (const id of ["first", "second", "third"]) sessions.requestMainRefresh(id);
	tick(250);
	assert.deepEqual(calls, ["first", "second"]);
	assert.equal(sessions.pauseForUpdate().ready, false);
	const pendingFetches = [...sessions["mainRefreshes"].values()];
	try {
		// Both the debounce and fetch-finally paths fired in the reported update failure.
		sessions.requestMainRefresh("fourth");
		assert.doesNotThrow(() => tick(250));
		finish();
		await assert.doesNotReject(Promise.all(pendingFetches));
		assert.equal(sessions.pauseForUpdate().ready, false, "the worker's recovery marker is still saving");
		await Promise.all(sessions["saving"].values());
		assert.equal(sessions.pauseForUpdate().ready, true);
		for (let i = 0; i < 40; i++) {
			tick(1_000);
			assert.equal(sessions.pauseForUpdate().ready, true);
		}
		assert.equal(commands.filter((command) => command.type === "update.pause").length, 1);
		assert.equal(
			commands.some((command) => command.type === "update.resume"),
			false,
		);
		assert.deepEqual(calls, ["first", "second"], "renewals never restart deferred fetches");
		assert.deepEqual([...sessions["mainRefreshDue"]], ["third", "fourth"]);
		const meta = JSON.parse(await readFile(join(home, "sessions", chat.id, "meta.json"), "utf8"));
		assert.equal(meta.updatePaused, true);
		await sessions.shutdown();
		tick(60_000);
		assert.deepEqual(calls, ["first", "second"]);
		assert.equal(
			commands.some((command) => command.type === "update.resume"),
			false,
		);
	} finally {
		finish();
		await Promise.allSettled(pendingFetches);
	}
});

test("main-refresh finally defers queued projects while a tool-drain update lease is closed", async (t) => {
	const { sessions, tick } = await fixture(t);
	const releases = new Map<string, () => void>();
	const calls: string[] = [];
	t.mock.method(sessions, "refreshProjectMain", async (id: string) => {
		calls.push(id);
		await new Promise<void>((resolve) => releases.set(id, resolve));
	});
	// Fill both fetch slots and leave a third project waiting for a finally callback.
	for (const id of ["first", "second", "third"]) sessions.requestMainRefresh(id);
	tick(250);
	assert.deepEqual(calls, ["first", "second"]);
	assert.equal(sessions.pauseForUpdate().ready, false, "in-flight fetches still own admissions");
	const finishing = [...sessions["mainRefreshes"].values()];
	for (const release of releases.values()) release();
	// Before the fix these finally promises rejected with ServiceUnavailable, unhandled by the scheduler.
	await assert.doesNotReject(Promise.all(finishing));
	assert.deepEqual(calls, ["first", "second"]);
	assert.deepEqual([...sessions["mainRefreshDue"]], ["third"], "a rejected admission must not drop a project");
	assert.equal(sessions["mainRefreshes"].size, 0);
	assert.equal(sessions.pauseForUpdate().ready, true, "completed fetches release every admission");
	const retryTimer = sessions["mainRefreshTimer"];
	assert.ok(retryTimer);
	for (let i = 0; i < 100; i++) sessions.requestMainRefresh("third");
	assert.equal(sessions["mainRefreshTimer"], retryTimer, "requests share one deferred retry");
	sessions["resumeAfterUpdate"]();
	assert.deepEqual(calls, ["first", "second", "third"], "release retries immediately without a new PR poll");
	assert.equal(sessions["mainRefreshTimer"], undefined);
	releases.get("third")!();
	await Promise.all(sessions["mainRefreshes"].values());
	tick(60_000);
	assert.deepEqual(calls, ["first", "second", "third"], "the old retry timer was cancelled");
	assert.equal(sessions["mainRefreshDue"].size, 0);
	assert.equal(sessions.prepareUpdate().ready, true);
});

test("debounced main refresh survives idle-update lease renewal and retries after natural expiry", async (t) => {
	const { sessions, tick } = await fixture(t);
	const calls: string[] = [];
	t.mock.method(sessions, "refreshProjectMain", async (id: string) => {
		calls.push(id);
	});
	sessions.requestMainRefresh("project");
	assert.equal(sessions.prepareUpdate().ready, true);
	assert.doesNotThrow(() => tick(250), "the debounce callback must not throw into the event loop");
	assert.deepEqual(calls, []);
	assert.deepEqual([...sessions["mainRefreshDue"]], ["project"]);
	tick(29_000);
	assert.equal(sessions.prepareUpdate().ready, true, "renew the lease before the deferred retry");
	tick(1_000);
	assert.deepEqual(calls, [], "retry rechecks a renewed lease");
	tick(30_000);
	assert.deepEqual(calls, ["project"], "expired preparation recovers without another refresh request");
	await Promise.all(sessions["mainRefreshes"].values());
	assert.equal(sessions["mainRefreshTimer"], undefined);
	assert.equal(sessions["mainRefreshDue"].size, 0);
	assert.equal(sessions.prepareUpdate().ready, true);
});

test("shutdown cancels the deferred main-refresh retry without admitting queued work", async (t) => {
	const { sessions, tick } = await fixture(t);
	const refresh = t.mock.method(sessions, "refreshProjectMain", async () => {});
	sessions.requestMainRefresh("project");
	assert.equal(sessions.pauseForUpdate().ready, true);
	tick(250);
	assert.ok(sessions["mainRefreshTimer"]);
	await sessions.shutdown();
	tick(60_000);
	assert.equal(refresh.mock.callCount(), 0);
	assert.equal(sessions["mainRefreshDue"].size, 0);
});
