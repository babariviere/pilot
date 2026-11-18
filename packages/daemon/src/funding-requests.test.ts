import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { CredentialClient, credentialEnvironment } from "@pilot/kernel/credential-client";
import { CredentialBroker } from "./credential-broker.ts";
import { Funding } from "./funding.ts";
import { fundingRequests } from "./funding-requests.ts";

test("authenticated parent/helper capabilities share host-owned prices and scopes; unscoped clients cannot reserve", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "funding-requests-")));
	await writeFile(join(home, "auth.json"), "{}", { mode: 0o600 });
	const broker = new CredentialBroker(home),
		funding = new Funding(join(home, "funding.sqlite"));
	t.after(async () => {
		await broker.close();
		await funding.close();
		await rm(home, { recursive: true, force: true });
	});
	await broker.start();
	const owner = { kind: "mission", id: "mission", projectId: "project" } as const;
	const fake = fauxProvider({
		provider: "fixture",
		models: [
			{
				id: "bounded",
				contextWindow: 100,
				maxTokens: 10,
				cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
			},
		],
	});
	let current = true;
	const handle = fundingRequests(funding, { fundingModel: async () => fake.getModel() }, () => {
		if (!current) throw new Error("Owner revoked");
		return owner;
	});
	broker.fundingRequest = (binding, request) => handle(typeof binding === "string" ? binding : "background", request);
	const endpoint = broker.grant(false, undefined, "parent"),
		client = new CredentialClient(endpoint),
		helper = new CredentialClient(endpoint);
	t.after(async () => {
		await client.close();
		await helper.close();
	});
	assert.equal(credentialEnvironment(endpoint).PILOT_FUNDING_REQUIRED, "1");
	const request = {
		op: "funding-reserve",
		namespace: "pi",
		key: "first",
		value: { provider: "fixture", model: "bounded", api: fake.getModel().api, outputTokens: 10, rate: { input: 0 } },
	} as const;
	await assert.rejects(client.request(request), /Allowance hold/);
	await funding.open(owner, 220);
	await client.request(request);
	await assert.rejects(helper.request({ ...request, key: "second" }), /Allowance hold/);
	await assert.rejects(new CredentialClient(broker.grant()).request({ ...request, key: "unscoped" }), /unauthorized/);
	await helper.request({
		op: "funding-settle",
		namespace: "pi",
		key: "first",
		value: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
	});
	assert.equal((await funding.read()).accounts[0]!.spentMicros, 14);
	await assert.rejects(client.request(request), /Allowance hold/);
	await funding.fund(owner, (await funding.read()).revision, 1000);
	const reserve = funding.reserve.bind(funding);
	t.mock.method(funding, "reserve", async (...args: Parameters<Funding["reserve"]>) => {
		const value = await reserve(...args);
		current = false;
		return value;
	});
	await assert.rejects(client.request({ ...request, key: "revoked-during-reserve" }), /Allowance hold/);
	assert.equal(
		(await funding.read()).accounts[0]!.uncertainMicros,
		220,
		"a lost authority after durable reservation never dispatches or refunds",
	);
});

test("limits off let requests through without prices or an allowance, and the switch persists", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "funding-off-")));
	let funding = new Funding(join(home, "funding.sqlite"));
	t.after(async () => {
		await funding.close();
		await rm(home, { recursive: true, force: true });
	});
	const owner = { kind: "quick_fix", id: "chat", projectId: "project" } as const;
	let lookups = 0;
	const handle = (f: Funding) =>
		fundingRequests(
			f,
			{
				fundingModel: async () => {
					lookups++;
					return undefined;
				},
			},
			() => owner,
		);
	const reserve = {
		op: "funding-reserve",
		namespace: "pi",
		key: "off-1",
		value: { provider: "x", model: "y", api: "z", outputTokens: 10 },
	} as const;
	assert.equal(await funding.enabled(), true);
	await assert.rejects(handle(funding)("chat", reserve), /Physical model bound unavailable/);
	await assert.rejects(funding.setEnabled(99, false), /Funding changed/);
	await funding.setEnabled((await funding.read()).revision, false);
	assert.equal((await funding.read()).enabled, false);
	lookups = 0;
	assert.deepEqual(await handle(funding)("chat", reserve), { id: "off-1", maximumMicros: 0 });
	await handle(funding)("chat", { op: "funding-settle", namespace: "pi", key: "off-1", value: {} });
	assert.equal(lookups, 0, "no catalog price is needed while limits are off");
	assert.deepEqual((await funding.read()).accounts, []);
	assert.equal((await funding.read()).background.spentMicros, 0);
	// Saved on disk, not only in memory.
	await funding.close();
	funding = new Funding(join(home, "funding.sqlite"));
	assert.equal(await funding.enabled(), false);
	await funding.setEnabled((await funding.read()).revision, true);
	assert.equal(await funding.enabled(), true);
	await assert.rejects(handle(funding)("chat", { ...reserve, key: "on-1" }), /Physical model bound unavailable/);
});

test("Codex reservations price the canonical model output maximum; capped APIs price the request cap", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "funding-codex-")));
	const funding = new Funding(join(home, "funding.sqlite"));
	t.after(async () => {
		await funding.close();
		await rm(home, { recursive: true, force: true });
	});
	const owner = { kind: "quick_fix", id: "chat", projectId: "project" } as const;
	await funding.open(owner, 1000);
	const base = fauxProvider({
		provider: "fixture",
		models: [
			{ id: "m", contextWindow: 100, maxTokens: 10, cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } },
		],
	}).getModel();
	const reserve = async (api: string, key: string, outputTokens: number) =>
		(await fundingRequests(
			funding,
			{ fundingModel: async () => ({ ...base, api }) },
			() => owner,
		)("chat", {
			op: "funding-reserve",
			namespace: "pi",
			key,
			value: { provider: "fixture", model: "m", api, outputTokens },
		})) as { maximumMicros: number };
	// Input 100 tokens at twice the input rate, plus output tokens at 2 micros each.
	assert.equal((await reserve("openai-responses", "capped", 4)).maximumMicros, 208);
	assert.equal((await reserve("openai-codex-responses", "codex", 4)).maximumMicros, 220);
	await assert.rejects(reserve("openai-codex-responses", "too-large", 11), /Physical model bound unavailable/);
});

test("limits off let uncapped requests through; limits on hold only the unbounded pay-per-token one", async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "funding-uncapped-")));
	const funding = new Funding(join(home, "funding.sqlite"));
	t.after(async () => {
		await funding.close();
		await rm(home, { recursive: true, force: true });
	});
	const owner = { kind: "quick_fix", id: "chat", projectId: "project" } as const;
	const base = fauxProvider({
		provider: "fixture",
		models: [
			{ id: "m", contextWindow: 100, maxTokens: 10, cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } },
		],
	}).getModel();
	const hold = "Allowance hold: this provider request has no verified output bound";
	const reserve = (api: string, key: string, bound: { outputTokens: number } | { hold: string }) =>
		fundingRequests(
			funding,
			{ fundingModel: async () => ({ ...base, api }) },
			() => owner,
		)("chat", {
			op: "funding-reserve",
			namespace: "pi",
			key,
			value: { provider: "fixture", model: "m", api, ...bound },
		});
	await funding.setEnabled((await funding.read()).revision, false);
	assert.deepEqual(await reserve("openai-codex-responses", "codex-off", { outputTokens: 10 }), {
		id: "codex-off",
		maximumMicros: 0,
	});
	assert.deepEqual(await reserve("google-generative-ai", "google-off", { hold }), {
		id: "google-off",
		maximumMicros: 0,
	});
	assert.deepEqual((await funding.read()).accounts, [], "no reservation while limits are off");
	await funding.setEnabled((await funding.read()).revision, true);
	await funding.open(owner, 1000);
	await assert.rejects(reserve("google-generative-ai", "google-on", { hold }), /no verified output bound/);
	await assert.rejects(
		reserve("openai-responses", "forged", { hold: "anything" }),
		/^Error: Allowance hold: request bound unavailable$/,
	);
	assert.equal(
		((await reserve("openai-codex-responses", "codex-on", { outputTokens: 10 })) as { maximumMicros: number })
			.maximumMicros,
		220,
	);
});
