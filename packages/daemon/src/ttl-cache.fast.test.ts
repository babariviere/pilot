import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceUnavailable } from "./errors.ts";
import { TtlCache } from "./ttl-cache.ts";

function cache(overrides: Partial<ConstructorParameters<typeof TtlCache<string>>[0]> = {}) {
	return new TtlCache<string>({
		ttlMs: 100,
		maxEntries: 2,
		maxBytes: 10,
		maxPending: 2,
		weight: (value) => Buffer.byteLength(value),
		...overrides,
	});
}

test("coalesces in-flight loads, caches results until expiry, and retries failures", async () => {
	let now = 0;
	let calls = 0;
	const results = cache({ now: () => now });
	const load = async () => String(++calls);
	const first = results.get("a", load);
	assert.equal(results.get("a", load), first);
	assert.equal(await first, "1");
	now = 99;
	assert.equal(await results.get("a", load), "1");
	now = 100;
	assert.equal(await results.get("a", load), "2");
	await assert.rejects(
		results.get("b", async () => {
			throw new Error("failed");
		}),
		/failed/,
	);
	assert.equal(await results.get("b", load), "3");
});

test("evicts least recently used results at entry and byte limits and does not retain oversized results", async () => {
	const results = cache();
	let calls = 0;
	const load = async () => String(++calls);
	await results.get("a", load);
	await results.get("b", load);
	await results.get("a", load);
	await results.get("c", load);
	assert.equal(await results.get("a", load), "1");
	assert.equal(await results.get("b", load), "4");
	const bytes = cache({ maxEntries: 10 });
	await bytes.get("a", async () => "123456");
	await bytes.get("b", async () => "123456");
	assert.equal(await bytes.get("a", async () => "fresh"), "fresh");
	await bytes.get("large", async () => "12345678901");
	assert.equal(await bytes.get("large", async () => "new"), "new");
});

test("invalidation cannot repopulate stale results or evade pending limits", async () => {
	const results = cache({ maxPending: 1 });
	let finish!: (value: string) => void;
	const pending = results.get(
		"a",
		() =>
			new Promise<string>((resolve) => {
				finish = resolve;
			}),
	);
	await Promise.resolve();
	results.invalidate((key) => key === "a");
	await assert.rejects(
		results.get("a", async () => "new"),
		ServiceUnavailable,
	);
	finish("old");
	assert.equal(await pending, "old");
	assert.equal(await results.get("a", async () => "new"), "new");
});

test("pending entries are coalesced, not evicted, when admission is full", async () => {
	const results = cache({ maxEntries: 1, maxPending: 2 });
	let finish!: (value: string) => void;
	const pending = results.get(
		"a",
		() =>
			new Promise<string>((resolve) => {
				finish = resolve;
			}),
	);
	assert.equal(
		results.get("a", async () => "wrong"),
		pending,
	);
	await assert.rejects(
		results.get("b", async () => "busy"),
		ServiceUnavailable,
	);
	finish("done");
	await pending;
	assert.equal(await results.get("b", async () => "admitted"), "admitted");
});
