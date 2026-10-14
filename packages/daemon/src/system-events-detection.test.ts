import assert from "node:assert/strict";
import { test } from "node:test";
import { SystemEventsDetection, type SystemEventsHelper } from "./system-events-detection.ts";
import type { SystemPowerState } from "./system-power.ts";

const awake: SystemPowerState = { available: true, sleepAt: 1, fullWake: true };

test("power helper opens once while active and emits unavailable on loss", async () => {
	let opens = 0,
		closes = 0;
	let reportPower!: (state: SystemPowerState) => void;
	let crash!: () => void;
	const detector = new SystemEventsDetection(async (onPower, onClose) => {
		opens++;
		reportPower = onPower;
		crash = onClose;
		return {
			send() {},
			close() {
				closes++;
			},
		};
	});
	const events: SystemPowerState[] = [];
	detector.subscribePower((state) => events.push(state));
	detector.setPowerActive(true);
	detector.setPowerActive(true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(opens, 1);
	assert.equal(closes, 0);
	reportPower(awake);
	assert.deepEqual(events, [awake]);
	crash();
	assert.deepEqual(events.at(-1), { available: false, fullWake: false });
	reportPower({ ...awake, fullWake: false });
	assert.equal(events.length, 2);
	detector.setPowerActive(false);
	detector.stop();
});

test("lost helper retries while active and ignores stale power reports", async () => {
	let opens = 0;
	let reportPower!: (state: SystemPowerState) => void;
	let loseHelper!: () => void;
	const helpers: SystemEventsHelper[] = [];
	const detector = new SystemEventsDetection(async (onPower, onClose) => {
		opens++;
		reportPower = onPower;
		loseHelper = onClose;
		const helper = { send() {}, close() {} };
		helpers.push(helper);
		return helper;
	});
	const events: SystemPowerState[] = [];
	detector.subscribePower((state) => events.push(state));
	detector.setPowerActive(true);
	await new Promise((resolve) => setImmediate(resolve));
	reportPower(awake);
	loseHelper();
	assert.deepEqual(events, [awake, { available: false, fullWake: false }]);
	reportPower({ ...awake, fullWake: false });
	assert.equal(events.length, 2);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.equal(opens, 2);
	assert.equal(helpers.length, 2);
	reportPower(awake);
	assert.deepEqual(events.at(-1), awake);
	detector.setPowerActive(false);
	detector.stop();
});

test("a stale launch closes on deactivation and renewed activation gets a fresh generation", async () => {
	let finish!: (helper: SystemEventsHelper) => void;
	const reports: Array<(state: SystemPowerState) => void> = [];
	let opens = 0;
	let closes = 0;
	const detector = new SystemEventsDetection((onPower) => {
		reports.push(onPower);
		if (++opens === 1)
			return new Promise((resolve) => {
				finish = resolve;
			});
		return Promise.resolve({ send() {}, close() {} });
	});
	const events: SystemPowerState[] = [];
	detector.subscribePower((state) => events.push(state));
	detector.setPowerActive(true);
	detector.setPowerActive(false);
	detector.setPowerActive(true);
	reports[0](awake);
	finish({
		send() {},
		close() {
			closes++;
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(closes, 1);
	assert.equal(opens, 2);
	assert.deepEqual(events, []);
	reports[0]({ ...awake, fullWake: false });
	reports[1](awake);
	assert.deepEqual(events, [awake]);
	detector.stop();
});
