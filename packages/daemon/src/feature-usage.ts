/** Bounded local aggregate storage. No raw events are retained or exported. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	FEATURE_NAMES,
	parseFeatureEvent,
	type FeatureUsageBatch,
	type FeatureUsageCell,
	type FeatureUsageSnapshot,
	type OperationHost,
} from "@pilot/protocol";
import { Conflict } from "./errors.ts";

const DAY = 86_400_000;
const LIMIT = 16;
const BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function exact(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function parseFeatureUsageBatch(value: unknown, now = Date.now()): FeatureUsageBatch {
	const fail = (): never => {
		throw new Conflict("Invalid feature aggregates");
	};
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
	const v = value as Record<string, unknown>;
	if (
		!exact(v, ["schemaVersion", "epoch", "producer", "revision", "startedAt", "observedAt", "cells", "dropped"]) ||
		v.schemaVersion !== 1 ||
		typeof v.epoch !== "string" ||
		!UUID.test(v.epoch) ||
		typeof v.producer !== "string" ||
		!UUID.test(v.producer) ||
		!Number.isSafeInteger(v.revision) ||
		(v.revision as number) < 0 ||
		!Number.isSafeInteger(v.dropped) ||
		(v.dropped as number) < 0 ||
		(v.dropped as number) > 1_000_000 ||
		typeof v.startedAt !== "string" ||
		typeof v.observedAt !== "string" ||
		!Number.isFinite(Date.parse(v.startedAt)) ||
		!Number.isFinite(Date.parse(v.observedAt)) ||
		Date.parse(v.startedAt) > Date.parse(v.observedAt) ||
		Date.parse(v.observedAt) > now + 60_000 ||
		!Array.isArray(v.cells) ||
		v.cells.length > 336
	)
		return fail();
	const seen = new Set<string>();
	let total = 0;
	const cells = v.cells.map((input): FeatureUsageCell => {
		if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
		const { day, count, ...event } = input as Record<string, unknown>;
		const parsed = parseFeatureEvent(event);
		if (
			!parsed ||
			typeof day !== "string" ||
			!/^\d{4}-\d{2}-\d{2}$/.test(day) ||
			!Number.isFinite(Date.parse(day)) ||
			new Date(day).toISOString().slice(0, 10) !== day ||
			day > v.observedAt!.toString().slice(0, 10) ||
			!Number.isSafeInteger(count) ||
			(count as number) <= 0 ||
			(total += count as number) > 70_000
		)
			return fail();
		const key = JSON.stringify({ day, ...parsed });
		if (seen.has(key)) return fail();
		seen.add(key);
		return { day, ...parsed, count: count as number };
	});
	return {
		schemaVersion: 1,
		epoch: v.epoch,
		producer: v.producer,
		revision: v.revision as number,
		startedAt: new Date(v.startedAt).toISOString(),
		observedAt: new Date(v.observedAt).toISOString(),
		cells,
		dropped: v.dropped as number,
	};
}

export class FeatureUsageStore {
	private enabled = false;
	private epoch: string = randomUUID();
	private enabledAt = new Date().toISOString();
	private batches = new Map<string, FeatureUsageBatch>();
	private pruned = 0;
	private unavailable = false;
	private saving = Promise.resolve();
	readonly file: string;
	private readonly now: () => number;
	private expiry?: NodeJS.Timeout;
	constructor(home: string, now = () => Date.now()) {
		this.file = join(home, "feature-usage.json");
		this.now = now;
		this.enabledAt = new Date(now()).toISOString();
	}
	get collectionEpoch(): string | undefined {
		return this.enabled ? this.epoch : undefined;
	}
	async load(enabled: boolean): Promise<void> {
		this.enabled = enabled;
		if (!enabled) {
			try {
				await this.clear();
			} catch {
				this.unavailable = true;
			}
			return;
		}
		try {
			const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
			let value: Record<string, unknown>;
			try {
				const stat = await handle.stat();
				if (!stat.isFile() || stat.size > BYTES) throw new Error("Invalid aggregates");
				const bytes = Buffer.alloc(BYTES + 1);
				const read = await handle.read(bytes, 0, bytes.length, 0);
				if (read.bytesRead > BYTES) throw new Error("Oversized aggregates");
				value = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
			} finally {
				await handle.close();
			}
			if (
				!exact(value, ["schemaVersion", "epoch", "enabledAt", "pruned", "batches"]) ||
				value.schemaVersion !== 1 ||
				typeof value.epoch !== "string" ||
				!UUID.test(value.epoch) ||
				typeof value.enabledAt !== "string" ||
				!Number.isFinite(Date.parse(value.enabledAt)) ||
				!Number.isSafeInteger(value.pruned) ||
				(value.pruned as number) < 0 ||
				!Array.isArray(value.batches) ||
				value.batches.length > LIMIT
			)
				throw new Error("Invalid aggregates");
			const batches = value.batches.map((v) => parseFeatureUsageBatch(v, this.now()));
			if (
				batches.some((v) => v.epoch !== value.epoch) ||
				new Set(batches.map((v) => v.producer)).size !== batches.length
			)
				throw new Error("Invalid aggregates");
			this.epoch = value.epoch;
			this.enabledAt = value.enabledAt;
			this.pruned = value.pruned as number;
			this.batches = new Map(batches.map((v) => [v.producer, v]));
			this.prune();
			await this.persist();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unavailable = true;
		}
	}
	async configure(enabled: boolean): Promise<void> {
		if (this.enabled === enabled && (enabled || !this.unavailable)) return;
		this.enabled = enabled;
		await this.clear();
	}
	async clear(): Promise<void> {
		clearTimeout(this.expiry);
		this.expiry = undefined;
		this.epoch = randomUUID();
		this.enabledAt = new Date(this.now()).toISOString();
		this.batches.clear();
		this.pruned = 0;
		this.unavailable = false;
		await this.saving.catch(() => undefined);
		try {
			await rm(this.file, { force: true });
		} catch (error) {
			this.unavailable = true;
			throw error;
		}
		if (this.enabled) await this.persist();
	}
	async replace(input: unknown): Promise<void> {
		const batch = parseFeatureUsageBatch(input, this.now());
		if (!this.enabled || batch.epoch !== this.epoch) throw new Conflict("Feature collection is disabled or changed");
		if (batch.observedAt.slice(0, 10) < this.cutoff()) throw new Conflict("Feature aggregates expired");
		batch.cells = batch.cells.filter((cell) => cell.day >= this.cutoff());
		const previous = this.batches.get(batch.producer);
		if (previous && batch.revision <= previous.revision) return;
		this.prune();
		if (!previous && this.batches.size >= LIMIT) {
			this.batches.delete(this.batches.keys().next().value!);
			this.pruned++;
		}
		this.batches.set(batch.producer, batch);
		await this.persist();
	}
	snapshot(host: OperationHost): FeatureUsageSnapshot {
		this.prune();
		const cells = new Map<string, FeatureUsageCell>();
		const batches = [...this.batches.values()];
		for (const batch of batches)
			for (const cell of batch.cells) {
				const { count, ...keyParts } = cell;
				const key = JSON.stringify(keyParts);
				cells.set(key, { ...cell, count: count + (cells.get(key)?.count ?? 0) });
			}
		return {
			schemaVersion: 1,
			host,
			catalogVersion: 1,
			features: FEATURE_NAMES,
			scope: "native_ui_observations_across_chats",
			status: !this.enabled ? "disabled" : this.unavailable || batches.length === 0 ? "unavailable" : "partial",
			...(this.unavailable || (this.enabled && batches.length === 0)
				? { reason: this.unavailable ? ("storage_unavailable" as const) : ("no_producer" as const) }
				: {}),
			collectedAt: new Date(this.now()).toISOString(),
			...(this.enabled ? { enabledAt: this.enabledAt } : {}),
			...(batches.length
				? {
						observedFrom: batches.map((v) => v.startedAt).sort()[0],
						observedThrough: batches
							.map((v) => v.observedAt)
							.sort()
							.at(-1),
					}
				: {}),
			retentionDays: 7,
			retainedFrom: this.cutoff(),
			producerLimit: 16,
			observedProducers: batches.length,
			dropCoverage: "retained_producer_reports_only",
			prunedProducers: this.pruned,
			dropped: batches.reduce((sum, batch) => sum + batch.dropped, 0),
			cells: [...cells.values()],
		};
	}
	private cutoff(): string {
		return new Date(this.now() - 6 * DAY).toISOString().slice(0, 10);
	}
	private prune(): void {
		const cutoff = this.cutoff();
		for (const [id, batch] of this.batches) {
			if (batch.observedAt.slice(0, 10) < cutoff) {
				this.batches.delete(id);
				continue;
			}
			batch.cells = batch.cells.filter((v) => v.day >= cutoff);
		}
	}
	private async persist(): Promise<void> {
		this.scheduleExpiry();
		const value = JSON.stringify({
			schemaVersion: 1,
			epoch: this.epoch,
			enabledAt: this.enabledAt,
			pruned: this.pruned,
			batches: [...this.batches.values()],
		});
		if (Buffer.byteLength(value) > BYTES) {
			this.unavailable = true;
			throw new Error("Aggregate limit");
		}
		this.saving = this.saving
			.catch(() => undefined)
			.then(async () => {
				await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
				const temporary = `${this.file}.tmp`;
				await writeFile(temporary, value, { mode: 0o600 });
				await chmod(temporary, 0o600);
				await rename(temporary, this.file);
			})
			.catch((error) => {
				this.unavailable = true;
				throw error;
			});
		await this.saving;
	}
	private scheduleExpiry(): void {
		if (!this.enabled || this.expiry) return;
		const delay = DAY - (this.now() % DAY) + 1;
		this.expiry = setTimeout(() => {
			this.expiry = undefined;
			this.prune();
			void this.persist().catch(() => undefined);
		}, delay);
		this.expiry.unref();
	}
	async close(): Promise<void> {
		clearTimeout(this.expiry);
		this.expiry = undefined;
		await this.saving.catch(() => undefined);
	}
}
