import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	modelProvider,
	parseUsageCache,
	type SubscriptionProvider,
	SubscriptionUsageCache,
	subscriptionProvider,
} from "./subscription-usage.ts";

async function writeUsageCache(agentDir: string, provider: SubscriptionProvider, entry: unknown): Promise<void> {
	const dir = join(agentDir, "cache", "usage-status", provider);
	await mkdir(dir, { recursive: true });
	// Like the extension: atomic replace, with a distinct mtime for each write.
	const temp = join(dir, `cache.json.${Math.random()}.tmp`);
	await writeFile(temp, typeof entry === "string" ? entry : JSON.stringify(entry));
	await rename(temp, join(dir, "cache.json"));
}

async function agentDir(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pilot-usage-cache-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("maps concrete pi providers to subscription accounts", () => {
	assert.equal(subscriptionProvider("anthropic"), "anthropic");
	assert.equal(subscriptionProvider("openai-codex"), "openai");
	assert.equal(subscriptionProvider("openai"), undefined, "API-key providers have no subscription windows");
	assert.equal(subscriptionProvider(undefined), undefined);
	assert.equal(modelProvider("openai-codex/gpt-5"), "openai-codex");
	assert.equal(modelProvider("bare"), undefined);
	assert.equal(modelProvider(undefined), undefined);
});

test("validates cache entries and forwards only display fields", () => {
	for (const provider of ["anthropic", "openai"] as const) {
		assert.deepEqual(
			parseUsageCache(
				{
					fetchedAt: 123,
					secret: "never-forward",
					snapshot: {
						provider,
						token: "never-forward",
						windows: [{ label: "5h", usedPercent: 22.5, resetsAt: "2026-04-01T12:00:00Z", secret: "no" }],
					},
				},
				provider,
			),
			{ fetchedAt: 123, provider, windows: [{ label: "5h", usedPercent: 22.5, resetsAt: "2026-04-01T12:00:00Z" }] },
		);
	}
	assert.deepEqual(parseUsageCache({ fetchedAt: 123, snapshot: { windows: [] } }, "openai"), {
		fetchedAt: 123,
		provider: "openai",
		windows: [],
	});
	for (const data of [
		null,
		{},
		{ fetchedAt: Number.NaN, snapshot: { windows: [] } },
		{ fetchedAt: 1, snapshot: { windows: [{ label: "5h", usedPercent: Number.POSITIVE_INFINITY }] } },
		{ fetchedAt: 1, snapshot: { windows: [{ label: "5h", usedPercent: -1 }] } },
		{ fetchedAt: 1, snapshot: { windows: [{ label: "5h", usedPercent: 1, resetsAt: 10 }] } },
		{ fetchedAt: 1, snapshot: { windows: [], provider: "anthropic" } },
		{ fetchedAt: 1, snapshot: { windows: [], error: 5 } },
	])
		assert.equal(parseUsageCache(data, "openai"), undefined);
});

test("reads pi's shared usage cache and reports only real changes", async (t) => {
	const dir = await agentDir(t);
	const changes: SubscriptionProvider[] = [];
	const cache = new SubscriptionUsageCache((provider) => changes.push(provider), {
		agentDir: dir,
		intervalMs: 60_000,
	});
	t.after(() => cache.close());
	await cache.start();
	assert.equal(cache.get("anthropic"), undefined);
	assert.deepEqual(changes, []);

	const entry = { fetchedAt: 10, snapshot: { provider: "anthropic", windows: [{ label: "5h", usedPercent: 40 }] } };
	await writeUsageCache(dir, "anthropic", entry);
	await cache.refresh();
	assert.deepEqual(cache.get("anthropic"), { fetchedAt: 10, provider: "anthropic", windows: entry.snapshot.windows });
	assert.deepEqual(changes, ["anthropic"]);
	cache.get("anthropic")!.windows[0]!.usedPercent = 99;
	assert.equal(cache.get("anthropic")?.windows[0]?.usedPercent, 40, "callers receive copies");

	await writeUsageCache(dir, "anthropic", entry);
	await cache.refresh();
	assert.deepEqual(changes, ["anthropic"], "rewriting identical data is not a change");

	await writeUsageCache(dir, "anthropic", "{ partial");
	await cache.refresh();
	assert.equal(cache.get("anthropic")?.fetchedAt, 10, "a bad read keeps the last good snapshot");
	assert.deepEqual(changes, ["anthropic"]);

	await rm(join(dir, "cache", "usage-status", "anthropic", "cache.json"));
	await cache.refresh();
	assert.equal(cache.get("anthropic"), undefined, "a removed cache is no longer reported");
	assert.deepEqual(changes, ["anthropic", "anthropic"]);
});
