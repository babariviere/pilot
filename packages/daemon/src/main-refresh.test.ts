// biome-ignore-all lint/complexity/useLiteralKeys: Exercise scheduler and admission seams without real repositories.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-main-refresh-"));
	const sessions = new SessionManager(home, new ProjectStore(home), undefined, {
		worker: () => assert.fail("scheduler fixture must not start a worker"),
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
	return { sessions, tick };
}

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
