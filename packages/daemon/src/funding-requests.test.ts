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
