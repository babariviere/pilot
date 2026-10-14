import assert from "node:assert/strict";
import { test } from "node:test";
import type { WiFiStatus } from "@pilot/protocol";
import { WiFiDetection, type WiFiHelperFactory } from "./wifi-detection.ts";
import { parseWiFiStatus } from "./wifi-helper.ts";

const wifiState = (currentNetwork: string | null, extra: Partial<WiFiStatus> = {}): WiFiStatus => ({
	authorization: "authorized",
	available: true,
	currentNetwork,
	knownNetworks: ["Office", "Home"],
	...extra,
});

test("fake helper: baselines, roaming, disconnect, auth loss, recovery and stop are not invented edges", async () => {
	let report!: (value: WiFiStatus) => void;
	let opens = 0;
	let closes = 0;
	let authorizations = 0;
	let current = wifiState("Office");
	const factory: WiFiHelperFactory = async (onStatus) => {
		opens++;
		report = onStatus;
		onStatus(current);
		return {
			send: (command) => {
				if (command.authorize) authorizations++;
				onStatus(current);
			},
			close: () => {
				closes++;
			},
		};
	};
	const detector = new WiFiDetection(factory);
	const events: unknown[] = [];
	detector.subscribe((event) => events.push(event));
	detector.setActive(true);
	await detector.status();
	assert.equal(opens, 1);
	assert.deepEqual(events, []);
	report(wifiState("Office")); // BSSID roaming, same SSID.
	report(wifiState("Home"));
	report(wifiState(null)); // Wi-Fi off/disassociated, including when Ethernet remains online.
	assert.deepEqual(events, [
		{ previous: "Office", current: "Home" },
		{ previous: "Home", current: null },
	]);
	report(wifiState(null, { authorization: "denied" }));
	report(wifiState("Office"));
	assert.equal(events.length, 2);
	report(wifiState(null, { available: false })); // redacted SSID / detector failure
	report(wifiState("Home"));
	assert.equal(events.length, 2);
	current = wifiState("Home");
	await detector.requestAuthorization();
	assert.equal(authorizations, 1);
	// Defensive copies, not mutable picker shared state.
	current = wifiState("Home");
	const value = await detector.status();
	value.knownNetworks.push("Bogus");
	assert.ok(!(await detector.status()).knownNetworks.includes("Bogus"));
	detector.stop();
	report(wifiState("Office"));
	assert.equal(closes, 1);
	assert.equal(events.length, 2);
	assert.equal((await detector.status()).authorization, "unavailable");
});

test("fake helper suspends immediately without an API lease; stale launch is closed and cannot emit", async () => {
	let finish!: (helper: { send(): void; close(): void }) => void;
	let stale!: (value: WiFiStatus) => void;
	let closed = 0;
	const detector = new WiFiDetection((onStatus) => {
		stale = onStatus;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	const events: unknown[] = [];
	detector.subscribe((event) => events.push(event));
	detector.setActive(true);
	detector.setActive(false);
	stale(wifiState("Office"));
	finish({
		send() {},
		close() {
			closed++;
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(closed, 1);
	assert.deepEqual(events, []);
	detector.stop();
});

test("helper messages are bounded, redact unauthorized names and sanitize diagnostics", () => {
	assert.equal(parseWiFiStatus(null), undefined);
	assert.equal(parseWiFiStatus(wifiState("x".repeat(33))), undefined);
	assert.equal(parseWiFiStatus(wifiState(null, { knownNetworks: Array(257).fill("Home") })), undefined);
	assert.deepEqual(parseWiFiStatus(wifiState("Home", { authorization: "denied", error: "Private detail" })), {
		authorization: "denied",
		available: true,
		currentNetwork: null,
		knownNetworks: [],
		error: "Wi-Fi monitoring unavailable.",
	});
});

test("fake helper crash reconnects without synthesizing a leave or join and ignores stale frames", async () => {
	const reports: Array<(value: WiFiStatus) => void> = [];
	const crashes: Array<() => void> = [];
	const detector = new WiFiDetection(async (report, crash) => {
		reports.push(report);
		crashes.push(crash);
		return {
			send() {
				report(wifiState(reports.length === 1 ? "Office" : "Home"));
			},
			close() {},
		};
	});
	const events: unknown[] = [];
	detector.subscribe((event) => events.push(event));
	try {
		detector.setActive(true);
		await detector.status();
		crashes[0]();
		reports[0](wifiState(null)); // Dead connection cannot manufacture a departure.
		await detector.status(); // Explicit picker refresh retries immediately, not SSID polling.
		assert.equal(reports.length, 2);
		reports[0](wifiState("Office"));
		assert.deepEqual(events, []);
		reports[1](wifiState(null));
		assert.deepEqual(events, [{ previous: "Home", current: null }]);
	} finally {
		detector.stop();
	}
});
