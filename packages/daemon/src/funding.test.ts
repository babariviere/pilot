import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Funding } from "./funding.ts";

const mission = { kind: "mission", id: "one", projectId: "project" } as const;
const quote = {
	provider: "fixture",
	model: "bounded",
	inputTokens: 100,
	outputTokens: 10,
	rate: { input: 1_000_000, output: 2_000_000, cacheRead: 100_000, cacheWrite: 2_000_000 },
};
async function fixture(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "funding-test-"));
	let now = 86_400_000 - 1;
	let funding = new Funding(join(dir, "funding.sqlite"), () => now);
	t.after(async () => {
		await funding.close();
		await rm(dir, { recursive: true, force: true });
	});
	return {
		get funding() {
			return funding;
		},
		tick() {
			now++;
		},
		async restart() {
			await funding.close();
			funding = new Funding(join(dir, "funding.sqlite"), () => now);
		},
		async fund(amount = 500) {
			await funding.fund(mission, (await funding.read()).revision, amount);
		},
	};
}
test("one mission lifetime includes planning, helpers and retry reservations exactly once after restart", async (t) => {
	const f = await fixture(t);
	await f.fund();
	const r = await f.funding.reserve(mission, "planning", quote, "planning");
	assert.equal(r.maximumMicros, 220);
	await f.funding.reserve(mission, "helper", quote, "helper");
	await assert.rejects(f.funding.reserve(mission, "retry", quote), /cannot fund/);
	await f.restart();
	assert.equal((await f.funding.read()).accounts[0]!.uncertainMicros, 440);
	await assert.rejects(f.funding.reserve(mission, "planning", quote), /never replay/);
	await f.funding.settle(mission, "planning", { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 });
	await f.funding.settle(mission, "planning", { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual((await f.funding.read()).accounts[0], {
		...mission,
		limitMicros: 500,
		spentMicros: 24,
		uncertainMicros: 220,
		remainingMicros: 256,
		heldMaximumMicros: 220,
	});
	await assert.rejects(
		f.funding.settle(mission, "planning", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }),
		/conflict/,
	);
	await f.funding.reserve(mission, "retry", quote, "retry");
});
test("concurrent requests share the same remaining allowance; changes never refill it", async (t) => {
	const f = await fixture(t);
	await f.fund(220);
	const results = await Promise.allSettled([
		f.funding.reserve(mission, "a", quote),
		f.funding.reserve(mission, "b", quote),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	const v = await f.funding.read();
	await f.funding.configure("project", v.revision, {
		missionDefaultMicros: 999,
		quickFixDefaultMicros: 50,
		dailyMicros: 100,
	});
	assert.equal((await f.funding.read()).accounts[0]!.remainingMicros, 0);
	await assert.rejects(f.funding.fund(mission, v.revision, 300), /changed/);
	await f.funding.fund(mission, (await f.funding.read()).revision, 440);
	assert.equal((await f.funding.read()).accounts[0]!.remainingMicros, 220);
});
test("daily background resets settled charges only; unknown charges survive midnight", async (t) => {
	const f = await fixture(t),
		owner = { kind: "background", id: "daily" } as const;
	await f.funding.configure(undefined, 0, {
		missionDefaultMicros: null,
		quickFixDefaultMicros: null,
		dailyMicros: 500,
	});
	await f.funding.reserve(owner, "lost", quote, "title");
	await f.funding.reserve(owner, "done", quote, "triage");
	await f.funding.settle(owner, "done", { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 });
	f.tick();
	await f.restart();
	const v = await f.funding.read();
	assert.equal(v.background.spentMicros, 0);
	assert.equal(v.background.uncertainMicros, 220);
	assert.equal(v.background.remainingMicros, 280);
	await f.funding.settle(owner, "lost", { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal((await f.funding.read()).background.remainingMicros, 500);
});
test("missing allowance/prices/bounds deny only affected requests and do not imply free usage", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.funding.reserve(mission, "none", quote), /Set an allowance/);
	await f.fund();
	await assert.rejects(f.funding.reserve(mission, "price", { ...quote, rate: { ...quote.rate, input: 0 } }), /prices/);
	await assert.rejects(f.funding.reserve(mission, "bound", { ...quote, outputTokens: NaN }), /bounds/);
	assert.equal((await f.funding.read()).accounts[0]!.remainingMicros, 500);
	await f.funding.reserve(mission, "lost", quote);
	await f.funding.settle(mission, "lost");
	assert.equal((await f.funding.read()).accounts[0]!.uncertainMicros, 220);
});

test("quick-fix creation recovery cannot refill its remainder and uses frozen tier/cache prices", async (t) => {
	const f = await fixture(t),
		owner = { kind: "quick_fix", id: "fix", projectId: "project" } as const;
	await f.funding.open(owner, 1000);
	const tiered = {
		...quote,
		tiers: [
			{
				inputTokensAbove: 50,
				rate: { input: 3_000_000, output: 4_000_000, cacheRead: 300_000, cacheWrite: 4_000_000 },
			},
		],
	};
	await f.funding.reserve(owner, "cached", tiered);
	await f.funding.settle(owner, "cached", { input: 10, output: 2, cacheRead: 0, cacheWrite: 20, cacheWrite1h: 20 });
	assert.equal((await f.funding.read()).accounts[0]!.spentMicros, 54);
	await f.restart();
	await f.funding.open(owner, 999_999);
	assert.equal((await f.funding.read()).accounts[0]!.limitMicros, 1000);
	assert.equal((await f.funding.read()).accounts[0]!.remainingMicros, 946);
	await f.funding.reserve(owner, "tier", tiered);
	await f.funding.settle(owner, "tier", { input: 60, output: 2, cacheRead: 0, cacheWrite: 0 });
	assert.equal((await f.funding.read()).accounts[0]!.spentMicros, 242);
});

test("provider overruns save the charge and hold only the affected physical model", async (t) => {
	const f = await fixture(t);
	await f.fund(1000);
	await f.funding.reserve(mission, "overrun", quote);
	await assert.rejects(
		f.funding.settle(mission, "overrun", { input: 101, output: 10, cacheRead: 0, cacheWrite: 0 }),
		/charge saved/,
	);
	assert.equal((await f.funding.read()).accounts[0]!.spentMicros, 121);
	await f.restart();
	await assert.rejects(f.funding.reserve(mission, "same-model", quote), /adapter needs correction/);
	await f.funding.reserve(mission, "other-model", { ...quote, model: "replacement" });
});

test("known unused cache classes may cost zero without making missing token prices free", async (t) => {
	const f = await fixture(t);
	await f.fund(1000);
	const q = { ...quote, rate: { ...quote.rate, cacheRead: 0, cacheWrite: 0 } };
	await f.funding.reserve(mission, "no-cache", q);
	await f.funding.settle(mission, "no-cache", { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
	assert.equal((await f.funding.read()).accounts[0]!.spentMicros, 14);
	await assert.rejects(
		f.funding.reserve(mission, "missing-input", { ...q, rate: { ...q.rate, input: 0 } }),
		/Catalog prices/,
	);
});
