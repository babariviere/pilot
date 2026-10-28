/** Local accounting only. The Harness/UsageDoc, not this observer, still owns execution and totals. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, AssistantMessageEventStream, Models, Usage } from "@earendil-works/pi-ai";
import {
	Harness,
	LiveDoc,
	type RegistryReader,
	type RunningTask,
	type TaskRuntime,
	UsageDoc,
} from "@earendil-works/pi-durable";
import type { UsageHistoryWriteResult, UsageObservation } from "@pilot/protocol";
import { inputOrigin } from "./input-origin.ts";
import { CaptureJournal, type CaptureJournalState } from "./usage-capture-journal.ts";
import { usageCost, usageTokens } from "./usage-values.ts";

export type UsageCaptureEpoch = {
	generation: string;
	captureFloor: number;
	retentionFloor: number;
	mission?: NonNullable<UsageObservation["attribution"]>["mission"];
};
export type UsageCaptureConfiguration = UsageCaptureEpoch & {
	attribution?: UsageObservation["attribution"];
	purpose?: "agent" | "control";
	parent?: UsageObservation["parent"];
};
export type PublishUsage = (row: UsageObservation) => Promise<UsageHistoryWriteResult>;
export type AcquireUsageEpoch = () => Promise<UsageCaptureEpoch>;
type Runtime = TaskRuntime<JsonValue, JsonValue, JsonValue, object>;
type Invocation = {
	task: RunningTask<JsonValue, JsonValue, JsonValue>;
	runtime: Runtime;
	context: Context;
	responses: { operationId: string; key: string; usage: Usage }[];
	operations: string[];
};
type CaptureScope = Pick<Invocation, "responses" | "operations" | "context"> & {
	task: { kind: string; id?: number };
	runtime: Pick<Runtime, "conversationId" | "snapshot">;
};
type Phase = (task: Invocation["task"], runtime: Runtime, context: Context) => Promise<void>;

/** Opaque, stable local UUIDs for numeric durable identities. No path/title/provider is hashed. */
export function usageIdentity(source: string, kind: string, id: number): string {
	const bytes = createHash("sha256").update(`${source}:${kind}:${id}`).digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 15) | 80;
	bytes[8] = (bytes[8]! & 63) | 128;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class UsageCapture {
	private readonly invocation = new AsyncLocalStorage<Invocation>();
	private readonly standalone = new AsyncLocalStorage<CaptureScope>();
	private harness?: Harness;
	private sourceId?: string;
	private flushing?: Promise<void>;
	private flushRequested = false;
	readonly configuration: UsageCaptureConfiguration;
	private readonly publish: PublishUsage;
	private readonly acquireEpoch?: AcquireUsageEpoch;
	readonly journal: CaptureJournal;
	constructor(
		configuration: UsageCaptureConfiguration,
		publish: PublishUsage,
		acquireEpoch?: AcquireUsageEpoch,
		file?: string,
	) {
		this.configuration = configuration;
		this.publish = publish;
		this.acquireEpoch = acquireEpoch;
		this.journal = new CaptureJournal(file, configuration.parent);
	}

	async bind(harness: Harness): Promise<void> {
		this.harness = harness;
		const close = harness.close.bind(harness);
		harness.close = async (context) => {
			try {
				await close(context);
			} finally {
				await this.journal.close();
			}
		};
		try {
			await this.journal.load();
			const original = await this.journal.snapshot();
			if (original.parent) this.configuration.parent = original.parent;
			else delete this.configuration.parent;
			this.sourceId = await this.journal.update((state) => {
				for (const item of state.rows) item.settled = true;
				return state.sourceId;
			});
			// Recovered rows keep their ORIGINAL generation, date and attribution, including inherited forks.
			void this.flush();
		} catch {
			/* Accounting failure never retries or changes agent work. */
		}
	}

	/** Decorate task execution only, retaining definitions, registry versions and provider dispatch. */
	registry<R extends RegistryReader>(registry: R): R {
		const capture = this;
		const tasks = new WeakMap<object, object>();
		const decorate = <T extends { definition: { phases: Readonly<Record<string, unknown>>; abort: unknown } }>(
			task: T,
		): T => {
			const prior = tasks.get(task);
			if (prior) return prior as T;
			const wrap = (phase: unknown) =>
				typeof phase !== "function"
					? phase
					: async (...args: Parameters<Phase>) => {
							const [record, runtime, context] = args;
							const state: Invocation = { task: record, runtime, context, responses: [], operations: [] };
							return capture.invocation.run(state, async () => {
								const proxy = new Proxy(runtime, {
									get(target, key) {
										if (key === "commit") return capture.commit.bind(capture, state);
										const value = Reflect.get(target, key, target);
										return typeof value === "function" ? value.bind(target) : value;
									},
								});
								const previous = process.env.PILOT_USAGE_PARENT;
								if (record.kind === "pi.tool" && capture.sourceId)
									process.env.PILOT_USAGE_PARENT = JSON.stringify({
										sourceId: capture.sourceId,
										operationId: `tool:${record.id}`,
									});
								try {
									await (phase as Phase)(record, proxy, context);
								} finally {
									if (record.kind === "pi.tool") {
										if (previous === undefined) delete process.env.PILOT_USAGE_PARENT;
										else process.env.PILOT_USAGE_PARENT = previous;
									}
									await capture.settle(state.operations);
									void capture.flush();
								}
							});
						};
			const value = {
				...task,
				definition: {
					...task.definition,
					phases: Object.fromEntries(
						Object.entries(task.definition.phases).map(([key, phase]) => [key, wrap(phase)]),
					),
					abort: wrap(task.definition.abort),
				},
			};
			tasks.set(task, value);
			return value;
		};
		return new Proxy(registry, {
			get(target, key) {
				if (key === "snapshot")
					return () =>
						new Proxy(target.snapshot(), {
							get(snapshot, name) {
								if (name === "task")
									return (id: string) => {
										const task = snapshot.task(id);
										return task ? decorate(task) : undefined;
									};
								if (name === "tasks") return () => snapshot.tasks().map(decorate);
								const value = Reflect.get(snapshot, name, snapshot);
								return typeof value === "function" ? value.bind(snapshot) : value;
							},
						});
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	private async commit(state: Invocation, change: Parameters<Runtime["commit"]>[0], context: Context): Promise<void> {
		// Streaming partials do not change UsageDoc. Keep them off the accounting path.
		if (state.task.kind === "pi.generation" && state.responses.length === 0)
			return state.runtime.commit(change, context);
		const updates: Array<(journal: CaptureJournalState) => void> = [];
		await state.runtime.commit(async (tx, current) => {
			const ledger = await tx.doc(UsageDoc, state.runtime.conversationId);
			const before = JSON.parse(JSON.stringify(ledger)) as typeof ledger;
			const result = await change(tx, current);
			if (JSON.stringify(before) !== JSON.stringify(ledger)) {
				const committed = JSON.parse(JSON.stringify(ledger)) as typeof ledger;
				updates.push((journal) => {
					// A raw response is committed only when this task's authoritative ledger changes.
					for (const response of state.responses) {
						const item = journal.rows.find(({ row }) => row.operationId === response.operationId);
						const old = before.models[response.key];
						const next = committed.models[response.key];
						const group = state.responses.filter((candidate) => candidate.key === response.key);
						if (
							item &&
							next &&
							(["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const).every(
								(key) =>
									(next[key] ?? 0) - (old?.[key] ?? 0) ===
									group.reduce((sum, candidate) => sum + (candidate.usage[key] ?? 0), 0),
							) &&
							(["input", "output", "cacheRead", "cacheWrite", "total"] as const).every(
								(key) =>
									Math.abs(
										next.cost[key] -
											(old?.cost[key] ?? 0) -
											group.reduce((sum, candidate) => sum + candidate.usage.cost[key], 0),
									) <= 0.0000005,
							)
						) {
							item.row.coverage = "committed";
							item.row.revision++;
							item.settled = true;
						}
					}

					for (const scope of this.configuration.captureFloor > 0 ? [] : (["direct", "child"] as const)) {
						const bucket = scope === "direct" ? "models" : "tools";
						if (JSON.stringify(before[bucket]) === JSON.stringify(committed[bucket])) continue;
						const operationId = `checkpoint:${state.runtime.conversationId}:${scope}`;
						const prior = journal.rows.find(({ row }) => row.operationId === operationId);
						const values = Object.values(scope === "direct" ? committed.models : committed.tools);
						const cost = usageCost(values);
						// UsageDoc retains historical estimates, but does not retain their original catalog revisions.
						if (cost.pricingRevision) cost.pricingRevision = "UsageDoc:unversioned";
						const row: UsageObservation = {
							...this.base(operationId),
							revision: ++journal.revision,
							kind: "checkpoint",
							scope,
							coverage: "committed",
							purpose: "unknown",
							tokens: usageTokens(values),
							cost,
						};
						if (prior) prior.row = row;
						else if (journal.rows.length < 32) journal.rows.push({ row, settled: true });
					}
				});
			}
			if (
				state.task.kind === "pi.compaction" &&
				result?.status === "terminal" &&
				result.outcome.status === "completed"
			) {
				const evidence = result.outcome.result;
				if (evidence && typeof evidence === "object" && ("entryId" in evidence || "submissionId" in evidence)) {
					updates.push((journal) => {
						if (journal.rows.length < 32)
							journal.rows.push({
								settled: true,
								row: {
									...this.base(`compaction:${state.task.id}`),
									kind: "checkpoint",
									purpose: "compaction",
									coverage: "committed",
									activity: "compaction",
									requests: 0,
									outcome: "success",
								},
							});
					});
				}
			}
			return result;
		}, context);
		if (updates.length)
			await this.journal.update((journal) => {
				for (const update of updates) update(journal);
			});
		state.responses.length = 0;
	}

	models(models: Models): Models {
		const capture = this;
		const captureModels = new Proxy(models, {
			get(target, key) {
				if (key === "streamSimple" || key === "stream")
					return (...args: Parameters<Models["streamSimple"]>) => {
						const state = capture.invocation.getStore() ?? capture.standalone.getStore();
						if (!state) return key === "streamSimple" ? target.streamSimple(...args) : target.stream(...args);
						const [model, context, options] = args;
						let operation: string | undefined;
						let started = 0;
						let physical: UsageObservation["physicalModel"];
						let attempts = 0;
						const ready = capture.begin(state, model).then((id) => {
							operation = id;
							started = performance.now();
							const forwarded = {
								...options,
								onPayload: async (payload: unknown, actual: typeof model) => {
									physical = observedModel(actual.provider, actual.id);
									return options?.onPayload?.(payload, actual);
								},
								onResponse: async (
									...args: Parameters<NonNullable<NonNullable<typeof options>["onResponse"]>>
								) => {
									attempts++;
									await options?.onResponse?.(...args);
								},
							};
							return key === "streamSimple"
								? target.streamSimple(model, context, forwarded)
								: target.stream(model, context, forwarded);
						});
						let final: Promise<AssistantMessage> | undefined;
						const finish = () =>
							(final ??= (async () => {
								const message = await (await ready).result();
								if (operation)
									await capture.response(
										state,
										operation,
										model,
										message,
										Math.round(performance.now() - started),
										physical,
										attempts,
									);
								return message;
							})());
						// Models consumers only read iteration/result. Preserve thrown errors and the original
						// message/events; in particular do not manufacture a zero-usage assistant on failure.
						return {
							async *[Symbol.asyncIterator]() {
								for await (const event of await ready) {
									if (event.type === "done" || event.type === "error") await finish();
									yield event;
								}
							},
							result: finish,
						} as unknown as AssistantMessageEventStream;
					};
				if (key === "completeSimple")
					return (...args: Parameters<Models["streamSimple"]>) => captureModels.streamSimple(...args).result();
				if (key === "complete")
					return (...args: Parameters<Models["stream"]>) => captureModels.stream(...args).result();
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return captureModels;
	}

	/** Explicit provider-neutral context rebuilds run outside a Harness task. */
	async compaction<T>(conversationId: Runtime["conversationId"], work: () => Promise<T>): Promise<T> {
		if (!this.harness) return work();
		const scope: CaptureScope = {
			task: { kind: "pi.compaction" },
			context: BACKGROUND_CONTEXT,
			runtime: { conversationId, snapshot: this.harness.snapshot.bind(this.harness) },
			operations: [],
			responses: [],
		};
		return this.standalone.run(scope, async () => {
			try {
				return await work();
			} finally {
				await this.settle(scope.operations);
				void this.flush();
			}
		});
	}

	/** Install at the physical registry seam, inside the native offline/subscription retry loop. */
	instrumentStreams(target: Pick<Models, "stream" | "streamSimple">): void {
		const original = { stream: target.stream.bind(target), streamSimple: target.streamSimple.bind(target) };
		const snapshot = new Proxy(target, {
			get(object, key) {
				if (key === "stream" || key === "streamSimple") return original[key];
				const value = Reflect.get(object, key, object);
				return typeof value === "function" ? value.bind(object) : value;
			},
		});
		const wrapped = this.models(snapshot as Models);
		target.stream = wrapped.stream;
		target.streamSimple = wrapped.streamSimple;
	}

	/** Observe only Harness-initiated deferred fetch/cancel. Never add provider polling. */
	deferredModels(models: Models | (() => Models)): Models | (() => Models) {
		if (typeof models === "function") return () => this.deferredModels(models()) as Models;
		const capture = this;
		return new Proxy(models, {
			get(target, key) {
				if (key === "fetchDeferred" || key === "cancelDeferred")
					return async (...args: Parameters<Models["fetchDeferred"]>) => {
						const state = capture.invocation.getStore();
						const item = state
							? (await capture.journal.snapshot()).rows.find((item) => item.pendingTaskId === state.task.id)
							: undefined;
						if (!item || !state)
							return key === "fetchDeferred" ? target.fetchDeferred(...args) : target.cancelDeferred(...args);
						state.operations.push(item.row.operationId);
						await capture.journal.update((journal) => {
							const pending = journal.rows.find(({ row }) => row.operationId === item.row.operationId);
							if (pending) pending.settled = false;
						});
						if (key === "fetchDeferred") {
							const message = await target.fetchDeferred(...args);
							if (!deferredResponse(message))
								await capture.response(state, item.row.operationId, args[0], message, message.durationMs);
							return message;
						}
						let cancelled = false;
						try {
							const result = await target.cancelDeferred(...args);
							cancelled = true;
							return result;
						} finally {
							await capture.journal.update((journal) => {
								const pending = journal.rows.find(({ row }) => row.operationId === item.row.operationId);
								if (pending) {
									delete pending.pendingTaskId;
									pending.row.outcome = cancelled ? "cancelled" : "unknown";
									pending.row.revision++;
								}
							});
						}
					};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	private base(operationId: string): UsageObservation {
		return {
			schemaVersion: 1,
			generation: this.configuration.generation,
			sourceId: this.sourceId!,
			operationId,
			revision: 1,
			kind: "request",
			scope: "direct",
			observedAt: Date.now(),
			coverage: "partial",
			purpose: this.configuration.purpose ?? "agent",
			...(this.configuration.attribution ? { attribution: structuredClone(this.configuration.attribution) } : {}),
			...(this.configuration.parent ? { parent: structuredClone(this.configuration.parent) } : {}),
		};
	}
	private async begin(state: CaptureScope, model: Parameters<Models["streamSimple"]>[0]): Promise<string | undefined> {
		if (!this.harness || !this.sourceId) return;
		try {
			if (this.acquireEpoch) {
				const epoch = await this.acquireEpoch();
				Object.assign(this.configuration, epoch);
				if (this.configuration.attribution) {
					if (epoch.mission) this.configuration.attribution.mission = epoch.mission;
					else delete this.configuration.attribution.mission;
				}
			}
			const id = randomUUID();
			const row = this.base(id);
			row.outcome = "unknown";
			row.attribution = {
				...row.attribution,
				attemptId: usageIdentity(this.sourceId, "attempt", state.runtime.conversationId),
			};
			const live = await state.runtime.snapshot(LiveDoc, state.runtime.conversationId, state.context);
			if (live?.run?.inputs[0]) {
				row.attribution.runId = usageIdentity(this.sourceId, "run", live.run.inputs[0]);
				const input = await this.harness.submission(live.run.inputs[0], state.context);
				const submitted = await input?.status(state.context);
				if (inputOrigin(submitted?.requestId) && this.configuration.purpose !== "control")
					row.purpose = "follow_up";
			}
			if (state.task.kind === "pi.compaction") row.purpose = "compaction";
			else if (state.task.kind !== "pi.generation") row.purpose = "other";
			const virtual = model.api === "pi-virtual" ? observedModel(model.provider, model.id) : undefined;
			if (virtual) row.virtualModel = virtual;
			const added = await this.journal.update((journal) => {
				journal.rows = journal.rows.filter(
					({ row }) =>
						row.observedAt >= Math.max(this.configuration.captureFloor, this.configuration.retentionFloor),
				);
				if (journal.rows.length < 30) {
					journal.rows.push({ row, settled: false });
					return true;
				}
				return false;
			});
			if (!added) return;
			state.operations.push(id);
			return id;
		} catch {
			return;
		}
	}
	private async response(
		state: CaptureScope,
		operationId: string,
		selected: Parameters<Models["streamSimple"]>[0],
		message: AssistantMessage,
		durationMs: number | undefined,
		physical?: UsageObservation["physicalModel"],
		attempts = 0,
	): Promise<void> {
		try {
			await this.journal.update((journal) => {
				const item = journal.rows.find(({ row }) => row.operationId === operationId);
				if (!item) return;
				const known = validResponseUsage(message);
				const at = Date.now();
				Object.assign(item.row, {
					revision: item.row.revision + 1,
					observedAt: at,
					...(known
						? {
								completedAt: at,
								requests: 1,
								tokens: usageTokens([message.usage]),
								cost: Number.isSafeInteger(Math.round(message.usage.cost.total * 1_000_000))
									? usageCost([message.usage])
									: usageCost([]),
							}
						: {}),
					...(durationMs === undefined ? {} : { durationMs }),
					outcome: deferredResponse(message)
						? "unknown"
						: message.stopReason === "aborted"
							? "cancelled"
							: message.stopReason === "error"
								? "failure"
								: "success",
				});
				if (deferredResponse(message) && state.task.id) item.pendingTaskId = state.task.id;
				else delete item.pendingTaskId;
				if (attempts) Object.assign(item.row, { providerAttempts: attempts, retries: attempts - 1 });
				const served =
					(known && (selected.api !== "pi-virtual" || message.provider !== selected.provider)
						? observedModel(message.provider, message.model)
						: undefined) ?? physical;
				if (served) item.row.physicalModel = served;
			});
			if (validResponseUsage(message))
				state.responses.push({ operationId, key: `${message.provider}/${message.model}`, usage: message.usage });
		} catch {
			/* No response report is not proof of zero usage. */
		}
	}
	private async settle(ids: string[]): Promise<void> {
		if (!ids.length) return;
		try {
			await this.journal.update((journal) => {
				for (const item of journal.rows) if (ids.includes(item.row.operationId)) item.settled = true;
			});
		} catch {
			/* Durable pending rows recover as unknown. */
		}
	}
	async flush(): Promise<void> {
		this.flushRequested = true;
		if (this.flushing) return this.flushing;
		this.flushing = (async () => {
			while (this.flushRequested) {
				this.flushRequested = false;
				await this.drain();
			}
		})().finally(() => {
			this.flushing = undefined;
		});
		return this.flushing;
	}
	private async drain(): Promise<void> {
		if (!this.harness) return;
		try {
			const journal = await this.journal.snapshot();
			const ack = new Map<string, number>();
			for (const item of journal?.rows ?? []) {
				if (!item.settled) continue;
				// A deferred request can still complete under this identity. Keep it in the
				// source outbox, not a dated chart or a kind-changing published checkpoint.
				if (item.pendingTaskId !== undefined) continue;
				// Unknown completion dates are reconciliation only. A settled non-deferred
				// invocation cannot later produce another response, so its kind stays fixed.
				await this.publish(
					item.row.kind === "request" && item.row.completedAt === undefined
						? { ...item.row, kind: "checkpoint" }
						: item.row,
				);
				// On recovery, an unfinished invocation is unknown. Never run inference/tools to fill the gap.
				ack.set(item.row.operationId, item.row.revision);
			}
			if (ack.size)
				await this.journal.update((state) => {
					state.rows = state.rows.filter(
						({ row, pendingTaskId }) => pendingTaskId !== undefined || ack.get(row.operationId) !== row.revision,
					);
				});
		} catch {
			/* Retain the same records and epochs for a later bounded replay. */
		}
	}
}

function validResponseUsage(message: AssistantMessage): boolean {
	if (deferredResponse(message)) return false;
	const usage = message.usage;
	const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
	if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return false;
	if (
		usage.reasoning !== undefined &&
		(!Number.isSafeInteger(usage.reasoning) || usage.reasoning < 0 || usage.reasoning > usage.output)
	)
		return false;
	// Native adapters synthesize zero-usage errors when no provider response exists. Do not
	// turn those into evidence of a free request. Real failed/cancelled usage still counts.
	const cost = usage.cost?.total;
	return (
		values.some((value) => value > 0) ||
		(Number.isFinite(cost) && cost > 0 && Number.isSafeInteger(Math.round(cost * 1_000_000))) ||
		!["error", "aborted"].includes(message.stopReason)
	);
}

function deferredResponse(message: AssistantMessage): boolean {
	return message.stopReason === "deferred" || message.stopReason === "pending";
}

function observedModel(provider: string, model: string): UsageObservation["physicalModel"] {
	const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
	return identifier.test(provider) &&
		!provider.includes(":") &&
		!provider.includes("/") &&
		identifier.test(model) &&
		!model.includes("://")
		? { provider, model }
		: undefined;
}

// The immutable bundled child adapter has no Harness-options injection. Install once on
// the shared SDK object, just as credential hooks do across native ESM and Jiti loaders.
const childHook = Symbol.for("pilot.usage-capture.child.v1");
type ChildCaptureSlot = { capture?: UsageCapture };
const childSDK = Harness as typeof Harness & { [childHook]?: ChildCaptureSlot };
export function installChildUsageCapture(publish: PublishUsage, acquireEpoch?: AcquireUsageEpoch): void {
	const sdk = childSDK;
	if (sdk[childHook] || !process.env.PILOT_USAGE_HISTORY) return;
	sdk[childHook] = {};
	const open = Harness.open;
	Harness.open = async (storage, options, context) => {
		let configuration: UsageCaptureConfiguration;
		try {
			configuration = JSON.parse(process.env.PILOT_USAGE_HISTORY!);
			if (process.env.PILOT_USAGE_PARENT) configuration.parent = JSON.parse(process.env.PILOT_USAGE_PARENT);
		} catch {
			return open(storage, options, context);
		}
		const directory = process.env.PILOT_USAGE_STORAGE;
		if (!directory) return open(storage, options, context);
		const capture = new UsageCapture(configuration, publish, acquireEpoch, join(directory, "usage-capture.json"));
		sdk[childHook]!.capture = capture;
		const harness = await open(
			storage,
			{ ...options, models: capture.deferredModels(options.models), registry: capture.registry(options.registry) },
			context,
		);
		await capture.bind(harness);
		return harness;
	};
}

/** Called before the child profile adds its offline retry wrapper. */
export function observeChildUsageStreams(target: Pick<Models, "stream" | "streamSimple">): void {
	if (!childSDK[childHook]) return;
	const original = { stream: target.stream.bind(target), streamSimple: target.streamSimple.bind(target) };
	const snapshot = new Proxy(target, {
		get(object, key) {
			if (key === "stream" || key === "streamSimple") return original[key];
			const value = Reflect.get(object, key, object);
			return typeof value === "function" ? value.bind(object) : value;
		},
	});
	let owner: UsageCapture | undefined;
	let wrapped: Models;
	const current = () => {
		const capture = childSDK[childHook]?.capture;
		if (capture && owner !== capture) {
			owner = capture;
			wrapped = capture.models(snapshot as Models);
		}
		return capture ? wrapped : undefined;
	};
	target.stream = (...args) => current()?.stream(...args) ?? original.stream(...args);
	target.streamSimple = (...args) => current()?.streamSimple(...args) ?? original.streamSimple(...args);
}
