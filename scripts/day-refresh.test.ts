// Node feedback loop for the real connected adapters. Only the NSH host
// channel is scripted; the refresh, ordering and projection code is production.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const answers = new Map<string, unknown>();
const calls: string[] = [];
const host = {
	async call(name: string) {
		calls.push(name);
		const answer = answers.get(name);
		const value = typeof answer === "function" ? await answer() : answer;
		if (value && typeof value === "object" && "error" in value) return { version: 1, ...value };
		return { version: 1, value: { snapshot: value } };
	},
};
(globalThis as Record<string, unknown>).__refreshHost = host;
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "nsh") return { url: "test:nsh-refresh", shortCircuit: true };
		if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
			const url = new URL(`${specifier}.ts`, context.parentURL);
			if (existsSync(fileURLToPath(url))) return next(url.href, context);
		}
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url === "test:nsh-refresh")
			return {
				format: "module",
				shortCircuit: true,
				source: `export const host = globalThis.__refreshHost;
export function signal(value) { const read = () => value; read.set = (v) => { value = v }; read.update = (f) => { value = f(value) }; return read; }`,
			};
		return next(url, context);
	},
});
const { ConnectedPlans, ConnectedToday } = await import("../apps/day/bridge.ts");

function held() {
	let resolve!: (value: unknown) => void;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("background invalidation keeps the complete planning read, not a failure block", async () => {
	const feed = new ConnectedPlans("window", null);
	const row = { missionId: "mission", title: "Kept mission", identity: { interviewId: "round" } };
	answers.set("day.plan.inventory", { availability: "live", plans: [row] });
	await feed.readInventory();
	assert.equal(feed.snapshot().plans.length, 1);
	for (let n = 0; n < 5; n++) {
		answers.set("day.plan.inventorySnapshot", { availability: "stale", reason: "Reading changes.", plans: [row] });
		await feed.refresh();
		assert.equal(feed.snapshot().plans.length, 1, "automatic refresh removed the planning rows");
		assert.equal(feed.snapshot().availability, "stale", "invalidation became an unavailable failure block");
		answers.set("day.plan.inventorySnapshot", { availability: "live", plans: [row] });
		await feed.refresh();
		assert.equal(feed.snapshot().availability, "live");
	}
	assert.ok(calls.every((name) => ["day.plan.inventory", "day.plan.inventorySnapshot"].includes(name)));
});

test("a notice fences an overlapping Today reply before the next read completes", async () => {
	const initial = { revision: 1, decisions: [], actions: [] };
	const feed = new ConnectedToday("window", initial as never);
	const old = held(),
		latest = held();
	let count = 0;
	answers.set("day.today.read", () => (++count === 1 ? old.promise : latest.promise));
	const seen: number[] = [];
	feed.onChange((today) => seen.push(today.revision));
	const reading = feed.refresh();
	void feed.refresh();
	old.resolve({ ...initial, revision: 2 });
	await Promise.resolve();
	await Promise.resolve();
	latest.resolve({ ...initial, revision: 3 });
	await reading;
	assert.ok(!seen.includes(2), "invalidated reply was published as current");
	assert.equal(seen.at(-1), 3);
});

test("a slow explicit inventory read cannot overwrite a newer cached projection", async () => {
	const feed = new ConnectedPlans("window", null);
	const old = held();
	answers.set("day.plan.inventory", () => old.promise);
	const reading = feed.readInventory();
	const row = { missionId: "new", identity: { interviewId: "new-round" } };
	answers.set("day.plan.inventorySnapshot", { availability: "live", plans: [row] });
	await feed.refresh();
	old.resolve({ availability: "live", plans: [] });
	await reading;
	assert.deepEqual(feed.snapshot().plans, [row]);
});

test("a refused cached Today read keeps data but never claims fresh empty attention", async () => {
	const initial = {
		revision: 4,
		decisions: [],
		actions: [],
		freshness: { state: "live", age: "", reason: "" },
		attention: { state: "live", age: "", reason: "" },
	};
	const feed = new ConnectedToday("window", initial as never);
	const before = calls.length;
	for (let n = 0; n < 3; n++) {
		answers.set("day.today.read", { error: "offline" });
		await feed.refresh();
		assert.notEqual(feed.snapshot().attention.state, "live", "failed read claimed fresh empty attention");
		assert.equal(feed.snapshot().revision, 4, "a failed read must not invent a new data revision");
	}
	answers.set("day.today.read", initial);
	await feed.refresh();
	assert.equal(feed.snapshot().attention.state, "live");
	assert.deepEqual(calls.slice(before), Array(4).fill("day.today.read"));
});

test("cached unavailability does not erase an exact capacity or identity refusal", async () => {
	for (const refusal of ["capacity", "identity"]) {
		const feed = new ConnectedPlans("window", null);
		answers.set("day.plan.inventory", { error: refusal });
		await feed.readInventory();
		const reason = feed.snapshot().reason;
		answers.set("day.plan.inventorySnapshot", { availability: "unavailable", plans: [] });
		await feed.refresh();
		assert.equal(feed.snapshot().reason, reason);
		assert.equal(feed.canReadInventory(), refusal !== "identity");
	}
});

test("an explicit refusal survives its own unavailable-cache notice, but not newer live data", async () => {
	for (const newer of ["unavailable", "live"]) {
		const feed = new ConnectedPlans("window", null);
		const pending = held();
		answers.set("day.plan.inventory", () => pending.promise);
		const reading = feed.readInventory();
		answers.set("day.plan.inventorySnapshot", { availability: newer, plans: [] });
		await feed.refresh();
		pending.resolve({ error: "capacity" });
		await reading;
		assert.equal(feed.snapshot().availability, newer);
		assert.equal(feed.snapshot().reason.includes("More missions"), newer === "unavailable");
	}
});
