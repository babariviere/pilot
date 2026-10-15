import assert from "node:assert/strict";
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

test("restart replaces cached online with unknown before recovery, and stale probes cannot release it", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-connectivity-restart-"));
	const file = join(root, "connectivity.json");
	await writeFile(file, JSON.stringify({ version: 1, online: true, checkedAt: Date.now() }));
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
	assert.equal(JSON.parse(await readFile(file, "utf8")).online, false);
	await until(() => !!finish);
	await service.stop();
	finish(true);
	await delay(10);
	assert.equal(JSON.parse(await readFile(file, "utf8")).online, false);
});
