import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	CompactionTask,
	createRegistry,
	defineTool,
	Harness,
	hook,
	MemoryStorage,
	type Storage,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { UsageObservation } from "@pilot/protocol";
import { UsageCapture, type UsageCaptureConfiguration } from "./usage-capture.ts";
import { CaptureJournal } from "./usage-capture-journal.ts";

const epoch = { generation: randomUUID(), captureFloor: 0, retentionFloor: 0 };
const attribution = { chatId: randomUUID(), projectId: randomUUID() };
async function fixture(
	options: {
		publish?: (row: UsageObservation) => Promise<"stored">;
		configuration?: UsageCaptureConfiguration;
		storage?: Storage;
		journalFile?: string;
		virtual?: boolean;
		deferred?: boolean;
		acquire?: () => Promise<typeof epoch>;
	} = {},
) {
	const faux = fauxProvider({
		...(options.deferred ? { deferred: { pendingFetches: 1, pollAfterMs: 0 } } : {}),
		tokensPerSecond: 0,
		models: [{ id: "offline", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	const extension = { name: "fixture" };
	registry.install(extension);
	const rows = new Map<string, UsageObservation>();
	const capture = new UsageCapture(
		options.configuration ?? { ...epoch, attribution: structuredClone(attribution) },
		options.publish ??
			(async (row) => {
				rows.set(`${row.sourceId}:${row.operationId}`, structuredClone(row));
				return "stored";
			}),
		options.acquire,
		options.journalFile,
	);
	const selected = options.virtual
		? { ...faux.getModel(), api: "pi-virtual", provider: "pi-virtual", id: "selected" }
		: faux.getModel();
	const routed = options.virtual
		? new Proxy(models, {
				get(target, key) {
					if (key === "getModel")
						return (provider: string, id: string) =>
							provider === "pi-virtual" ? selected : target.getModel(provider, id);
					if (key === "streamSimple")
						return (
							_model: unknown,
							...args: [Parameters<typeof models.streamSimple>[1], Parameters<typeof models.streamSimple>[2]]
						) => target.streamSimple(faux.getModel(), ...args);
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			})
		: models;
	const harness = await Harness.open(
		options.storage ?? new MemoryStorage(),
		{
			models: capture.deferredModels(capture.models(routed)),
			registry: capture.registry(registry),
			settings: {
				retry: { enabled: false },
				compaction: { keepRecentTokens: 1 },
				...(options.deferred ? { stream: { deferred: true } } : {}),
			},
		},
		context,
	);
	await capture.bind(harness);
	const model = selected;
	const conversation = await harness.root(context, {
		agent: { model: { provider: model.provider, modelId: model.id }, extensions: [extension] },
	});
	async function submit(requestId = "typed") {
		await (await conversation.submit({ type: "input", content: "offline work", requestId }, context)).wait(context);
		await conversation.waitForIdle(context);
		// Task-finally settlement and its asynchronous publish are deliberately outside scheduling.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await capture.flush();
		return [...rows.values()].filter((row) => row.kind === "request");
	}
	return { faux, models, registry, rows, capture, harness, conversation, submit };
}

test("captures physical requests, preserves UsageDoc, and distinguishes automatic follow-ups", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const first = (await f.submit())[0]!;
		assert.equal(first.coverage, "committed");
		assert.equal(first.purpose, "agent");
		assert.equal(first.outcome, "success");
		assert.deepEqual(first.physicalModel, { provider: f.faux.provider.id, model: "offline" });
		assert.equal(first.attribution?.chatId, attribution.chatId);
		assert.ok(first.attribution?.attemptId);
		assert.ok(first.attribution?.runId);
		assert.ok(first.completedAt);
		assert.equal(first.requests, 1);
		assert.equal(first.cost?.estimateStatus, "unavailable", "the faux provider reports zero placeholder cost");
		const requests = await f.submit("pr-follow-up:1");
		assert.equal(requests.length, 2);
		assert.equal(requests[1]!.purpose, "follow_up");
		assert.notEqual(requests[1]!.operationId, first.operationId);
		assert.notEqual(requests[1]!.attribution?.runId, first.attribution?.runId);
		const usage = await f.harness.snapshot(UsageDoc, f.conversation.id, context);
		assert.equal(
			Object.values(usage!.models)[0]!.input,
			requests.reduce((sum, row) => sum + row.tokens!.input, 0),
		);
		assert.equal([...f.rows.values()].filter((row) => row.kind === "checkpoint" && row.scope === "direct").length, 1);
	} finally {
		await f.harness.close(context);
	}
});

test("unavailable source accounting does not fail storage, stop dispatch or invent free requests", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "capture-unavailable-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const blocker = join(home, "not-a-directory");
	await writeFile(blocker, "fixture");
	const f = await fixture({ journalFile: join(blocker, "capture.json") });
	try {
		f.faux.setResponses([fauxAssistantMessage("work still completes")]);
		assert.equal((await f.submit()).length, 0);
		assert.equal(f.faux.state.callCount, 1);
		assert.ok(Object.values((await f.harness.snapshot(UsageDoc, f.conversation.id, context))!.models)[0]!.output > 0);
	} finally {
		await f.harness.close(context);
	}
});

test("corrupt, unknown-version, oversize and symlinked source journals fail closed without overwrite", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "capture-invalid-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	for (const [index, content] of [
		"corrupt",
		JSON.stringify({ schemaVersion: 99, sourceId: randomUUID(), parent: null, revision: 0, rows: [] }),
		" ".repeat(133 * 1024),
	].entries()) {
		const file = join(home, `invalid-${index}.json`);
		await writeFile(file, content);
		const journal = new CaptureJournal(file);
		await journal.load();
		assert.equal(
			await journal.update((state) => {
				state.rows = [];
				return true;
			}),
			undefined,
		);
		assert.equal(await readFile(file, "utf8"), content);
	}
	const destination = join(home, "destination.json");
	await writeFile(destination, "must remain unchanged");
	const link = join(home, "source.json");
	await symlink(destination, link);
	const journal = new CaptureJournal(link);
	await journal.load();
	assert.equal(await journal.update(() => true), undefined);
	assert.equal(await readFile(destination, "utf8"), "must remain unchanged");
});

test("closed source journals refuse late publisher acknowledgements without recreating removed homes", async () => {
	const home = await mkdtemp(join(tmpdir(), "capture-close-"));
	const journal = new CaptureJournal(join(home, "capture.json"));
	await journal.load();
	await journal.update(() => true);
	await journal.close();
	await rm(home, { recursive: true, force: true });
	assert.equal(await journal.update(() => true), undefined);
	await assert.rejects(stat(home), { code: "ENOENT" });
});

test("bounded private source outbox fills without blocking subsequent work", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "capture-capacity-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const file = join(home, "capture.json");
	const f = await fixture({
		journalFile: file,
		publish: async () => {
			throw new Error("store unavailable");
		},
	});
	try {
		f.faux.setResponses(Array.from({ length: 36 }, () => fauxAssistantMessage("offline output")));
		for (let index = 0; index < 36; index++) await f.submit(`input:${index}`);
		assert.equal(f.faux.state.callCount, 36);
		assert.ok((await f.capture.journal.snapshot()).rows.length <= 32);
		assert.ok((await stat(file)).size <= 132 * 1024);
		assert.equal((await stat(file)).mode & 0o777, 0o600);
		assert.ok(
			!(await readFile(file, "utf8")).includes("offline output"),
			"responses are never copied into source evidence",
		);
	} finally {
		await f.harness.close(context);
	}
});

test("hidden physical routes retain the observed virtual selection without inventing a policy revision", async () => {
	const f = await fixture({ virtual: true });
	try {
		f.faux.setResponses([
			async (_context, options) => {
				await options?.onPayload?.({}, { ...f.faux.getModel(), id: "prepared-not-response" });
				return fauxAssistantMessage("physical result");
			},
		]);
		const row = (await f.submit())[0]!;
		assert.deepEqual(row.virtualModel, { provider: "pi-virtual", model: "selected" });
		assert.deepEqual(row.physicalModel, { provider: f.faux.provider.id, model: "offline" });
		assert.equal(row.virtualRevision, undefined);
		assert.equal(row.cost?.estimateStatus, "unavailable", "virtual placeholder prices are not free inference");
	} finally {
		await f.harness.close(context);
	}
});

test("existing deferred fetches complete the original operation, never another request or new polling", async () => {
	const f = await fixture({ deferred: true });
	try {
		f.faux.setResponses([fauxAssistantMessage("deferred result")]);
		const requests = await f.submit();
		assert.equal(f.faux.state.callCount, 1);
		assert.equal(f.faux.state.deferredFetchCount, 2, "only the Harness's configured fetches run");
		assert.equal(requests.length, 1);
		assert.equal(requests[0]!.requests, 1);
		assert.equal(requests[0]!.outcome, "success");
		assert.equal(requests[0]!.coverage, "committed");
		assert.ok(requests[0]!.tokens!.output > 0);
	} finally {
		await f.harness.close(context);
	}
});

test("deterministic compaction records activity without another inference cost; model compaction has its own purpose", async () => {
	for (const deterministic of [true, false]) {
		const f = await fixture();
		try {
			f.faux.setResponses([
				fauxAssistantMessage("one ".repeat(100)),
				fauxAssistantMessage("two ".repeat(100)),
				fauxAssistantMessage("summary"),
			]);
			await f.submit("one");
			await f.submit("two");
			if (deterministic)
				f.registry.install({
					name: "fixture",
					hooks: [hook(CompactionTask, { beforeCompact: () => ({ summary: "deterministic summary" }) })],
				});
			const task = await f.conversation.compact(undefined, context);
			await f.harness.waitForTask(task, context);
			await f.conversation.waitForIdle(context);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await f.capture.flush();
			const requests = [...f.rows.values()].filter((row) => row.kind === "request");
			assert.equal(requests.length, deterministic ? 2 : 3);
			if (!deterministic) assert.equal(requests.at(-1)!.purpose, "compaction");
			const activity = [...f.rows.values()].find((row) => row.activity === "compaction")!;
			assert.ok(activity);
			assert.equal(activity.kind, "checkpoint");
			assert.equal(activity.tokens, undefined);
			assert.equal(activity.cost, undefined);
			assert.equal(activity.requests, 0);
		} finally {
			await f.harness.close(context);
		}
	}
});

test("SQLite restart replays committed detail once without another dispatch or tool execution", async () => {
	const home = await mkdtemp(join(tmpdir(), "capture-restart-"));
	const file = join(home, "harness.sqlite");
	const f = await fixture({
		storage: await openNodeSqliteStorage(file),
		journalFile: join(home, "usage-capture.json"),
		publish: async () => {
			throw new Error("lost ack");
		},
	});
	let source: string;
	try {
		f.faux.setResponses([fauxAssistantMessage("committed response")]);
		await f.submit();
		source = (await f.capture.journal.snapshot()).sourceId;
	} finally {
		await f.harness.close(context);
	}
	const restored = await fixture({
		storage: await openNodeSqliteStorage(file),
		journalFile: join(home, "usage-capture.json"),
	});
	try {
		await restored.capture.flush();
		const rows = [...restored.rows.values()].filter((row) => row.kind === "request");
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.sourceId, source!);
		assert.equal(restored.faux.state.callCount, 0);
		await restored.capture.flush();
		assert.equal(restored.rows.size, 2);
	} finally {
		await restored.harness.close(context);
		await rm(home, { recursive: true, force: true });
	}
});

test("crash-lost response stays unknown and a new erasure epoch captures only newly dispatched operations", async () => {
	let current = { ...epoch };
	const f = await fixture({ acquire: async () => current });
	try {
		const state = await f.capture.journal.snapshot();
		const lost: UsageObservation = {
			schemaVersion: 1,
			...epoch,
			sourceId: state.sourceId,
			operationId: randomUUID(),
			revision: 1,
			kind: "request",
			scope: "direct",
			purpose: "agent",
			coverage: "partial",
			observedAt: Date.now(),
			outcome: "unknown",
		};
		// Exact numeric source state left after pre-dispatch identity commit and abrupt process loss.
		await f.capture.journal.update((state) => {
			state.rows.push({ row: lost, settled: false });
		});
		await f.capture.bind(f.harness);
		await f.capture.flush();
		const unknown = [...f.rows.values()][0]!;
		assert.equal(unknown.tokens, undefined);
		assert.equal(unknown.cost, undefined);
		assert.equal(unknown.completedAt, undefined);
		assert.equal(f.faux.state.callCount, 0);
		current = { generation: randomUUID(), captureFloor: Date.now(), retentionFloor: 0 };
		f.faux.setResponses([fauxAssistantMessage("new work only")]);
		const rows = await f.submit();
		const fresh = rows.at(-1)!;
		assert.equal(fresh.generation, current.generation);
		assert.equal(unknown.generation, epoch.generation);
		assert.equal(
			[...f.rows.values()].filter((row) => row.kind === "checkpoint" && row.generation === current.generation)
				.length,
			0,
			"lifetime totals cannot be transplanted into the new epoch",
		);
	} finally {
		await f.harness.close(context);
	}
});

test("pending operation identity commits BEFORE dispatch, and failures/cancellation retain reported usage", async () => {
	const f = await fixture();
	try {
		for (const stopReason of ["error", "aborted"] as const) {
			f.faux.setResponses([
				async () => {
					const journal = await f.capture.journal.snapshot();
					const pending = journal!.rows.find((item) => !item.settled)!;
					assert.ok(pending.row.operationId);
					assert.equal(pending.row.tokens, undefined, "no response is unknown, not zero");
					return fauxAssistantMessage("reported partial output", { stopReason, errorMessage: "offline failure" });
				},
			]);
			const request = (await f.submit(`typed:${stopReason}`)).at(-1)!;
			assert.equal(request.outcome, stopReason === "error" ? "failure" : "cancelled");
			assert.ok(request.tokens!.output > 0);
			assert.equal(request.coverage, "committed");
		}
	} finally {
		await f.harness.close(context);
	}
});

test("tools cannot add overlapping delegated usage to the additive request view", async () => {
	const parent = await fixture();
	const child = await fixture({
		configuration: { ...epoch, attribution, parent: { sourceId: randomUUID(), operationId: "tool:1" } },
	});
	let effects = 0;
	try {
		parent.registry.install({
			name: "fixture",
			tools: [
				defineTool({
					name: "delegate",
					description: "offline child",
					parameters: Type.Object({}),
					replay: "unsafe",
					execute: async () => {
						effects++;
						child.faux.setResponses([fauxAssistantMessage("child output")]);
						await child.submit();
						const usage = await child.harness.snapshot(UsageDoc, child.conversation.id, context);
						return { output: [{ type: "text", text: "done" }], usage: Object.values(usage!.models)[0]! };
					},
				}),
			],
		});
		await parent.conversation.configure({ tools: null }, context);
		parent.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("parent output"),
		]);
		const requests = await parent.submit();
		assert.equal(effects, 1);
		assert.equal(requests.length, 2);
		const childRequest = [...child.rows.values()].find((row) => row.kind === "request")!;
		assert.ok(childRequest.parent);
		assert.notEqual(childRequest.sourceId, requests[0]!.sourceId);
		assert.equal(
			[...parent.rows.values()].filter((row) => row.kind === "request" && row.scope === "child").length,
			0,
		);
		assert.ok([...parent.rows.values()].some((row) => row.scope === "child" && row.tokens!.output > 0));
	} finally {
		await child.harness.close(context);
		await parent.harness.close(context);
	}
});

test("failed publication replays original evidence after restart, never transplants erasure epochs", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "capture-publish-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const journalFile = join(directory, "usage-capture.json");
	let fail = true;
	const published: UsageObservation[] = [];
	const f = await fixture({
		journalFile,
		publish: async (row) => {
			if (fail) throw new Error("offline store");
			published.push(structuredClone(row));
			return "stored";
		},
	});
	try {
		f.faux.setResponses([fauxAssistantMessage("saved")]);
		await f.submit();
		const saved = await f.capture.journal.snapshot();
		assert.equal(saved.rows.filter((item) => item.row.kind === "request").length, 1);
		const original = saved.rows.find((item) => item.row.kind === "request")!.row;
		fail = false;
		const recovered = new UsageCapture(
			{ ...epoch, generation: randomUUID(), captureFloor: Date.now() + 1 },
			async (row) => {
				published.push(structuredClone(row));
				return "stored";
			},
			undefined,
			journalFile,
		);
		await recovered.bind(f.harness);
		await recovered.flush();
		assert.equal(published.find((row) => row.kind === "request")!.generation, original.generation);
		assert.equal(published.find((row) => row.kind === "request")!.operationId, original.operationId);
		assert.equal(f.faux.state.callCount, 1);
	} finally {
		await f.harness.close(context);
	}
});

test("fork/reset/compaction retain inherited source identity without recharging inherited requests", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([fauxAssistantMessage("original"), fauxAssistantMessage("new fork response")]);
		const original = (await f.submit())[0]!;
		const view = await f.conversation.context(context);
		const fork = await f.conversation.fork(view.entries.at(-1)!.id, { ownership: { kind: "ownerless" } }, context);
		await (await fork.submit({ type: "input", content: "continue" }, context)).wait(context);
		await fork.waitForIdle(context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await f.capture.flush();
		const requests = [...f.rows.values()].filter((row) => row.kind === "request");
		assert.equal(requests.length, 2);
		assert.equal(requests[1]!.sourceId, original.sourceId);
		assert.notEqual(requests[1]!.attribution?.attemptId, original.attribution?.attemptId);
		await fork.reset(undefined, context);
		await f.capture.flush();
		assert.equal([...f.rows.values()].filter((row) => row.kind === "request").length, 2);
	} finally {
		await f.harness.close(context);
	}
});
