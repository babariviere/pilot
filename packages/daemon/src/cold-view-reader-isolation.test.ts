// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access tests private reader concurrency bounds.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ColdViewReader } from "./cold-view-reader.ts";
import { ServiceUnavailable } from "./errors.ts";

test("cold-reader admission bounds queued work and releases it on shutdown", async () => {
	const reader = new ColdViewReader();
	// Fill synchronously, before the worker threads can return their first result.
	const reads = Promise.allSettled(Array.from({ length: 34 }, () => reader.read("/unused", "/unused", false)));
	try {
		assert.equal(reader["active"].size, 2);
		assert.equal(reader["waiting"].length, 32);
		await assert.rejects(reader.read("/unused", "/unused", false), ServiceUnavailable);
		assert.equal(reader["waiting"].length, 32, "overload must not enqueue more work");
	} finally {
		await reader.close();
	}
	assert.equal(reader["active"].size, 0);
	assert.equal(reader["waiting"].length, 0);
	assert.equal((await reads).length, 34);
});

test("cold-reader threads are concurrency bounded, leave the event loop responsive, and drain on close", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-cold-thread-"));
	const reader = new ColdViewReader();
	t.after(async () => {
		await reader.close();
		await rm(dir, { recursive: true, force: true });
	});
	const results = Promise.allSettled([
		reader.read(join(dir, "one"), dir),
		reader.read(join(dir, "two"), dir),
		reader.read(join(dir, "three"), dir),
	]);
	assert.equal(reader["active"].size, 2);
	assert.equal(reader["waiting"].length, 1);
	await delay(1);
	await reader.close();
	const settled = await results;
	assert.equal(settled[2]?.status, "rejected", "queued work is cancelled on shutdown");
	assert.equal(reader["active"].size, 0);
	assert.equal(reader["waiting"].length, 0);
	await assert.rejects(reader.read(join(dir, "four"), dir), /closed/);
});

test("cold-reader cancellation removes only queued jobs and immediately frees admission", async () => {
	const reader = new ColdViewReader();
	const controllers = Array.from({ length: 34 }, () => new AbortController());
	const reads = controllers.map((controller, index) =>
		reader.read(`/unused/${index}`, "/unused", false, controller.signal),
	);
	const settled = Promise.allSettled(reads);
	try {
		assert.equal(reader["active"].size, 2);
		assert.equal(reader["waiting"].length, 32);
		assert.equal(getEventListeners(controllers[0].signal, "abort").length, 0, "started jobs detach cancellation");
		assert.equal(getEventListeners(controllers[2].signal, "abort").length, 1);
		controllers[2].abort();
		await assert.rejects(reads[2], { name: "AbortError" });
		assert.equal(getEventListeners(controllers[2].signal, "abort").length, 0);
		assert.equal(reader["waiting"].length, 31);
		assert.equal(reader["waiting"][0].directory, "/unused/3", "other consumers keep their queue order");
		const replacement = reader.read("/replacement", "/unused", false);
		const replacementSettled = Promise.allSettled([replacement]);
		assert.equal(reader["waiting"].length, 32, "cancelled slots are reusable immediately");
		controllers[0].abort();
		assert.equal(reader["active"].size, 2, "started reads are left running for the shared cache");
		assert.equal(reader["waiting"].length, 32);
		await reader.close();
		assert.equal(getEventListeners(controllers[3].signal, "abort").length, 0, "shutdown detaches queued listeners");
		await replacementSettled;
	} finally {
		await reader.close();
	}
	assert.equal((await settled)[2]?.status, "rejected");
	assert.equal(reader["waiting"].length, 0);
});

test("cold-reader pre-aborted requests never occupy a worker or queue slot", async () => {
	const reader = new ColdViewReader();
	try {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(reader.read("/unused", "/unused", false, controller.signal), { name: "AbortError" });
		assert.equal(reader["active"].size, 0);
		assert.equal(reader["waiting"].length, 0);
	} finally {
		await reader.close();
	}
});

test("cold-reader promise cancellation reports only successful queued removals", async () => {
	const reader = new ColdViewReader();
	const reads = Array.from({ length: 4 }, () => reader.read("/unused", "/unused", false));
	const settled = Promise.allSettled(reads);
	try {
		assert.equal(reader.cancel(reads[0]), false, "active reads remain running");
		assert.equal(reader.cancel(reads[2]), true);
		assert.equal(reader.cancel(reads[2]), false, "repeat cancellation is idempotent");
		assert.equal(reader["waiting"].length, 1);
		assert.equal(reader["waiting"][0].promise, reads[3], "another consumer's read is preserved");
		await assert.rejects(reads[2], { name: "AbortError" });
	} finally {
		await reader.close();
	}
	await settled;
});
