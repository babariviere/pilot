import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ownModelCatalog } from "./model-catalog-owner.ts";

type Runtime = Pick<ModelRuntime, "refresh" | "getAvailable">;
const refreshed = () => ({ aborted: false, errors: new Map<string, Error>() });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("one runtime shares concurrent availability work, not settled catalog results", async () => {
	const entered = deferred();
	const release = deferred();
	let scans = 0;
	const runtime: Runtime = {
		refresh: async () => refreshed(),
		getAvailable: async () => {
			scans++;
			entered.resolve();
			await release.promise;
			return [];
		},
	};
	ownModelCatalog(runtime);
	const first = runtime.getAvailable();
	await entered.promise;
	const others = Array.from({ length: 32 }, () => runtime.getAvailable());
	release.resolve();
	const results = await Promise.all([first, ...others]);
	assert.equal(scans, 1);
	assert.notEqual(results[0], results[1]);
	await runtime.getAvailable();
	assert.equal(scans, 2);
});

test("registration bursts have one queued refresh and one trailing pass when already active", async () => {
	const entered = deferred();
	const release = deferred();
	let active = 0;
	let peak = 0;
	let refreshes = 0;
	let scans = 0;
	const runtime: Runtime = {
		refresh: async () => {
			peak = Math.max(peak, ++active);
			if (++refreshes === 1) {
				entered.resolve();
				await release.promise;
			}
			active--;
			return refreshed();
		},
		getAvailable: async () => {
			peak = Math.max(peak, ++active);
			scans++;
			active--;
			return [];
		},
	};
	ownModelCatalog(runtime);
	const first = runtime.refresh({ allowNetwork: false });
	await entered.promise;
	const trailing = Array.from({ length: 32 }, () => runtime.refresh({ allowNetwork: false }));
	const readers = Array.from({ length: 8 }, () => runtime.getAvailable());
	assert.equal(refreshes, 1);
	assert.equal(scans, 0);
	release.resolve();
	await Promise.all([first, ...trailing, ...readers]);
	assert.equal(refreshes, 2);
	assert.equal(scans, 1);
	assert.equal(peak, 1);
});

test("catalog ownership is per runtime, not a global bottleneck", async () => {
	const entered = deferred();
	const release = deferred();
	const first: Runtime = {
		refresh: async () => refreshed(),
		getAvailable: async () => {
			entered.resolve();
			await release.promise;
			return [];
		},
	};
	const second: Runtime = { refresh: async () => refreshed(), getAvailable: async () => [] };
	ownModelCatalog(first);
	ownModelCatalog(second);
	const blocked = first.getAvailable();
	await entered.promise;
	assert.deepEqual(await second.getAvailable(), []);
	release.resolve();
	await blocked;
});

test("a provider mutation prevents new readers from joining an older availability pass", async () => {
	const entered = deferred();
	const release = deferred();
	let revision = 0;
	const seen: number[] = [];
	const runtime: Runtime = {
		refresh: async () => refreshed(),
		getAvailable: async () => {
			seen.push(revision);
			if (seen.length === 1) {
				entered.resolve();
				await release.promise;
			}
			return [];
		},
	};
	ownModelCatalog(runtime);
	const old = runtime.getAvailable();
	await entered.promise;
	revision++;
	const update = runtime.refresh({ allowNetwork: false });
	const current = runtime.getAvailable();
	release.resolve();
	await Promise.all([old, update, current]);
	assert.deepEqual(seen, [0, 1]);
});

test("explicit scoped, forced, network and signaled refreshes retain their separate options", async () => {
	const calls: Parameters<Runtime["refresh"]>[0][] = [];
	const runtime: Runtime = {
		refresh: async (options) => {
			calls.push(options);
			return refreshed();
		},
		getAvailable: async () => [],
	};
	ownModelCatalog(runtime);
	const options = [
		{ allowNetwork: false, providers: ["fixture"] },
		{ allowNetwork: false, force: true },
		{ allowNetwork: true },
		{ allowNetwork: false, signal: new AbortController().signal },
		{},
	];
	await Promise.all(options.map((value) => runtime.refresh(value)));
	assert.deepEqual(calls, options);
});

test("credential mutations invalidate active availability without waiting for the catalog lane", async () => {
	const entered = deferred();
	const release = deferred();
	let scans = 0;
	let changed = false;
	const runtime: Runtime & Pick<ModelRuntime, "setRuntimeApiKey"> = {
		refresh: async () => refreshed(),
		setRuntimeApiKey: async (provider, key) => {
			assert.equal(provider, "fixture");
			assert.equal(key, "new-key");
			changed = true;
		},
		getAvailable: async () => {
			if (++scans === 1) {
				entered.resolve();
				await release.promise;
			} else assert.equal(changed, true);
			return [];
		},
	};
	ownModelCatalog(runtime);
	const old = runtime.getAvailable();
	await entered.promise;
	await runtime.setRuntimeApiKey("fixture", "new-key");
	const current = runtime.getAvailable();
	release.resolve();
	await Promise.all([old, current]);
	assert.equal(scans, 2);
});

test("queued offline refreshes do not cross explicit refresh or catalog-read barriers", async () => {
	const calls: string[] = [];
	const runtime: Runtime = {
		refresh: async (options) => {
			calls.push(options?.allowNetwork ? "network" : "offline");
			return refreshed();
		},
		getAvailable: async () => {
			calls.push("available");
			return [];
		},
	};
	ownModelCatalog(runtime);
	await Promise.all([
		runtime.refresh({ allowNetwork: false }),
		runtime.refresh({ allowNetwork: true }),
		runtime.refresh({ allowNetwork: false }),
		runtime.getAvailable(),
		runtime.refresh({ allowNetwork: false }),
	]);
	assert.deepEqual(calls, ["offline", "network", "offline", "available", "offline"]);
});

test("one canceled reader does not cancel shared availability or poison its next read", async () => {
	const entered = deferred();
	const release = deferred();
	let scans = 0;
	const runtime: Runtime = {
		refresh: async () => refreshed(),
		getAvailable: async (_, options) => {
			assert.equal(options?.signal, undefined);
			scans++;
			entered.resolve();
			await release.promise;
			return [];
		},
	};
	ownModelCatalog(runtime);
	const controller = new AbortController();
	const canceled = runtime.getAvailable(undefined, { signal: controller.signal });
	const shared = runtime.getAvailable();
	await entered.promise;
	controller.abort(new Error("reader stopped"));
	await assert.rejects(canceled, /reader stopped/);
	await assert.rejects(runtime.getAvailable(undefined, { signal: controller.signal }), /reader stopped/);
	release.resolve();
	await shared;
	assert.equal(scans, 1);
	await runtime.getAvailable();
	assert.equal(scans, 2);
});

test("failed catalog operations release ownership for later work", async () => {
	let scans = 0;
	let refreshes = 0;
	const runtime: Runtime = {
		refresh: async () => {
			if (++refreshes === 1) throw new Error("refresh failed");
			return refreshed();
		},
		getAvailable: async () => {
			if (++scans === 1) throw new Error("availability failed");
			return [];
		},
	};
	ownModelCatalog(runtime);
	await assert.rejects(runtime.refresh({ allowNetwork: false }), /refresh failed/);
	await assert.rejects(runtime.getAvailable(), /availability failed/);
	await runtime.refresh({ allowNetwork: false });
	assert.deepEqual(await runtime.getAvailable(), []);
});
