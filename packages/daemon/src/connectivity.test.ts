import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ConnectivityState } from "@pilot/kernel";
import { ConnectivityService } from "./connectivity.ts";
import { ScheduleDetection } from "./schedule-detection.ts";

async function until(check: () => boolean | Promise<boolean>) {
	const end = Date.now() + 3000;
	while (!(await check())) {
		assert.ok(Date.now() < end, "timed out");
		await delay(2);
	}
}

test("closed-app detection is shared, debounces failure hints and never runs the wake sampler for agents alone", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-connectivity-"));
	const file = join(root, "connectivity.json");
	let online = true,
		probes = 0,
		samples = 0;
	const detector = new ScheduleDetection({
		probe: async () => {
			probes++;
			return online;
		},
		sampleWake: async () => {
			samples++;
			return { wallMs: 0, monotonicMs: 0 };
		},
	});
	const states: boolean[] = [];
	const service = new ConnectivityService(file, detector, (value) => states.push(value));
	t.after(async () => {
		await service.stop();
		detector.setActive(false);
		await rm(root, { recursive: true, force: true });
	});
	const state = async () => JSON.parse(await readFile(file, "utf8")) as ConnectivityState;
	await service.start();
	await until(async () => (await state()).online);
	assert.equal(samples, 0);
	detector.setActive(false);
	online = false;
	await Promise.all(Array.from({ length: 50 }, () => writeFile(`${file}.check`, "")));
	await until(async () => !(await state()).online);
	assert.equal(probes, 2, "50 failed requests share one debounced check");
	assert.equal(samples, 0);
	online = true;
	await detector.refreshOnline();
	await until(async () => (await state()).online);
	assert.ok(states.includes(false));
	assert.equal(probes, 3);
});

test("restart replaces a cached offline hold with unknown, which admits requests until a failure", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-connectivity-restart-"));
	const file = join(root, "connectivity.json");
	await writeFile(file, JSON.stringify({ version: 1, online: false, checkedAt: Date.now() }));
	let finish!: (value: boolean) => void;
	const detector = new ScheduleDetection({
		probe: () =>
			new Promise<boolean>((resolve) => {
				finish = resolve;
			}),
	});
	const service = new ConnectivityService(file, detector, () => {});
	t.after(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});
	await service.start();
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, online: true, checkedAt: 0 });
	await until(() => !!finish);
	await service.stop();
	finish(false);
	await delay(10);
	assert.equal(JSON.parse(await readFile(file, "utf8")).online, true);
});

test("a failed check alone never pauses agents; a failed request confirmed by a check does", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-connectivity-evidence-"));
	const file = join(root, "connectivity.json");
	let connected = true;
	t.mock.method(globalThis, "fetch", async (url: string) => {
		if (!connected || url === "https://www.gstatic.com/generate_204") throw new TypeError("fetch failed");
		assert.equal(url, "https://cp.cloudflare.com/generate_204");
		return new Response(null, { status: 204 });
	});
	const detector = new ScheduleDetection();
	const published: boolean[] = [];
	const publications = new EventEmitter();
	const service = new ConnectivityService(file, detector, (online) => {
		published.push(online);
		publications.emit(online ? "online" : "offline");
	});
	t.after(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});
	const state = async () => JSON.parse(await readFile(file, "utf8")) as ConnectivityState;
	await service.start();
	assert.equal(await detector.refreshOnline(), true, "finish the startup check before simulating an outage");
	connected = false;
	assert.equal(await detector.refreshOnline(), false);
	assert.equal((await state()).online, true, "blocked check hosts without a failed request change nothing");
	const paused = once(publications, "offline");
	await writeFile(`${file}.check`, "");
	// The atomic rename can be visible to readFile before save() calls publish(). Await both consumers.
	await paused;
	assert.equal((await state()).online, false);
	assert.equal(published.at(-1), false);
	const resumed = once(publications, "online");
	connected = true;
	await detector.refreshOnline();
	await resumed;
	assert.equal((await state()).online, true);
	assert.equal(published.at(-1), true);
});

test("a healthy host sends no periodic checks for agents", { timeout: 10_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-connectivity-idle-"));
	const file = join(root, "connectivity.json");
	const timers: Array<() => void> = [];
	let probes = 0;
	const detector = new ScheduleDetection({
		clock: {
			now: () => 1,
			setTimeout(callback) {
				timers.push(callback);
				return () => {};
			},
		},
		probe: async () => {
			probes++;
			return true;
		},
	});
	const service = new ConnectivityService(file, detector, () => {});
	t.after(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});
	await service.start();
	await until(() => probes === 1);
	await delay(10);
	assert.equal(timers.length, 0, "no follow-up probe is scheduled while online");
});

test("lasting path loss pauses, a returning path resumes, and a lost helper defers to a check", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-connectivity-path-"));
	const file = join(root, "connectivity.json");
	let reachable = false,
		probes = 0;
	const detector = new ScheduleDetection({
		probe: async () => {
			probes++;
			return reachable;
		},
	});
	const service = new ConnectivityService(file, detector, () => {}, { pathLossDebounceMs: 30 });
	t.after(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});
	const state = async () => JSON.parse(await readFile(file, "utf8")) as ConnectivityState;
	await service.start();
	await until(() => probes === 1);
	service.setPath(false);
	service.setPath(true);
	await delay(60);
	assert.equal((await state()).online, true, "a brief loss (roaming, VPN reconnect) is ignored");
	service.setPath(false);
	await until(async () => !(await state()).online);
	service.setPath(true);
	await until(async () => (await state()).online);
	assert.equal(probes, 1, "a returning path resumes without waiting for a check");
	service.setPath(false);
	await until(async () => !(await state()).online);
	service.setPath(undefined);
	await until(() => probes === 2);
	await delay(20);
	assert.equal((await state()).online, false, "unknown keeps the hold while checks still fail");
	reachable = true;
	await detector.refreshOnline();
	await until(async () => (await state()).online);
});

test("model data received during a hold releases it for every chat", { timeout: 10_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-connectivity-data-"));
	const file = join(root, "connectivity.json");
	const detector = new ScheduleDetection({ probe: async () => false });
	const service = new ConnectivityService(file, detector, () => {});
	t.after(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});
	const state = async () => JSON.parse(await readFile(file, "utf8")) as ConnectivityState;
	await service.start();
	await writeFile(`${file}.check`, "");
	await until(async () => !(await state()).online);
	await writeFile(`${file}.reachable`, "");
	await until(async () => (await state()).online);
});

test("checks include the provider server a request failed to reach, until a check passes", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-connectivity-origin-"));
	const file = join(root, "connectivity.json");
	const seen: string[][] = [];
	const reachable = true;
	const detector = new ScheduleDetection({
		probe: async (_signal, origins) => {
			seen.push([...origins]);
			return reachable;
		},
	});
	const service = new ConnectivityService(file, detector, () => {});
	t.after(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});
	await service.start();
	await until(() => seen.length === 1);
	await writeFile(`${file}.check.abc`, "https://api.example.test");
	await writeFile(`${file}.check.def`, "http://portal.test");
	await until(() => seen.length === 2);
	assert.deepEqual(seen[1], ["https://api.example.test"], "only HTTPS origins are checked");
	await detector.refreshOnline();
	assert.deepEqual(seen.at(-1), [], "a passing check clears the list");
});
