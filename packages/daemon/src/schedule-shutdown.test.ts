import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { shutdownSchedules } from "./schedule-shutdown.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { ScheduleService } from "./schedules.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function rejection(promise: Promise<void>): Promise<{ error: unknown }> {
	return promise.then(
		() => assert.fail("Shutdown must not report success"),
		(error: unknown) => ({ error }),
	);
}

function resources(store: { close(): Promise<void> }, events: string[] = []) {
	return {
		schedules: { stop: async () => void events.push("schedules") },
		connectivity: { stop: async () => void events.push("connectivity") },
		systemEvents: { stop: () => void events.push("systemEvents") },
		store,
	};
}

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-schedule-shutdown-"));
	const file = join(home, "schedules.sqlite");
	const store = new ScheduleStore(file);
	// Test-only access to the real owned worker, not a production injection API.
	const worker = (store as unknown as { worker: Worker }).worker;
	t.after(async () => {
		await store.close().catch(() => {});
		await worker.terminate();
		await rm(home, { recursive: true, force: true });
	});
	await store.load();
	return { home, file, store, worker };
}

/** Keep the healthy real worker, but make its close RPC receive an actual error reply. */
function failCloseRpc(t: TestContext, worker: Worker) {
	const post = worker.postMessage.bind(worker);
	let closes = 0;
	t.mock.method(worker, "postMessage", (message: { method: string }) => {
		if (message.method === "close") {
			closes++;
			assert.notEqual(worker.threadId, -1, "the injected close starts on a healthy live worker");
			post({ ...message, method: "injected-invalid-close" });
		} else post(message);
	});
	return () => closes;
}

test("healthy-worker close RPC failure awaits termination and held independent drain before rejecting", async (t) => {
	const { store, worker } = await fixture(t);
	const closes = failCloseRpc(t, worker);
	const enteredTail = gate();
	const releaseTail = gate();
	let exited = false;
	let settled = false;
	worker.once("exit", () => {
		exited = true;
	});
	const result = rejection(
		shutdownSchedules(resources(store), async () => {
			assert.equal(closes(), 1, "close really sent its RPC");
			assert.equal(exited, true, "worker exit precedes independent teardown");
			assert.equal(worker.threadId, -1);
			enteredTail.resolve();
			await releaseTail.promise;
		}),
	).then((outcome) => {
		settled = true;
		return outcome;
	});
	try {
		assert.equal(
			await Promise.race([enteredTail.promise.then(() => "tail"), result.then(() => "settled")]),
			"tail",
			"a terminal store error must not omit independent cleanup",
		);
		await setImmediate();
		assert.equal(settled, false, "the close error must wait for the independent tail");
	} finally {
		releaseTail.resolve();
	}
	const { error } = await result;
	assert.ok(error instanceof Error);
	assert.equal(error.message, "Unknown schedule operation");
	await assert.rejects(store.load(), /Schedule worker exited|Schedule store closed/);
});

test("actual runtime worker exit is distinct from a healthy-worker close RPC failure", async (t) => {
	const { store, worker } = await fixture(t);
	await worker.terminate();
	let drained = false;
	const { error } = await rejection(
		shutdownSchedules(resources(store), async () => {
			assert.equal(worker.threadId, -1);
			drained = true;
		}),
	);
	assert.equal(drained, true);
	assert.ok(error instanceof Error);
	assert.match(error.message, /Schedule worker exited/);
});

test("terminal store failure still drains an independent actual child through confirmed exit", async (t) => {
	const { home, store, worker } = await fixture(t);
	failCloseRpc(t, worker);
	const childFile = join(home, "owned-child.cjs");
	await writeFile(
		childFile,
		`process.on("message", message => {
			if (message === "drain") process.send("draining");
			if (message === "release") process.exit(0);
		});
		process.send("ready");`,
	);
	const child = fork(childFile, { execArgv: [], env: {}, silent: true });
	const ready = gate();
	const draining = gate();
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	child.on("message", (message) => {
		if (message === "ready") ready.resolve();
		if (message === "draining") draining.resolve();
	});
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	});
	await ready.promise;
	let settled = false;
	const result = rejection(
		shutdownSchedules(resources(store), async () => {
			assert.equal(worker.threadId, -1);
			child.send("drain");
			assert.equal(await exited, 0);
		}),
	).then((outcome) => {
		settled = true;
		return outcome;
	});
	try {
		assert.equal(
			await Promise.race([draining.promise.then(() => "draining"), result.then(() => "settled")]),
			"draining",
		);
		await setImmediate();
		assert.equal(settled, false, "requesting child shutdown is not proof of exit");
		assert.equal(child.exitCode, null);
	} finally {
		child.send("release");
	}
	const { error } = await result;
	assert.ok(error instanceof Error);
	assert.equal(error.message, "Unknown schedule operation");
	assert.equal(child.exitCode, 0);
});

test("dispatch final write drains before store closure and independent cleanup", async (t) => {
	const { file, store, worker } = await fixture(t);
	const enteredSend = gate();
	const releaseSend = gate();
	const events: string[] = [];
	const service = new ScheduleService(store, {
		projects: { require: () => assert.fail("message schedules need no project") },
		sessions: {
			get: () => ({}),
			spawn: async () => assert.fail("message schedules must not spawn"),
			send: async () => {
				enteredSend.resolve();
				await releaseSend.promise;
			},
		},
	});
	await service.load();
	service.start();
	const item = await service.create({
		trigger: "on_online",
		target: { kind: "message", sessionId: "fixture", message: "offline fixture" },
	});
	const dispatch = service.signal({ type: "online", online: true });
	let finished = false;
	let stopping: Promise<void> | undefined;
	try {
		await enteredSend.promise;
		const close = store.close.bind(store);
		t.mock.method(store, "close", async () => {
			events.push("store");
			assert.equal(store.require(item.id).state, "fired", "authoritative terminal write precedes close");
			await close();
		});
		stopping = shutdownSchedules({ ...resources(store, events), schedules: service }, async () => {
			events.push("tail");
			assert.equal(worker.threadId, -1);
			const reopened = new ScheduleStore(file);
			try {
				await reopened.load();
				assert.equal(reopened.require(item.id).state, "fired", "terminal write survived actual SQLite reopen");
			} finally {
				await reopened.close();
			}
		}).then(() => {
			finished = true;
		});
		await setImmediate();
		assert.deepEqual(events, [], "held dispatch blocks store and dependent teardown");
		assert.equal(finished, false);
		assert.notEqual(worker.threadId, -1);
		await assert.rejects(service.create({ target: item.target }), /Scheduler stopped/);
		await assert.rejects(service.signal({ type: "online", online: false }), /Scheduler not running/);
	} finally {
		releaseSend.resolve();
		await dispatch;
		await stopping;
		await service.stop();
	}
	assert.equal(finished, true);
	assert.deepEqual(events, ["connectivity", "systemEvents", "store", "tail"]);
});

test("each prerequisite stop failure leaves the store and remaining cleanup untouched", async (t) => {
	for (const failed of ["schedules", "connectivity", "systemEvents"] as const) {
		await t.test(failed, async () => {
			const events: string[] = [];
			const failure = new Error(`${failed} stop failed`);
			const owned = resources({ close: async () => void events.push("store") }, events);
			owned[failed].stop = () => {
				events.push(failed);
				throw failure;
			};
			const { error } = await rejection(shutdownSchedules(owned, async () => void events.push("tail")));
			assert.equal(error, failure);
			assert.deepEqual(events, ["schedules", "connectivity", "systemEvents"].slice(0, events.length));
			assert.equal(events.at(-1), failed);
		});
	}
});

test("single and combined close/drain errors preserve arbitrary thrown values without truthiness loss", async (t) => {
	for (const failure of [undefined, null, false, 0, "", new Error("close failure")]) {
		await t.test(String(failure), async () => {
			const store = {
				close: async () => {
					throw failure;
				},
			};
			const single = await rejection(shutdownSchedules(resources(store), async () => {}));
			assert.equal(single.error, failure);
			const tailFailure = { stage: "tail" };
			const combined = await rejection(
				shutdownSchedules(resources(store), async () => {
					throw tailFailure;
				}),
			);
			assert.ok(combined.error instanceof AggregateError);
			assert.deepEqual(combined.error.errors, [failure, tailFailure]);
		});
	}
});

test("successful store close does not swallow a later failure or continue its dependent tail", async () => {
	const failure = new Error("producer drain failed");
	let dependentClosed = false;
	const { error } = await rejection(
		shutdownSchedules(resources({ close: async () => {} }), async () => {
			await Promise.reject(failure);
			dependentClosed = true;
		}),
	);
	assert.equal(error, failure);
	assert.equal(dependentClosed, false);
});

test("bootstrap failure remains observable and does not stand in for a close RPC failure", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-schedule-bootstrap-"));
	const store = new ScheduleStore(home); // Opening a directory as SQLite fails in the actual worker.
	const worker = (store as unknown as { worker: Worker }).worker;
	const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
	t.after(async () => {
		await store.close().catch(() => {});
		await worker.terminate();
		await rm(home, { recursive: true, force: true });
	});
	await assert.rejects(store.load());
	await exited;
	let drained = false;
	const { error } = await rejection(
		shutdownSchedules(resources(store), async () => {
			assert.equal(worker.threadId, -1);
			drained = true;
		}),
	);
	assert.equal(drained, true);
	assert.ok(error instanceof Error);
	assert.match(error.message, /Schedule worker exited/);
});
