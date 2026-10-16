import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CredentialClient, credentialEnvironment } from "@pilot/kernel/credential-client";
import { installCredentialBrokerHooks } from "@pilot/kernel/credential-hooks";
import type { SharedModelCatalog } from "@pilot/kernel/shared-model-catalog";
import { CredentialBroker } from "./credential-broker.ts";
import { ModelCatalog } from "./models.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-catalog-integration-")));
	const dir = join(root, "agent");
	await mkdir(dir);
	const definitions = {
		providers: {
			fixture: {
				api: "openai-completions",
				apiKey: "fixture-config-key",
				baseUrl: "https://example.invalid/v1",
				models: [
					{
						id: "small",
						name: "Small",
						reasoning: true,
						input: ["text"],
						contextWindow: 32000,
						maxTokens: 4096,
						cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
						headers: { Authorization: "model-header-secret" },
					},
					{ id: "large", contextWindow: 64000, maxTokens: 8192 },
				],
			},
		},
	};
	await writeFile(join(dir, "models.json"), JSON.stringify(definitions));
	const broker = new CredentialBroker(dir);
	await broker.start();
	const endpoint = broker.grant(true);
	const client = new CredentialClient(endpoint);
	const env = { ...credentialEnvironment(endpoint), PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1" };
	const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	await installCredentialBrokerHooks();
	t.after(async () => {
		for (const [key, value] of Object.entries(old)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await client.close();
		await broker.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		dir,
		broker,
		client,
		definitions,
		create: () => ModelRuntime.create({ modelsPath: join(dir, "models.json"), allowModelNetwork: false }),
	};
}

test("concurrent native startups share discovery and retain model transport locally", {
	timeout: 30_000,
}, async (t) => {
	const f = await fixture(t);
	const runtimes = await Promise.all(Array.from({ length: 12 }, f.create));
	// An initially missing models-store.json needs one offline stabilization pass, not one per worker.
	const discoveries = f.broker.catalog.stats.discoveries;
	assert.ok(discoveries <= 2);
	for (const runtime of runtimes) {
		assert.deepEqual(
			(await runtime.getAvailable("fixture")).map(({ id }) => id),
			["small", "large"],
		);
		assert.equal(
			(await runtime.getAuth(runtime.getModel("fixture", "small")!))?.auth.headers?.Authorization,
			"model-header-secret",
		);
	}
	assert.equal(f.broker.catalog.stats.discoveries, discoveries);
	const snapshot = (await f.client.request({ op: "catalog", namespace: "pi", value: {} })) as SharedModelCatalog;
	const serialized = JSON.stringify(snapshot);
	assert.ok(!serialized.includes("fixture-config-key"));
	assert.ok(!serialized.includes("model-header-secret"));
	const auth = await runtimes[0].getAuth(runtimes[0].getModel("fixture", "small")!);
	assert.equal(auth?.auth.apiKey, "fixture-config-key");
});

test("project scope and worker extensions, virtual routers and runtime keys remain independent", {
	timeout: 30_000,
}, async (t) => {
	const f = await fixture(t);
	const a = await f.create(),
		b = await f.create();
	const faux = fauxProvider();
	a.registerNativeProvider({
		...faux.provider,
		id: "fixture",
		getModels: () => [{ ...faux.provider.getModels()[0], provider: "fixture", id: "worker-a" }],
		getAllModels: undefined,
	});
	b.registerVirtualModel({
		provider: "fixture",
		id: "router",
		name: "Local router",
		route: () => ({ model: b.getModel("fixture", "small")!, thinkingLevel: "off" }),
	});
	assert.deepEqual(
		(await a.getAvailable("fixture")).map(({ id }) => id),
		["worker-a", "small", "large"],
	);
	assert.deepEqual(
		(await b.getAvailable("fixture")).map(({ id }) => id),
		["small", "large", "router"],
	);
	const route = await b.resolveModel(b.getModel("fixture", "router")!, [], { reason: "direct", thinkingLevel: "off" });
	assert.equal(route.model.id, "small");
	a.unregisterProvider("fixture");
	assert.deepEqual(
		(await a.getAvailable("fixture")).map(({ id }) => id),
		["small", "large"],
	);
	await a.setRuntimeApiKey("fixture", "only-a");
	assert.equal((await a.getAuth("fixture"))?.auth.apiKey, "only-a");
	assert.equal((await b.getAuth("fixture"))?.auth.apiKey, "fixture-config-key");
	await a.removeRuntimeApiKey("fixture");
	assert.equal((await a.getAuth("fixture"))?.auth.apiKey, "fixture-config-key");
	const project = join(f.root, "project");
	await mkdir(join(project, ".pi"), { recursive: true });
	await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["fixture/small:high"] }));
	const catalog = new ModelCatalog(f.dir);
	assert.deepEqual(
		(await catalog.list(project)).models.map(({ id }) => id),
		["fixture/small"],
	);
	await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["fixture/large"] }));
	assert.deepEqual(
		(await catalog.list(project)).models.map(({ id }) => id),
		["fixture/large"],
	);
});

test("edits, broker login/logout fences and failures become visible to existing runtimes", {
	timeout: 30_000,
}, async (t) => {
	const f = await fixture(t);
	const runtime = await f.create();
	const definitions = JSON.parse(await readFile(join(f.dir, "models.json"), "utf8"));
	delete definitions.providers.fixture.apiKey;
	await writeFile(join(f.dir, "models.json"), JSON.stringify(definitions));
	assert.deepEqual(await runtime.getAvailable("fixture"), []);
	await f.client.transaction("pi", "fixture", "login", () =>
		f.client.pi.modify("fixture", async () => ({ type: "api_key", key: "logged-in-key" })),
	);
	assert.equal((await runtime.getAvailable("fixture")).length, 2);
	await runtime.logout("fixture");
	assert.deepEqual(await runtime.getAvailable("fixture"), []);
	await writeFile(join(f.dir, "models.json"), "malformed");
	// The SDK retains its error policy for a malformed config, then can reload the repaired file.
	await runtime.getAvailable("fixture");
	await writeFile(join(f.dir, "models.json"), JSON.stringify(f.definitions));
	assert.equal((await runtime.getAvailable("fixture")).length, 2);
	const scoped = new CredentialClient(f.broker.grant(true, { namespace: "pi", key: "fixture" }));
	await assert.rejects(scoped.request({ op: "catalog", namespace: "pi", value: {} }), /unauthorized|invalid/);
	await scoped.close();
	await assert.rejects(
		f.client.request({ op: "catalog", namespace: "pi", value: { command: "forbidden" } }),
		/invalid/,
	);
});

test("canceled native startup does not cancel the shared discovery or another startup", {
	timeout: 15_000,
}, async (t) => {
	const f = await fixture(t);
	const started = deferred(),
		release = deferred();
	t.after(() => release.resolve());
	const read = f.broker.catalog.read.bind(f.broker.catalog);
	t.mock.method(f.broker.catalog, "read", async (...args: Parameters<typeof read>) => {
		started.resolve();
		await release.promise;
		return read(...args);
	});
	const controller = new AbortController();
	const canceled = ModelRuntime.create({ modelsPath: join(f.dir, "models.json"), signal: controller.signal });
	const rejected = assert.rejects(canceled, /caller canceled/);
	const remaining = f.create();
	await started.promise;
	controller.abort(new Error("caller canceled"));
	await rejected;
	release.resolve();
	const runtime = await remaining;
	assert.equal((await runtime.getAvailable("fixture")).length, 2);
	assert.ok(f.broker.catalog.stats.discoveries <= 2);
});

test("a held discovery does not serialize an independent model request", { timeout: 15_000 }, async (t) => {
	const f = await fixture(t);
	const runtime = await f.create();
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("ok")]);
	runtime.registerNativeProvider(faux.provider);
	const model = (await runtime.getAvailable("faux"))[0];
	assert.ok(model);
	const started = deferred(),
		release = deferred();
	t.after(() => release.resolve());
	const read = f.broker.catalog.read.bind(f.broker.catalog);
	t.mock.method(f.broker.catalog, "read", async (...args: Parameters<typeof read>) => {
		started.resolve();
		await release.promise;
		return read(...args);
	});
	const blocked = runtime.refresh({ force: true, allowNetwork: false });
	try {
		await started.promise;
		const response = await runtime.completeSimple(
			model,
			{
				messages: [{ role: "user", content: "offline", timestamp: 0 }],
			},
			{ maxRetries: 0, signal: AbortSignal.timeout(3000) },
		);
		assert.equal(response.stopReason, "stop", response.errorMessage);
	} finally {
		release.resolve();
		await blocked;
	}
});

test("classifier and image choices retain their operation types", { timeout: 15_000 }, async (t) => {
	const f = await fixture(t);
	const definitions = JSON.parse(JSON.stringify(f.definitions));
	definitions.providers.openai = { apiKey: "offline-openai-key" };
	definitions.providers.openrouter = { apiKey: "offline-openrouter-key" };
	await writeFile(join(f.dir, "models.json"), JSON.stringify(definitions));
	const runtime = await f.create();
	for (const [type, provider] of [
		["classifier", "openai"],
		["image", "openrouter"],
	] as const) {
		const expected = runtime.getModelsOfType(type, provider);
		assert.ok(expected.length > 0);
		assert.deepEqual(await runtime.getAvailableOfType(type, provider), expected);
	}
});

test("separate host authorities with identical model IDs retain independent credentials", {
	timeout: 15_000,
}, async (t) => {
	const a = await fixture(t);
	const runtimeA = await a.create();
	const dirB = join(a.root, "other-host");
	await mkdir(dirB);
	const definitions = JSON.parse(JSON.stringify(a.definitions));
	definitions.providers.fixture.apiKey = "other-host-key";
	await writeFile(join(dirB, "models.json"), JSON.stringify(definitions));
	const brokerB = new CredentialBroker(dirB);
	await brokerB.start();
	t.after(() => brokerB.close());
	Object.assign(process.env, credentialEnvironment(brokerB.grant()), { PI_CODING_AGENT_DIR: dirB });
	const runtimeB = await ModelRuntime.create({ modelsPath: join(dirB, "models.json") });
	assert.equal((await runtimeA.getAuth("fixture"))?.auth.apiKey, "fixture-config-key");
	assert.equal((await runtimeB.getAuth("fixture"))?.auth.apiKey, "other-host-key");
	assert.equal((await runtimeA.getAvailable("fixture")).length, 2);
	assert.equal((await runtimeB.getAvailable("fixture")).length, 2);
});
