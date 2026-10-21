import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Worker } from "node:worker_threads";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { UsageObservation } from "@pilot/protocol";
import {
	BACKGROUND_USAGE_LIMIT,
	BackgroundUsage,
	backgroundEvidence,
	type CompletionRuntime,
} from "./background-usage.ts";
import { compactMemory } from "./memory-compaction.ts";
import { MemoryDisk } from "./memory-disk.ts";
import { generateChatTitle, ModelCatalog } from "./models.ts";
import { requiredAuthRegistration } from "./testing/required-auth.ts";
import { parseGuide, workerTriage } from "./triage-grooming.ts";
import { UsageHistoryStore } from "./usage-history.ts";

const faux = fauxProvider({ models: [{ id: "small", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } }] });
const model = faux.getModel();
const context = { messages: [] };
function response(text = "private completion", stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		...fauxAssistantMessage(text),
		provider: model.provider,
		model: model.id,
		stopReason,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 3,
			cacheWrite: 2,
			reasoning: 2,
			totalTokens: 20,
			cost: { input: 0.00001, output: 0.00001, cacheRead: 0.000001, cacheWrite: 0.000002, total: 0.000023 },
		},
	};
}
async function fixture(t: TestContext) {
	t.mock.method(globalThis, "fetch", () => {
		throw new Error("Background accounting fixtures must stay offline");
	});
	const home = await mkdtemp(join(tmpdir(), "background-usage-"));
	const store = new UsageHistoryStore(home);
	const usage = new BackgroundUsage(home, store);
	await usage.ready();
	t.after(async () => {
		await usage.close();
		await store.close();
		await rm(home, { recursive: true, force: true });
	});
	const page = async (kind: "request" | "checkpoint" = "request") =>
		(await store.page({ kind, from: Date.now() - 60_000, to: Date.now() + 60_000 })).rows;
	return { home, store, usage, page, directory: join(home, "accounting", "background-pending") };
}

test("shared completion boundary captures success/errors/cancellation before consumers inspect output", async (t) => {
	const f = await fixture(t);
	const projectId = randomUUID(),
		chatId = randomUUID();
	const mission = { homeId: randomUUID(), lineageId: randomUUID(), missionId: randomUUID() };
	for (const stop of ["stop", "error", "aborted"] as const) {
		const runtime = f.usage.runtime({ completeSimple: async () => response("private output", stop) }, "title", {
			projectId,
			chatId,
			mission,
		});
		await runtime.completeSimple(model, context);
	}
	const rows = await f.page();
	assert.equal(rows.length, 3);
	assert.deepEqual(new Set(rows.map((r) => r.outcome)), new Set(["success", "failure", "cancelled"]));
	for (const row of rows) {
		assert.equal(row.tokens?.input, 10);
		assert.equal(row.tokens?.reasoning, 2);
		assert.equal(row.cost?.estimatedUsdMicros, 23);
		assert.deepEqual(row.attribution, { projectId, chatId, mission });
		assert.deepEqual(row.physicalModel, { provider: model.provider, model: model.id });
		assert.equal(row.coverage, "partial");
	}
	assert.deepEqual(await readdir(f.directory), []);
	assert.equal((await stat(join(f.home, "accounting"))).mode & 0o777, 0o700);
	assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
});

test("real faux runtime capture preserves usage and provider dispatch", async (t) => {
	const f = await fixture(t);
	const runtime = await ModelRuntime.create({
		authPath: join(f.home, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const provider = fauxProvider();
	provider.setResponses([response("hello")]);
	runtime.registerNativeProvider(provider.provider);
	const result = await f.usage.runtime(runtime, "other").completeSimple(provider.getModel(), context);
	const rows = await f.page();
	assert.equal(provider.state.callCount, 1);
	assert.equal(result.content[0]?.type, "text");
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.purpose, "other");
});

for (const mode of ["success", "error", "malformed", "cancelled"] as const)
	test(`real triage worker captures ${mode} independently of parent validation/cancellation`, async (t) => {
		const f = await fixture(t);
		const controller = new AbortController();
		const projectId = randomUUID();
		const complete = workerTriage(f.home, f.usage, (data) => {
			const worker = new Worker(new URL("./testing/triage-faux-worker.ts", import.meta.url), {
				workerData: { ...data, error: mode === "error", malformed: mode === "malformed" },
			});
			if (mode === "cancelled")
				worker.on("message", (result) => {
					if (result.usage) controller.abort();
				});
			return worker;
		});
		if (mode === "error" || mode === "cancelled")
			await assert.rejects(complete(f.home, "private triage", {}, controller.signal, { projectId }));
		else {
			const text = await complete(f.home, "private triage", {}, controller.signal, { projectId });
			if (mode === "malformed") assert.throws(() => parseGuide(text));
			else assert.equal(parseGuide(text), "");
		}
		await f.usage.close();
		const [row] = await f.page();
		assert.ok(row);
		assert.equal(row.purpose, "triage");
		// Faux recomputes input from the actual structured worker context.
		assert.equal(row.tokens?.input, 50);
		assert.deepEqual(row.attribution, { projectId });
	});

test("title and classifier capture survives malformed output and cancellation after response", async (t) => {
	const f = await fixture(t);
	const luna = { ...model, provider: "openai-codex", id: "gpt-6-luna" };
	let output = response("not JSON");
	const controller = new AbortController();
	let cancel = false;
	t.mock.method(
		ModelRuntime,
		"create",
		async () =>
			({
				...requiredAuthRegistration,
				getAvailable: async () => [luna],
				completeSimple: async () => {
					if (cancel) controller.abort();
					return output;
				},
			}) as unknown as ModelRuntime,
	);
	const catalog = new ModelCatalog(f.home);
	catalog.setBackgroundUsage(f.usage);
	assert.equal(await catalog.generateTitle(f.home, "private prompt"), "not JSON");
	await assert.rejects(catalog.classifySlack(f.home, "private slack", controller.signal));
	cancel = true;
	await assert.rejects(catalog.classifySlack(f.home, "private slack", controller.signal));
	const rows = await f.page();
	assert.equal(rows.length, 3);
	assert.equal(rows.filter((r) => r.purpose === "classification").length, 2);
	assert.ok(rows.every((r) => r.tokens?.input === 10));
	output = response("", "error");
	assert.equal(
		await generateChatTitle(f.usage.runtime({ completeSimple: async () => output }, "title"), [model], "prompt"),
		undefined,
	);
	assert.equal((await f.page()).length, 4);
});

test("memory retries count each invocation once, even when diagnostics fail", async (t) => {
	const f = await fixture(t);
	let calls = 0;
	const runtime: CompletionRuntime = {
		completeSimple: async () => ({
			...response(),
			content: [fauxToolCall("submit_summary", { text: ++calls < 3 ? "x".repeat(300) : "lasting fact" })],
			stopReason: "toolUse",
		}),
	};
	assert.equal(
		await compactMemory(f.usage.runtime(runtime, "memory"), model, "private memories", new AbortController().signal),
		"lasting fact",
	);
	assert.equal((await f.page()).length, 3);
	await assert.rejects(
		compactMemory(
			f.usage.runtime(runtime, "memory"),
			model,
			"private memories",
			new AbortController().signal,
			async (attempt) => {
				if (attempt.response) throw new Error("private diagnostic failure");
			},
		),
	);
	assert.equal((await f.page()).length, 4);
});

test("observed usage survives actual memory summary application rejecting a stale source epoch", async (t) => {
	const f = await fixture(t);
	const disk = new MemoryDisk(join(f.home, "memory-fixture"), "fixture-device");
	t.after(() => disk.close());
	for (let n = 0; n < 4; n++) disk.note(`fact ${n}`, "fixture-chat");
	const prior = disk.next()!;
	assert.equal(disk.put(prior.lo, prior.hi, prior.epoch, "existing summary"), true);
	const job = disk.next()!;
	assert.ok(job);
	const text = await compactMemory(
		f.usage.runtime(
			{
				completeSimple: async () => {
					disk.forget(0, 1);
					return {
						...response(),
						content: [fauxToolCall("submit_summary", { text: "summary" })],
						stopReason: "toolUse",
					};
				},
			},
			"memory",
		),
		model,
		"private memories",
		new AbortController().signal,
	);
	assert.equal(disk.put(job.lo, job.hi, job.epoch, text), false);
	assert.equal((await f.page())[0]?.tokens?.input, 10);
});

test("observed HTTP retries are bounded numeric evidence, not extra additive responses", async (t) => {
	const f = await fixture(t);
	let callbacks = 0;
	const runtime: CompletionRuntime = {
		completeSimple: async (model, _context, options) => {
			for (const status of [429, 503, 200])
				await options?.onResponse?.({ status, headers: { authorization: "private secret" } }, model);
			return response();
		},
	};
	await f.usage.runtime(runtime, "compaction").completeSimple(model, context, {
		maxRetries: 2,
		onResponse: () => {
			callbacks++;
		},
	});
	assert.equal(callbacks, 3);
	const [row] = await f.page();
	assert.equal(row!.providerAttempts, 3);
	assert.equal(row!.retries, 2);
	assert.equal(row!.requests, 1);
	assert.equal(JSON.stringify(row).includes("secret"), false);
});

test("existing virtual selection stays separate from observed physical response and failed routing", async (t) => {
	const f = await fixture(t);
	const selected = { ...model, api: "pi-virtual", provider: "fixture", id: "virtual-choice" };
	await f.usage.runtime({ completeSimple: async () => response() }, "title").completeSimple(selected, context);
	await f.usage
		.runtime(
			{
				completeSimple: async () => ({
					...response("", "error"),
					api: "pi-virtual",
					provider: selected.provider,
					model: selected.id,
				}),
			},
			"title",
		)
		.completeSimple(selected, context);
	const rows = await f.page();
	assert.ok(rows.every((row) => row.virtualModel?.model === selected.id));
	assert.deepEqual(rows.find((row) => row.outcome === "success")?.physicalModel, {
		provider: model.provider,
		model: model.id,
	});
	assert.equal(rows.find((row) => row.outcome === "failure")?.physicalModel, undefined);
});

test("initializing an empty adapter does not start the accounting worker", async (t) => {
	const f = await fixture(t);
	await assert.rejects(stat(join(f.home, "accounting", "usage-history.sqlite")), { code: "ENOENT" });
});

test("placeholder and partially missing prices never become exact free inference", () => {
	const result = response();
	result.usage.cost.total = 0;
	assert.equal(backgroundEvidence(result).cost?.estimateStatus, "unavailable");
	result.usage.cost.total = 0.00002;
	result.usage.cost.cacheRead = 0;
	assert.equal(backgroundEvidence(result).cost?.estimateStatus, "partial_catalog_estimate");
	result.usage.input = NaN;
	assert.equal(backgroundEvidence(result).tokens, undefined);
	assert.equal(backgroundEvidence(result).cost?.estimatedUsdMicros, 20, "valid cost survives malformed token data");
});

test("hung epoch acquisition cannot block inference or attach pre-erasure work to a later epoch", async (t) => {
	const f = await fixture(t);
	const original = f.store.status.bind(f.store);
	let release!: (status: Awaited<ReturnType<typeof original>>) => void;
	t.mock.method(
		f.store,
		"status",
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	let calls = 0;
	const result = await f.usage
		.runtime(
			{
				completeSimple: async () => {
					calls++;
					return response("completed");
				},
			},
			"title",
		)
		.completeSimple(model, context);
	assert.equal(calls, 1);
	assert.equal(result.content[0]?.type, "text");
	await f.store.clear();
	release(await original());
	await f.usage.close();
	t.mock.restoreAll();
	assert.equal((await f.page()).length, 0);
	assert.deepEqual(await readdir(f.directory), []);
});

test("response and request retention floors fence an old durable recovery source", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "background-expiry-"));
	let now = Date.now();
	const store = new UsageHistoryStore(home, () => now);
	const usage = new BackgroundUsage(home, store, () => now);
	t.after(async () => {
		await usage.close();
		await store.close();
		await rm(home, { recursive: true, force: true });
	});
	t.mock.method(store, "put", async () => {
		throw new Error("unavailable");
	});
	await usage.runtime({ completeSimple: async () => response() }, "memory").completeSimple(model, context);
	await usage.close();
	t.mock.restoreAll();
	now += 31 * 86_400_000;
	await store.expire();
	const replay = new BackgroundUsage(home, store, () => now);
	await replay.ready();
	await replay.close();
	assert.equal((await store.status()).retainedRows, 0);
	assert.deepEqual(await readdir(join(home, "accounting", "background-pending")), []);
});

test("thrown/cancelled calls without a normalized response do not fabricate priced usage", async (t) => {
	const f = await fixture(t);
	const controller = new AbortController();
	for (const cancelled of [false, true]) {
		const runtime: CompletionRuntime = {
			completeSimple: async () => {
				if (cancelled) controller.abort();
				throw new Error("private provider failure");
			},
		};
		await assert.rejects(
			f.usage.runtime(runtime, "other").completeSimple(model, context, { signal: controller.signal }),
		);
	}
	const rows = await f.page();
	assert.deepEqual(new Set(rows.map((r) => r.outcome)), new Set(["failure", "cancelled"]));
	assert.ok(rows.every((r) => r.cost?.estimateStatus === "unavailable" && r.requests === undefined));
	assert.equal(JSON.stringify(rows).includes("private"), false);
});

test("crash before a response recovers one undated partial, never inference", async (t) => {
	const f = await fixture(t);
	await f.usage.begin("memory", { projectId: randomUUID() });
	await f.usage.close();
	const recovered = new BackgroundUsage(f.home, f.store);
	await recovered.ready();
	await recovered.close();
	assert.equal((await f.page()).length, 0);
	const [partial] = await f.page("checkpoint");
	assert.equal(partial!.coverage, "partial");
	assert.equal(partial!.completedAt, undefined);
	assert.equal(partial!.outcome, "unknown");
	assert.equal(partial!.tokens, undefined, "missing response is not evidence of zero tokens");
	assert.equal(partial!.cost, undefined);
	assert.deepEqual(await readdir(f.directory), []);
});

for (const lostAck of [false, true])
	test(`crash after response persistence recovers source identity (lost ack ${lostAck})`, async (t) => {
		const f = await fixture(t);
		const original = f.store.put.bind(f.store);
		t.mock.method(f.store, "put", async (row: UsageObservation) => {
			if (lostAck) await original(row);
			throw new Error("uncertain publication");
		});
		await f.usage.runtime({ completeSimple: async () => response() }, "triage").completeSimple(model, context);
		const [name] = await readdir(f.directory);
		const source = JSON.parse(await readFile(join(f.directory, name!), "utf8"));
		await f.usage.close();
		t.mock.restoreAll();
		const replay = new BackgroundUsage(f.home, f.store);
		await replay.ready();
		await replay.close();
		const [row] = await f.page();
		assert.equal(row!.sourceId, source.sourceId);
		assert.equal(row!.operationId, source.operationId);
		assert.equal(row!.tokens?.input, 10);
		assert.equal((await f.store.status()).retainedRows, 1);
	});

for (const erase of ["clear", "chat"] as const)
	test(`${erase} fences in-flight and durable source evidence before acknowledgement`, async (t) => {
		const f = await fixture(t);
		const chatId = randomUUID();
		const finish = await f.usage.begin("title", { chatId });
		assert.equal((await readdir(f.directory)).length, 1);
		if (erase === "clear") await f.store.clear();
		else await f.store.eraseChat(chatId);
		assert.deepEqual(await readdir(f.directory), []);
		await finish!(backgroundEvidence(response()));
		assert.deepEqual(await readdir(f.directory), []);
		assert.equal((await f.page()).length, 0);
		await f.usage
			.runtime({ completeSimple: async () => response() }, "title", { chatId: randomUUID() })
			.completeSimple(model, context);
		assert.equal((await f.page()).length, 1);
	});

test("bounded admission fails open, and source files never contain input/output/errors or credentials", async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < BACKGROUND_USAGE_LIMIT; i++) await f.usage.begin("other", { projectId: "not-a-uuid" });
	let calls = 0;
	await f.usage
		.runtime(
			{
				completeSimple: async () => {
					calls++;
					return response();
				},
			},
			"other",
		)
		.completeSimple(model, { messages: [{ role: "user", content: "private prompt", timestamp: Date.now() }] });
	assert.equal(calls, 1);
	assert.equal((await readdir(f.directory)).length, BACKGROUND_USAGE_LIMIT);
	for (const name of await readdir(f.directory)) {
		const data = await readFile(join(f.directory, name), "utf8");
		assert.ok(Buffer.byteLength(data) <= 4096);
		assert.equal(/private|prompt|completion|credential|not-a-uuid/.test(data), false);
		assert.equal(JSON.parse(data).attribution, undefined);
	}
});
