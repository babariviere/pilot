import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { PiReload } from "./pi-reload.ts";

const turn = () => setImmediate();

test("reload is bounded, event-driven, idempotent and does not interrupt busy targets", async () => {
	const calls: string[] = [];
	const releases: Array<() => void> = [];
	const busy = new Set(["busy"]);
	const reload = new PiReload<string>(
		(id) => !busy.has(id),
		async (id) => {
			calls.push(id);
			await new Promise<void>((resolve) => releases.push(resolve));
			return true;
		},
	);
	const operationId = randomUUID();
	reload.request(operationId, new Map(["one", "two", "three", "busy"].map((id) => [id, id])));
	assert.deepEqual(calls, ["one", "two"]);
	assert.deepEqual(reload.status(), { operationId, pending: 2, reloading: 2, reloaded: 0, failed: 0 });
	reload.request(operationId, new Map());
	assert.deepEqual(calls, ["one", "two"]);
	assert.throws(() => reload.request(randomUUID(), new Map()), /already pending/);
	releases.shift()!();
	await turn();
	assert.deepEqual(calls, ["one", "two", "three"]);
	for (const release of releases.splice(0)) release();
	await turn();
	assert.equal(reload.status().pending, 1);
	await turn();
	assert.equal(calls.length, 3, "busy is never polled");
	busy.delete("busy");
	reload.wake("busy");
	await turn();
	assert.equal(calls.at(-1), "busy");
	releases.shift()!();
	await turn();
	assert.equal(reload.status().reloaded, 4);
	reload.stop();
});

test("busy refusals wait for a new event, failures are not retried, and shutdown stops pending work", async () => {
	let calls = 0;
	let outcome: boolean | Error = false;
	const reload = new PiReload<string>(
		() => true,
		async () => {
			calls++;
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
	);
	reload.request(randomUUID(), new Map([["one", "one"]]));
	await turn();
	assert.equal(calls, 1);
	assert.equal(reload.status().pending, 1);
	await turn();
	assert.equal(calls, 1);
	outcome = new Error("private details never enter public status");
	reload.wake("one");
	await turn();
	assert.equal(reload.status().failed, 1);
	reload.wake("one");
	await turn();
	assert.equal(calls, 2);
	assert.doesNotMatch(JSON.stringify(reload.status()), /private/);
	outcome = false;
	reload.request(randomUUID(), new Map([["two", "two"]]));
	await turn();
	reload.stop();
	reload.wake("two");
	await turn();
	assert.equal(calls, 3);
});
