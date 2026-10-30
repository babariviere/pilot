import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { refreshSubscription, type UsageSource } from "./subscription-refresh.ts";

test("subscription refresh uses only canonical OAuth and preserves the cache's response time", async () => {
	let calls = 0;
	let entry = {
		fetchedAt: 1000,
		snapshot: { provider: "openai" as const, windows: [{ label: "5h", usedPercent: 40 }] },
	};
	const source: UsageSource = {
		readCache: () => entry,
		fetchWithCache: async (provider, token, directory) => {
			assert.equal(provider, "openai");
			assert.equal(token, "fake-oauth");
			assert.equal(directory, "/fake-agent");
			calls++;
			if (calls === 1) entry = { ...entry, fetchedAt: 2000 };
			return entry.snapshot;
		},
	};
	const runtime = {
		listCredentials: async () => [{ providerId: "openai-codex", type: "oauth" as const }],
		getAuth: async () => ({ auth: { apiKey: "fake-oauth" } }),
	};
	assert.deepEqual(await refreshSubscription("openai", "/fake-agent", runtime, source), {
		outcome: "refreshed",
		usage: { ...entry.snapshot, fetchedAt: 2000 },
	});
	assert.equal((await refreshSubscription("openai", "/fake-agent", runtime, source)).outcome, "cached");
	source.fetchWithCache = async () => undefined;
	assert.deepEqual(await refreshSubscription("openai", "/fake-agent", runtime, source), {
		outcome: "deferred",
		usage: { ...entry.snapshot, provider: "openai", fetchedAt: 2000 },
	});
});

test("missing/API-key credentials never resolve auth, fall back to other stores, or fetch", async () => {
	for (const credentials of [[], [{ providerId: "anthropic", type: "api_key" as const }]]) {
		const runtime = {
			listCredentials: async () => credentials,
			getAuth: async () => assert.fail("must not resolve API-key commands"),
		};
		const source: UsageSource = {
			readCache: () => assert.fail("no account cache without OAuth"),
			fetchWithCache: async () => assert.fail("no provider request"),
		};
		assert.deepEqual(await refreshSubscription("anthropic", "/fake-agent", runtime, source), {
			outcome: "unavailable",
		});
	}
});

test("pinned usage collector fetches fake responses, shares its one-minute cache and honors backoff", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "quota-collector-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const requests: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string | URL) => {
		requests.push(String(url));
		if (String(url) === "https://chatgpt.com/backend-api/wham/usage")
			return new Response(
				JSON.stringify({
					rate_limit: { primary_window: { used_percent: 37, limit_window_seconds: 18000, reset_at: 1900000000 } },
				}),
			);
		assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage");
		return new Response("private provider error", { status: 429, headers: { "retry-after": "60" } });
	});
	const runtime = {
		listCredentials: async () => [
			{ providerId: "openai-codex", type: "oauth" as const },
			{ providerId: "anthropic", type: "oauth" as const },
		],
		getAuth: async (id: unknown) => ({ auth: { apiKey: id === "anthropic" ? "sk-ant-oat-fake-only" : "fake-only" } }),
	};
	const first = await refreshSubscription("openai", dir, runtime);
	assert.equal(first.outcome, "refreshed");
	assert.equal(first.usage!.windows[0]!.usedPercent, 37);
	const cached = await refreshSubscription("openai", dir, runtime);
	assert.equal(cached.outcome, "cached");
	assert.equal(cached.usage!.fetchedAt, first.usage!.fetchedAt);
	assert.deepEqual(await refreshSubscription("anthropic", dir, runtime), { outcome: "deferred" });
	assert.deepEqual(await refreshSubscription("anthropic", dir, runtime), { outcome: "deferred" });
	assert.equal(requests.length, 2, "cached values and backoff never become duplicate provider requests");
});
