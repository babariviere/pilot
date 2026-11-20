// Node feedback loop for the real connected adapters. Only the NSH host
// channel is scripted; the refresh, ordering and projection code is production.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stubNsh } from "./nsh-stub.ts";

const answers = new Map<string, unknown>();
const calls: string[] = [];
const envelopes: unknown[] = [];
const host = {
	async call(name: string, envelope: unknown) {
		calls.push(name);
		envelopes.push(envelope);
		const answer = answers.get(name);
		const value = typeof answer === "function" ? await answer() : answer;
		if (value && typeof value === "object" && "value" in value) return { version: 1, ...value };
		if (value && typeof value === "object" && "error" in value) return { version: 1, ...value };
		return { version: 1, value: { snapshot: value } };
	},
};
stubNsh(host, { "./ui": ["glide"] });
const { ConnectedPlans } = await import("../planFeed.ts");
const { ConnectedToday } = await import("../todayFeed.ts");

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

test("a cached Today read cannot overwrite a newer service projection", async () => {
	const initial = { revision: 1, decisions: [], actions: [] };
	const old = held();
	const feed = new ConnectedToday("window", initial as never);
	answers.set("day.today.read", () => old.promise);
	const reading = feed.refresh();
	answers.set("day.today.refresh", { ...initial, revision: 3 });
	assert.equal(await feed.serviceRead(), "current");
	old.resolve({ ...initial, revision: 2 });
	await reading;
	assert.equal(feed.snapshot().revision, 3);
});

// "Live data in the UI": a failed background read keeps the last good data as it
// was. Whether to warn is the automatic reads' rule (freshness.ts: older than 5
// minutes and 3 failed tries), not one failed refresh.
test("a refused cached Today read keeps the last good data unchanged", async () => {
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
		assert.deepEqual(feed.snapshot().attention, initial.attention, "a failed read changed what shows");
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

test("a linear read keeps its saved issues through a refused refresh", async () => {
	const { ConnectedLinear } = await import("../linearFeed.ts");
	const feed = new ConnectedLinear("window");
	const snapshot = {
		version: 1,
		scope: "saved-own-issues",
		items: [{ id: "issue" }],
		total: 1,
		more: 0,
		source: {},
		configurationCurrent: true,
	};
	const before = calls.length;
	answers.set("day.linear.read", snapshot);
	await feed.read();
	const read = feed.view().read;
	assert.deepEqual(read, snapshot);
	answers.set("day.linear.read", { error: "offline" });
	await feed.read();
	assert.equal(feed.view().read, read);
	assert.equal(feed.view().availability, "live");
	assert.match(feed.view().reason, /could not reach/);
	assert.deepEqual(calls.slice(before), ["day.linear.read", "day.linear.read"]);
	feed.dispose();
});

test("a lost intake start is looked up by its exact receipt, never sent twice", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { ConnectedIntake } = await import("../intakeFeed.ts");
	const feed = new ConnectedIntake("window");
	const contextDigest = "a".repeat(64);
	const intent = { itemId: "request", revision: 3, contextDigest };
	const snapshot = {
		version: 1,
		projectId: "project",
		contextDigest,
		sources: [{ items: [{ id: "request", revision: 3 }] }],
		intake: { requests: [{ id: "request", title: "Keep this request" }], trouble: [] },
	};
	const op = { operationId: "op", itemId: "request", kind: "intake-start" };
	const before = calls.length;
	const checked = held();
	answers.set("day.intake.read", snapshot);
	answers.set("day.intake.start", () => {
		// The native journal has the operation, but TSX did not hear the outcome.
		answers.set("day.intake.read", { value: { snapshot, operations: [{ ...op, state: "unknown" }] } });
		throw null;
	});
	answers.set("day.intake.check", () => checked.promise);
	try {
		await feed.read();
		assert.equal(feed.view().fresh[0]?.revision, 3);
		assert.equal((await feed.start(intent)).status, "unknown");
		await feed.read();
		assert.equal(feed.view().unsettled[0]?.delivery, "checking");
		t.mock.timers.tick(0);
		assert.equal(calls.at(-1), "day.intake.check");
		assert.deepEqual(envelopes.at(-1), { version: 1, window: "window", args: { operationId: "op" } });
		const received = new Promise<void>((resolve) => {
			feed.onChange((view) => {
				if (view.started.some((o) => o.operationId === "op")) resolve();
			});
		});
		checked.resolve({
			value: {
				snapshot,
				operations: [{ ...op, state: "accepted", sessionId: "chat" }],
			},
		});
		await received;
		assert.equal(calls.slice(before).filter((name) => name === "day.intake.start").length, 1);
		assert.equal(feed.view().unsettled.length, 0);
	} finally {
		feed.dispose();
	}
});

test("closing and reopening the same chat drops the old read", async () => {
	const { ConnectedSessionChat } = await import("../sessionChat.ts");
	const feed = new ConnectedSessionChat("window");
	const last = held();
	answers.set("day.chat.read", () => last.promise);
	const old = feed.open("chat");
	feed.close("chat");
	answers.set("day.chat.read", { sessionId: "chat", title: "New read", state: "working", rows: [] });
	await feed.open("chat");
	last.resolve({ sessionId: "chat", title: "Old read", state: "failed", rows: [] });
	await old;
	assert.equal(feed.chat()?.title, "New read");
	feed.dispose();
});

test("a read requested from inside a publication queues one trailing read", async () => {
	const { coalesce } = await import("../source.ts");
	const gate = held();
	let calls = 0;
	let trailing: Promise<void> | undefined;
	const read = coalesce(
		async () => {
			if (++calls !== 1) return;
			trailing = read();
			assert.equal(read(), trailing);
			await gate.promise;
		},
		() => false,
	);
	const first = read();
	assert.equal(calls, 1);
	assert.equal(first, trailing);
	gate.resolve(null);
	await first;
	assert.equal(calls, 2);
});
