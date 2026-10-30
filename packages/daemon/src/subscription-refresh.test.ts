import assert from "node:assert/strict";
import { test } from "node:test";
import { SubscriptionRefresh } from "./subscription-refresh.ts";

test("app refresh coalesces callers, keeps provider provenance and last report on errors", async () => {
	let release!: () => void;
	let fail = false;
	let calls = 0;
	const service = new SubscriptionRefresh(async (provider) => {
		calls++;
		await new Promise<void>((done) => {
			release = done;
		});
		if (fail) throw new Error("private account details");
		return {
			outcome: "refreshed",
			usage: { provider, fetchedAt: 1000, windows: [{ label: "5h", usedPercent: 97 }] },
		};
	});
	assert.equal(service.snapshot().providers[0]!.usage, undefined);
	const first = service.refresh("anthropic"),
		duplicate = service.refresh("anthropic");
	assert.equal(calls, 1);
	assert.equal(service.snapshot().providers[0]!.state, "refreshing");
	release();
	assert.deepEqual(await first, await duplicate);
	const good = service.snapshot().providers[0]!;
	assert.equal(good.state, "refreshed");
	assert.equal(good.usage!.fetchedAt, 1000);
	assert.equal(good.account, "not_reported");
	fail = true;
	const failed = service.refresh("anthropic");
	release();
	await failed;
	const last = service.snapshot().providers[0]!;
	assert.equal(last.state, "error");
	assert.deepEqual(last.usage, good.usage);
	assert.doesNotMatch(JSON.stringify(last), /private account/);
	assert.equal(service.snapshot().providers[1]!.state, "idle");
});

test("foreign provider and missing report never become a successful quota refresh", async () => {
	const foreign = new SubscriptionRefresh(async () => ({
		outcome: "refreshed",
		usage: { provider: "openai", fetchedAt: 1000, windows: [] },
	}));
	assert.equal((await foreign.refresh("anthropic")).state, "error");
	assert.equal(foreign.snapshot().providers[0]!.usage, undefined);
	const missing = new SubscriptionRefresh(async () => ({ outcome: "refreshed" }));
	assert.equal((await missing.refresh("openai")).state, "error");
});
