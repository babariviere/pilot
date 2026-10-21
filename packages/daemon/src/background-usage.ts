/** Local-only accounting for separate daemon completions. Never accepts request content. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { UsageObservation } from "@pilot/protocol";
import manifest from "../package.json" with { type: "json" };
import { durableJSON } from "./operation-journal.ts";
import type { UsageHistoryStore } from "./usage-history.ts";
import { parseUsageObservation, safeUsageInteger, usageIdentifier, usageUUID } from "./usage-history-validation.ts";

export type BackgroundAttribution = UsageObservation["attribution"];
export type CompletionRuntime = Pick<ModelRuntime, "completeSimple">;
type Arguments = Parameters<ModelRuntime["completeSimple"]>;
type Evidence = Pick<
	UsageObservation,
	"tokens" | "cost" | "physicalModel" | "virtualModel" | "outcome" | "providerAttempts" | "retries" | "requests"
>;
const PRICING = `pi-ai@${manifest.dependencies["@earendil-works/pi-ai"]}`;
export const BACKGROUND_USAGE_LIMIT = 32;
const EMPTY = {
	cost: { estimateStatus: "unavailable", billedStatus: "unavailable", subscriptionCoverage: "unknown" },
} as const;

export interface BackgroundCapture {
	close?(): Promise<void>;
	runtime(
		runtime: CompletionRuntime,
		purpose: UsageObservation["purpose"],
		attribution?: BackgroundAttribution,
	): CompletionRuntime;
}

/** Project paths are not identities. Callers supply only authoritative structured UUIDs. */
function attribution(value?: BackgroundAttribution): BackgroundAttribution {
	if (!value) return;
	const result: NonNullable<BackgroundAttribution> = {};
	for (const key of ["projectId", "chatId", "runId"] as const) if (usageUUID(value[key])) result[key] = value[key];
	const m = value.mission;
	if (m && usageUUID(m.homeId) && usageUUID(m.lineageId) && usageUUID(m.missionId))
		result.mission = { homeId: m.homeId, lineageId: m.lineageId, missionId: m.missionId };
	return Object.keys(result).length ? result : undefined;
}

/** Synchronously strip all content/errors/native payloads before any async storage or worker message. */
export function backgroundEvidence(result: AssistantMessage | undefined): Evidence {
	const evidence: Evidence = { ...EMPTY, outcome: "unknown" };
	if (!result) return evidence;
	evidence.requests = 1;
	evidence.outcome =
		result.stopReason === "aborted" ? "cancelled" : result.stopReason === "error" ? "failure" : "success";
	if (usageIdentifier(result.provider) && !/[/:]/.test(result.provider) && usageIdentifier(result.model)) {
		const key = result.api === "pi-virtual" ? "virtualModel" : "physicalModel";
		evidence[key] = { provider: result.provider, model: result.model };
	}
	const u = result.usage;
	if (!u) return evidence;
	if (
		[u.input, u.output, u.cacheRead, u.cacheWrite].every(safeUsageInteger) &&
		[u.input, u.output, u.cacheRead, u.cacheWrite].some((value) => value > 0)
	)
		evidence.tokens = {
			input: u.input,
			output: u.output,
			cacheRead: u.cacheRead,
			cacheWrite: u.cacheWrite,
			...(safeUsageInteger(u.reasoning) && u.reasoning <= u.output
				? { reasoning: u.reasoning, reasoningStatus: "reported" as const }
				: { reasoningStatus: "unavailable" as const }),
		};
	const total = u.cost?.total;
	const micros = typeof total === "number" ? Math.round(total * 1_000_000) : NaN;
	// Zero placeholders, invalid costs and missing response usage are not evidence of free inference.
	if (typeof total === "number" && total > 0 && safeUsageInteger(micros)) {
		const fullyPriced = (["input", "output", "cacheRead", "cacheWrite"] as const).every(
			(key) => safeUsageInteger(u[key]) && (u[key] === 0 || (Number.isFinite(u.cost[key]) && u.cost[key] > 0)),
		);
		evidence.cost = {
			estimateStatus: fullyPriced ? "catalog_estimate" : "partial_catalog_estimate",
			estimatedUsdMicros: micros,
			pricingRevision: PRICING,
			billedStatus: "unavailable",
			subscriptionCoverage: "unknown",
		};
	}
	return evidence;
}

/** Observe the normalized response before caller parsing, cancellation checks, diagnostics or application. */
export function observedBackgroundRuntime(
	runtime: CompletionRuntime,
	observe: (evidence: Evidence) => Promise<void>,
): CompletionRuntime {
	return {
		completeSimple: async (...args: Arguments) => {
			let responses = 0;
			const [model, context, options] = args;
			try {
				const result = await runtime.completeSimple(model, context, {
					...options,
					onResponse: async (response, physical) => {
						responses = Math.min(101, responses + 1);
						await options?.onResponse?.(response, physical);
					},
				});
				const evidence = backgroundEvidence(result);
				if (
					model.api === "pi-virtual" &&
					usageIdentifier(model.provider) &&
					!/[/:]/.test(model.provider) &&
					usageIdentifier(model.id)
				)
					evidence.virtualModel = { provider: model.provider, model: model.id };
				if (responses > 0 && responses <= 100) {
					evidence.providerAttempts = responses;
					evidence.retries = responses - 1;
				}
				await observe(evidence).catch(() => undefined);
				return result;
			} catch (error) {
				const evidence = backgroundEvidence(undefined);
				evidence.outcome = options?.signal?.aborted ? "cancelled" : "failure";
				if (responses > 0 && responses <= 100) {
					evidence.providerAttempts = responses;
					evidence.retries = responses - 1;
				}
				await observe(evidence).catch(() => undefined);
				throw error;
			}
		},
	};
}

/** A bounded durable outbox, not historical storage. One owner in the execution host's daemon.
 * A crash before response persistence leaves an explicitly unknown partial request. Recovery never infers again.
 */
export class BackgroundUsage implements BackgroundCapture {
	private readonly directory: string;
	private readonly rows = new Map<string, UsageObservation | undefined>();
	private generation?: string;
	private writes: Promise<unknown> = Promise.resolve();
	private readonly detach: () => void;
	private readonly store: UsageHistoryStore;
	private readonly now: () => number;
	private initialized?: Promise<void>;
	private disabled = false;
	private closed = false;
	private readonly pending = new Set<Promise<unknown>>();
	constructor(home: string, store: UsageHistoryStore, now = Date.now) {
		this.store = store;
		this.now = now;
		this.detach = store.onErasure(async (status) => {
			this.generation = status.generation;
			// Serialize the purge with atomic source writes, including crash-left/corrupt source files.
			const purge = this.writes.then(async () => {
				const directory = await opendir(this.directory).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return undefined;
					throw new Error("Background accounting unavailable");
				});
				if (!directory) return;
				let files = 0;
				for await (const entry of directory) {
					if (++files > BACKGROUND_USAGE_LIMIT * 2) throw new Error("Background accounting unavailable");
					const id = entry.name.slice(0, 36);
					if (!usageUUID(id) || !/^[0-9a-f-]{36}\.json(?:\.[0-9a-f-]{36}\.tmp)?$/i.test(entry.name)) continue;
					if (this.rows.get(id)?.generation === status.generation) continue;
					await unlink(join(this.directory, entry.name));
					this.rows.delete(id);
				}
			});
			this.writes = purge.catch(() => undefined);
			await purge;
		});
		this.directory = join(home, "accounting", "background-pending");
	}
	private file(id: string): string {
		return join(this.directory, `${id}.json`);
	}
	async ready(): Promise<void> {
		this.initialized ??= this.recover().catch(() => {
			this.disabled = true;
			this.store.rejectCapture();
		});
		await this.initialized;
	}
	private async recover(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(join(this.directory, ".."), 0o700);
		await chmod(this.directory, 0o700);
		const directory = await opendir(this.directory);
		let files = 0;
		let records = 0;
		for await (const entry of directory) {
			if (++files > BACKGROUND_USAGE_LIMIT * 2) throw new Error("Background accounting unavailable");
			const name = entry.name;
			if (/^[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/.test(name)) {
				await unlink(join(this.directory, name));
				continue;
			}
			if (!name.endsWith(".json") || !usageUUID(name.slice(0, -5))) continue;
			const handle = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
			let row: UsageObservation;
			try {
				const stat = await handle.stat();
				if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid background accounting");
				row = parseUsageObservation(JSON.parse(await handle.readFile("utf8")));
			} finally {
				await handle.close();
			}
			if (row.sourceId !== name.slice(0, -5) || ++records > BACKGROUND_USAGE_LIMIT)
				throw new Error("Invalid background accounting");
			this.generation ??= (await this.store.status()).generation;
			this.rows.set(row.sourceId, row);
			await this.publish(row);
		}
	}
	private async publish(row: UsageObservation): Promise<void> {
		const status = await this.store.status();
		if (
			row.generation !== this.generation ||
			row.generation !== status.generation ||
			row.observedAt < Math.max(status.captureFloor, status.retentionFloor)
		) {
			await this.remove(row.sourceId);
			return;
		}
		const result = await this.store.put(
			row.completedAt === undefined ? { ...row, kind: "checkpoint", operationId: "background:partial" } : row,
		);
		if (row.generation !== this.generation || result === "stored" || result === "duplicate" || result === "stale")
			await this.remove(row.sourceId);
	}
	private async remove(id: string): Promise<void> {
		await unlink(this.file(id)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		this.rows.delete(id);
	}
	private persist(row: UsageObservation): Promise<boolean> {
		const write = this.writes.then(async () => {
			if (this.generation !== row.generation) return false;
			await durableJSON(this.file(row.sourceId), row);
			return true;
		});
		this.writes = write.catch(() => undefined);
		return write;
	}
	/** Bounded latency as well as bounded admission. Late I/O retains only a content-free record. */
	private async bounded<T>(task: Promise<T>): Promise<T | undefined> {
		this.pending.add(task);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				task.catch(() => undefined),
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), 1000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			void task.finally(() => this.pending.delete(task)).catch(() => undefined);
		}
	}
	/** Admission precedes dispatch and persists the erasure epoch. A failed observer never blocks inference. */
	async begin(
		purpose: UsageObservation["purpose"],
		owner?: BackgroundAttribution,
	): Promise<((evidence: Evidence) => Promise<void>) | undefined> {
		if (this.closed) return;
		if (this.disabled || this.rows.size >= BACKGROUND_USAGE_LIMIT) {
			this.store.rejectCapture();
			return;
		}
		const id = randomUUID();
		this.rows.set(id, undefined);
		let dispatched = false;
		const admission = (async () => {
			await this.ready();
			if (this.disabled || dispatched || this.rows.size > BACKGROUND_USAGE_LIMIT) {
				this.rows.delete(id);
				this.store.rejectCapture();
				return;
			}
			const status = await this.store.status();
			if (dispatched) {
				this.rows.delete(id);
				return;
			}
			this.generation ??= status.generation;
			const at = this.now();
			const row = parseUsageObservation({
				schemaVersion: 1,
				generation: status.generation,
				sourceId: id,
				operationId: "background",
				revision: 1,
				kind: "request",
				scope: "direct",
				observedAt: at,
				coverage: "partial",
				purpose,
				attribution: attribution(owner),
				outcome: "unknown",
			});
			if (!(await this.persist(row))) {
				this.rows.delete(id);
				return;
			}
			if (row.generation !== this.generation) return;
			this.rows.set(id, row);
			// Pending dispatches stay source-only; after a crash they recover as undated checkpoints.
			return row;
		})().catch(() => {
			this.disabled = true;
			this.store.rejectCapture();
			return undefined;
		});
		await this.bounded(admission);
		dispatched = true;
		let finished = false;
		return async (evidence) => {
			if (finished || this.closed) return;
			finished = true;
			const at = this.now();
			const write = admission.then(async (row) => {
				if (this.closed || !row || row.generation !== this.generation) return;
				const complete = parseUsageObservation({
					...row,
					tokens: evidence.tokens,
					cost: evidence.cost,
					physicalModel: evidence.physicalModel,
					virtualModel: evidence.virtualModel,
					outcome: evidence.outcome,
					providerAttempts: evidence.providerAttempts,
					retries: evidence.retries,
					revision: 2,
					observedAt: at,
					completedAt: at,
					durationMs: Math.max(0, at - row.observedAt),
					requests: evidence.requests,
				});
				if (!(await this.persist(complete))) return;
				if (row.generation !== this.generation) return;
				this.rows.set(id, complete);
				await this.publish(complete);
			});
			await this.bounded(write);
		};
	}
	runtime(
		runtime: CompletionRuntime,
		purpose: UsageObservation["purpose"],
		owner?: BackgroundAttribution,
	): CompletionRuntime {
		return {
			completeSimple: async (...args: Arguments) => {
				const observe = await this.begin(purpose, owner).catch(() => undefined);
				return observe
					? observedBackgroundRuntime(runtime, observe).completeSimple(...args)
					: runtime.completeSimple(...args);
			},
		};
	}
	async close(): Promise<void> {
		this.closed = true;
		await this.initialized;
		await Promise.allSettled(this.pending);
		await this.writes;
		this.detach();
	}
}
