import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createModels, type ModelsRefreshOptions } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { SharedModelCatalog } from "@pilot/kernel/shared-model-catalog";
import { SharedCatalogService } from "./shared-model-catalog.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function fixture(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "pilot-shared-catalog-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const options: ModelsRefreshOptions[] = [];
	let work = async () => {};
	let creations = 0;
	const service = new SharedCatalogService(dir, async () => {
		creations++;
		return {
			getAllModels: models.getAllModels.bind(models),
			getAllAvailable: models.getAllAvailable.bind(models),
			getProviders: models.getProviders.bind(models),
			checkAuth: models.checkAuth.bind(models),
			refresh: async (args = {}) => {
				options.push(args);
				await work();
				return { errors: new Map(), aborted: false };
			},
		};
	});
	t.after(async () => {
		await service.close();
		await rm(dir, { recursive: true, force: true });
	});
	return {
		dir,
		service,
		models,
		faux,
		options,
		creations: () => creations,
		work: (next: () => Promise<void>) => {
			work = next;
		},
	};
}
const value = (frame: string) => (JSON.parse(frame) as { value: SharedModelCatalog }).value;

test("many callers share a daemon discovery, settled snapshots and compact revision replies", async (t) => {
	const f = await fixture(t);
	const gate = deferred();
	t.after(() => gate.resolve());
	f.work(() => gate.promise);
	const requests = Array.from({ length: 24 }, () => f.service.read());
	gate.resolve();
	const frames = await Promise.all(requests);
	assert.equal(new Set(frames).size, 1);
	assert.equal(f.creations(), 1);
	assert.equal(f.service.stats.discoveries, 1);
	assert.equal(await f.service.read(), frames[0]);
	assert.deepEqual(JSON.parse(await f.service.reply({}, value(frames[0]).revision)).value, { unchanged: true });
	assert.deepEqual(value(frames[0]).providers[0].available, ["chat/faux-1"]);
});

test("one canceled caller and a failed discovery neither cancel other callers nor poison recovery", async (t) => {
	const f = await fixture(t);
	const started = deferred(),
		release = deferred();
	t.after(() => release.resolve());
	f.work(async () => {
		started.resolve();
		await release.promise;
	});
	const canceled = new AbortController();
	const a = f.service.read({}, canceled.signal),
		b = f.service.read();
	const rejected = assert.rejects(a, /caller left/);
	await started.promise;
	canceled.abort(new Error("caller left"));
	await rejected;
	release.resolve();
	await b;
	assert.equal(f.service.stats.discoveries, 1);
	f.work(async () => {
		throw new Error("source unavailable");
	});
	await assert.rejects(f.service.read({ force: true }), /source unavailable/);
	f.work(async () => {});
	await f.service.read({ force: true });
	assert.equal(f.service.stats.discoveries, 3);
});

test("definitions, store, credentials and broker fences invalidate without restarting", async (t) => {
	const f = await fixture(t);
	let revision = value(await f.service.read()).revision;
	for (const name of ["models.json", "models-store.json", "auth.json", ".pilot-credential-journal.json"]) {
		await writeFile(join(f.dir, name), "{}");
		const next = value(await f.service.read()).revision;
		assert.notEqual(next, revision, name);
		revision = next;
		await rm(join(f.dir, name));
		revision = value(await f.service.read()).revision;
	}
	assert.equal(f.service.stats.discoveries, 9);
});

test("a config edit during discovery cannot publish the old generation", async (t) => {
	const f = await fixture(t);
	let passes = 0;
	f.work(async () => {
		if (++passes === 1) await writeFile(join(f.dir, "auth.json"), "{}");
	});
	await f.service.read();
	assert.equal(passes, 2);
	await f.service.read();
	assert.equal(passes, 2);
});

test("TTL and explicit force/network/provider boundaries retain their discovery policies", async (t) => {
	const f = await fixture(t);
	t.mock.timers.enable({ apis: ["Date"], now: 1000 });
	await f.service.read();
	t.mock.timers.tick(5 * 60_000);
	await f.service.read();
	await Promise.all([f.service.read({ force: true }), f.service.read({ force: true })]);
	await f.service.read({ allowNetwork: true, providers: ["faux"] });
	assert.equal(f.service.stats.discoveries, 4);
	assert.equal(f.options.at(-1)?.allowNetwork, true);
	assert.deepEqual(f.options.at(-1)?.providers, ["faux"]);
	await f.service.read({ providers: [] });
	await f.service.read();
	assert.equal(f.service.stats.discoveries, 6, "an empty provider selection is not an all-provider refresh");
});

test("snapshots omit secrets, request configuration and unsafe endpoints; auth comes from SDK checks", async (t) => {
	const f = await fixture(t);
	const original = f.faux.provider.getModels()[0];
	f.models.setProvider({
		...f.faux.provider,
		getAllModels: () => [
			{
				...original,
				headers: { Authorization: "header-secret" },
				samplingParams: { secret: "sampling-secret" },
			},
		],
	});
	const frame = await f.service.read();
	assert.ok(!frame.includes("header-secret"));
	assert.ok(!frame.includes("sampling-secret"));
	await writeFile(join(f.dir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "unused-secret" } }));
	f.models.setProvider({
		...f.faux.provider,
		auth: { apiKey: { name: "Unconfigured", resolve: async () => undefined } },
	});
	assert.deepEqual(value(await f.service.read()).providers[0].available, []);
	f.models.setProvider({
		...f.faux.provider,
		getAllModels: () => [{ ...original, baseUrl: "https://example.invalid/?token=endpoint-secret" }],
	});
	const local = await f.service.read({ force: true });
	assert.ok(!local.includes("endpoint-secret"));
	assert.ok(!local.includes("baseUrl"));
	assert.equal(value(local).providers[0].local, true);
});

test("host owners are independent and failed creation is retried", async (t) => {
	const a = await fixture(t),
		b = await fixture(t);
	const gate = deferred();
	t.after(() => gate.resolve());
	a.work(() => gate.promise);
	const pending = a.service.read();
	await b.service.read();
	gate.resolve();
	await pending;
	let attempts = 0;
	const recovering = new SharedCatalogService(a.dir, async () => {
		attempts++;
		throw new Error("create failed");
	});
	await assert.rejects(recovering.read(), /create failed/);
	await assert.rejects(recovering.read(), /create failed/);
	assert.equal(attempts, 2);
	await recovering.close();
});

test("refreshed metadata uses local transport references, and new private transport stays local", async (t) => {
	const f = await fixture(t);
	const original = f.faux.provider.getModels()[0];
	f.work(async () => {
		const refreshed = { ...original, id: "new-model", name: "New model", contextWindow: 123456 };
		f.models.setProvider({ ...f.faux.provider, getModels: () => [refreshed], getAllModels: () => [refreshed] });
	});
	const entry = value(await f.service.read()).providers[0];
	assert.equal(entry.models[0].model.id, "new-model");
	assert.equal(entry.models[0].transport, "chat/faux-1");
	assert.equal("baseUrl" in entry.models[0].model, false);
	assert.deepEqual(entry.available, ["chat/new-model"]);
	f.work(async () => {
		const refreshed = { ...original, id: "private-model", headers: { Authorization: "private-request-secret" } };
		f.models.setProvider({ ...f.faux.provider, getModels: () => [refreshed], getAllModels: () => [refreshed] });
	});
	const privateFrame = await f.service.read({ force: true });
	const privateEntry = value(privateFrame).providers[0];
	assert.equal(privateEntry.local, true);
	assert.deepEqual(privateEntry.available, ["chat/private-model"]);
	assert.ok(!privateFrame.includes("private-request-secret"));
});

test("pending discovery policies are bounded and queue pressure does not poison later requests", {
	timeout: 5000,
}, async (t) => {
	const f = await fixture(t);
	const gate = deferred();
	t.after(() => gate.resolve());
	f.work(() => gate.promise);
	const pending = Array.from({ length: 9 }, (_, i) => f.service.read({ providers: [String(i)] }));
	const settled = Promise.allSettled(pending);
	// Filesystem signature reads may finish out of order. Observe whichever policy hits the cap,
	// rather than assuming that the ninth invocation is the ninth admission.
	const rejected = await Promise.race(
		pending.map((operation) =>
			operation.then(
				() => undefined,
				(error: Error) => error,
			),
		),
	);
	assert.match(rejected?.message ?? "", /busy/);
	gate.resolve();
	assert.equal((await settled).filter((result) => result.status === "rejected").length, 1);
	await f.service.read();
	assert.equal(f.service.stats.pending, 0);
});
