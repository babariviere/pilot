import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DurableOperation, OperationHost, OperationReceipt } from "@pilot/protocol";

const MAX_PAYLOAD = 64 * 1024;
const MAX_RECORDS = 4096;
const MAX_STREAMS = 1024;
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
export const payloadHash = (payload: string): string => createHash("sha256").update(payload).digest("hex");
export function canonicalJSON(value: unknown): string {
	return JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
			: item,
	);
}
const streamKey = (op: DurableOperation): string => payloadHash(canonicalJSON([op.origin, op.producerId]));
export const sameHost = (a: OperationHost, b: OperationHost): boolean =>
	a.daemonId === b.daemonId && a.lineageId === b.lineageId;
export class OperationConflict extends Error {}
export class OperationExpired extends Error {}
export class OperationRejected extends Error {
	readonly result?: unknown;
	constructor(message: string, result?: unknown) {
		super(message);
		this.result = result;
	}
}
interface StoredOperation {
	operation: DurableOperation;
	receipt: OperationReceipt;
}

/** Async fsync + atomic publication, including directory durability. No SQLite on the daemon loop. */
export async function durableJSON(file: string, value: unknown): Promise<void> {
	const temp = `${file}.${randomUUID()}.tmp`;
	const handle = await open(temp, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(value));
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, file);
		const directory = await open(join(file, ".."), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await unlink(temp).catch(() => {});
	}
}

/** One owner per daemon data home, like SessionManager. Bounded admission, no TTL eviction.
 * Handlers MUST materialize the stable target and use operationId for downstream deduplication.
 * An exception leaves a recoverable pending receipt, not a possibly false rejection.
 */
export class OperationJournal {
	private readonly settledListeners = new Set<(operation: DurableOperation) => void>();
	/** Invalidations follow durable final receipt publication, never merely handler entry. */
	onSettled(listener: (operation: DurableOperation) => void): () => void {
		this.settledListeners.add(listener);
		return () => this.settledListeners.delete(listener);
	}
	private readonly records = new Map<string, StoredOperation>();
	private readonly sequences = new Map<string, string>();
	private floors: Record<string, number> = {};
	private initialized?: Promise<void>;
	private directoryReady?: Promise<void>;
	private readonly retiredFiles = new Set<string>();
	private queue: Promise<unknown> = Promise.resolve();
	private queued = 0;
	private legacyInsightsReservations = 0;
	private fault?: unknown;
	private readonly running = new Map<string, Promise<OperationReceipt>>();
	private readonly directory: string;
	readonly destination: OperationHost;
	constructor(directory: string, destination: OperationHost) {
		this.directory = directory;
		this.destination = destination;
	}

	private async init(): Promise<void> {
		this.initialized ??= (async () => {
			try {
				if ((await stat(join(this.directory, "floors.json"))).size > 128 * 1024)
					throw new Error("Oversized replay floors");
				this.floors = JSON.parse(await readFile(join(this.directory, "floors.json"), "utf8"));
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			}
			if (
				!this.floors ||
				Array.isArray(this.floors) ||
				Object.keys(this.floors).length > MAX_STREAMS ||
				Object.entries(this.floors).some(
					([key, value]) => !/^[0-9a-f]{64}$/.test(key) || !Number.isSafeInteger(value) || value < 1,
				)
			)
				throw new Error("Invalid replay floors");
			const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			});
			if (files.filter((f) => f.endsWith(".json") && f !== "floors.json").length > MAX_RECORDS)
				throw new Error("Operation journal capacity exceeded");
			for (const file of files) {
				if (!/^[0-9a-f]{64}.json$/.test(file)) continue;
				if ((await stat(join(this.directory, file))).size > MAX_PAYLOAD * 2)
					throw new Error("Oversized operation record");
				const record = JSON.parse(await readFile(join(this.directory, file), "utf8")) as StoredOperation;
				this.validate(record.operation);
				const op = record.operation;
				if (
					file !== `${payloadHash(op.operationId)}.json` ||
					record.receipt.operationId !== op.operationId ||
					record.receipt.payloadHash !== op.payloadHash ||
					record.receipt.targetId !== op.targetId ||
					canonicalJSON(record.receipt.destination) !== canonicalJSON(op.destination) ||
					!["pending", "accepted", "rejected"].includes(record.receipt.state)
				)
					throw new Error("Corrupt operation receipt");
				if (op.sequence <= (this.floors[streamKey(op)] ?? 0)) {
					// A durable floor already retires this record. Passive lookup never cleans up files.
					this.retiredFiles.add(file);
					continue;
				}
				if (this.records.has(op.operationId) || this.sequences.has(`${streamKey(op)}:${op.sequence}`))
					throw new Error("Duplicate operation reservation");
				this.records.set(op.operationId, record);
				this.sequences.set(`${streamKey(op)}:${op.sequence}`, op.operationId);
			}
		})();
		await this.initialized;
	}
	private validate(op: DurableOperation): void {
		if (Buffer.byteLength(JSON.stringify(op) ?? "") > MAX_PAYLOAD + 4096)
			throw new OperationConflict("Oversized operation envelope");
		if (
			op?.schemaVersion !== 1 ||
			!identifier.test(op.operationId) ||
			!identifier.test(op.producerId) ||
			!Number.isSafeInteger(op.sequence) ||
			op.sequence < 1 ||
			!identifier.test(op.targetId) ||
			typeof op.kind !== "string" ||
			!/^[A-Za-z0-9_.-]{1,128}$/.test(op.kind) ||
			typeof op.payload !== "string" ||
			Buffer.byteLength(op.payload) > MAX_PAYLOAD ||
			payloadHash(op.payload) !== op.payloadHash
		)
			throw new OperationConflict("Invalid immutable operation");
		for (const host of [op.origin, op.destination])
			if (
				!host ||
				![host.hostId, host.daemonId, host.lineageId].every((id) => typeof id === "string" && identifier.test(id))
			)
				throw new OperationConflict("Invalid operation lineage");
		if (!sameHost(op.destination, this.destination)) throw new OperationConflict("Destination lineage changed");
		if (
			op.bindingId !== undefined &&
			(!identifier.test(op.bindingId) || !Number.isSafeInteger(op.bindingGeneration) || op.bindingGeneration! < 1)
		)
			throw new OperationConflict("Invalid binding fence");
	}
	private async prepareDirectory(): Promise<void> {
		this.directoryReady ??= (async () => {
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			const parent = await open(join(this.directory, ".."), "r");
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		})();
		await this.directoryReady;
	}
	private async cleanRetired(): Promise<void> {
		for (const file of this.retiredFiles) {
			await unlink(join(this.directory, file));
			this.retiredFiles.delete(file);
		}
	}
	private serial<T>(action: () => Promise<T>): Promise<T> {
		if (this.queued >= 64) return Promise.reject(new Error("Operation journal busy"));
		this.queued++;
		const next = this.queue
			.catch(() => {})
			.then(() => {
				if (this.fault)
					throw new Error("Operation journal requires recovery after a disk failure", { cause: this.fault });
				return action();
			})
			.finally(() => {
				this.queued--;
			});
		this.queue = next;
		return next;
	}
	private async persist(file: string, value: unknown): Promise<void> {
		try {
			await durableJSON(file, value);
		} catch (error) {
			this.fault = error;
			throw error;
		}
	}
	private checked(op: DurableOperation): StoredOperation | undefined {
		this.validate(op);
		if (op.sequence <= (this.floors[streamKey(op)] ?? 0)) throw new OperationExpired("Operation ID retired");
		const record = this.records.get(op.operationId);
		if (record && canonicalJSON(record.operation) !== canonicalJSON(op))
			throw new OperationConflict("Operation ID already has different immutable bytes");
		const seq = this.sequences.get(`${streamKey(op)}:${op.sequence}`);
		if (seq && seq !== op.operationId) throw new OperationConflict("Producer sequence already reserved");
		return record;
	}
	async lookup(op: DurableOperation): Promise<OperationReceipt | undefined> {
		op = structuredClone(op);
		return this.serial(async () => {
			await this.init();
			return structuredClone(this.checked(op)?.receipt);
		});
	}
	async targetReceipts(kind: string, targetId: string): Promise<OperationReceipt[]> {
		return this.serial(async () => {
			await this.init();
			return structuredClone(
				[...this.records.values()]
					.filter((r) => r.operation.kind === kind && r.operation.targetId === targetId)
					.map((r) => r.receipt),
			);
		});
	}
	/** Bounded private projection for one replacement. Never expose operation payloads to clients. */
	async replacementReferences(projectId: string, missionId: string, oldId: string, excludeId?: string) {
		return this.serial(async () => {
			await this.init();
			const items: import("@pilot/protocol").InsightsReplacementReference[] = [];
			let qualified = false;
			const qualifications: Array<{ context: unknown; home: unknown }> = [];
			for (const { operation: op, receipt } of this.records.values()) {
				if (op.operationId === excludeId || receipt.state === "rejected") continue;
				if (op.targetId !== oldId && !op.kind.startsWith("insights-")) continue;
				let p: Record<string, unknown> | undefined;
				try {
					if (op.kind.startsWith("insights-")) p = JSON.parse(op.payload);
				} catch {
					/* Unparseable target intent still fences. */
				}
				// Marker-less contenders have entered no effect. The synchronous scope owner and
				// durable CAS choose one. Passive preview still refuses these pending contenders.
				if (
					excludeId &&
					op.kind === "insights-replace" &&
					p?.oldSessionId === oldId &&
					receipt.state === "pending" &&
					receipt.result === undefined
				)
					continue;
				const scope = op.kind.startsWith("insights-") && p?.projectId === projectId && p?.missionId === missionId;
				if (op.targetId !== oldId && !scope) continue;
				if (items.length === 32) return { items, overflow: true, qualified, qualifications };
				items.push({
					operationId: op.operationId,
					kind: op.kind,
					targetId: op.targetId,
					state: receipt.state,
					payloadHash: op.payloadHash,
				});
				if (
					scope &&
					op.targetId === oldId &&
					receipt.state === "accepted" &&
					(op.kind === "insights-enable" || (op.kind === "insights-replace" && p?.successorSessionId === oldId))
				) {
					qualified = true;
					qualifications.push({ context: p!.context, home: p!.expectedHome });
				}
			}
			return { items, overflow: false, qualified, qualifications };
		});
	}
	/** Retained intent is a refusal fence, not proof a resource still exists or a grant remains valid. */
	async legacyInsightsGuard(): Promise<() => void> {
		await this.serial(() => this.init());
		// Check live reservations synchronously again at the owner transaction boundary.
		// A prior absent observation is never authority to ignore a later v1 reservation.
		return () => {
			if (this.fault) throw new OperationConflict("Insights journal is unavailable");
			if (this.legacyInsightsReservations) throw new OperationConflict("insights_journal_busy_refresh");
			for (const { operation, receipt } of this.records.values())
				if (
					operation.kind.startsWith("insights-") &&
					!operation.kind.startsWith("insights-workspace-") &&
					receipt.state !== "rejected"
				)
					throw new OperationConflict("legacy_transition_required");
		};
	}
	/** Retained intent is a refusal fence, not proof a resource still exists or a grant remains valid. */
	async retainedTargets(
		kinds: readonly string[],
		fields: Readonly<Record<string, string>>,
		excludeOperationId?: string,
	): Promise<string[]> {
		const selectors = Object.entries(fields);
		const allowed = new Set(kinds);
		return this.serial(async () => {
			await this.init();
			const targets = new Set<string>();
			for (const { operation, receipt } of this.records.values()) {
				if (
					!allowed.has(operation.kind) ||
					receipt.state === "rejected" ||
					operation.operationId === excludeOperationId
				)
					continue;
				try {
					const payload = JSON.parse(operation.payload);
					if (
						payload &&
						typeof payload === "object" &&
						!Array.isArray(payload) &&
						selectors.every(([key, value]) => payload[key] === value)
					)
						targets.add(operation.targetId);
				} catch {
					/* Non-object operation payloads cannot establish these identity references. */
				}
			}
			return [...targets];
		});
	}
	private async reserveEntry(op: DurableOperation): Promise<{ receipt: OperationReceipt; firstEntry: boolean }> {
		op = structuredClone(op);
		const legacyInsights =
			typeof op.kind === "string" && op.kind.startsWith("insights-") && !op.kind.startsWith("insights-workspace-");
		if (legacyInsights) this.legacyInsightsReservations++;
		return this.serial(async () => {
			await this.init();
			await this.cleanRetired();
			const existing = this.checked(op);
			if (existing) return { receipt: structuredClone(existing.receipt), firstEntry: false };
			if (this.records.size >= MAX_RECORDS) throw new Error("Operation receipt retention is full");
			await this.prepareDirectory();
			const record: StoredOperation = {
				operation: structuredClone(op),
				receipt: {
					operationId: op.operationId,
					payloadHash: op.payloadHash,
					destination: op.destination,
					targetId: op.targetId,
					state: "pending",
				},
			};
			await this.persist(join(this.directory, `${payloadHash(op.operationId)}.json`), record);
			this.records.set(op.operationId, record);
			this.sequences.set(`${streamKey(op)}:${op.sequence}`, op.operationId);
			return { receipt: structuredClone(record.receipt), firstEntry: true };
		}).finally(() => {
			if (legacyInsights) this.legacyInsightsReservations--;
		});
	}
	async reserve(op: DurableOperation): Promise<OperationReceipt> {
		return (await this.reserveEntry(op)).receipt;
	}
	async execute(
		op: DurableOperation,
		handler: (op: DurableOperation, entry: { firstEntry: boolean }) => Promise<unknown>,
	): Promise<OperationReceipt> {
		op = structuredClone(op);
		// Only this atomic reservation can identify a new confirmation. A pending record,
		// even one without an effect checkpoint, is never fresh authority on re-entry.
		const { receipt, firstEntry } = await this.reserveEntry(op);
		if (receipt.state !== "pending") return receipt;
		const running = this.running.get(op.operationId);
		if (running) return running;
		if (this.running.size >= 4) return receipt;
		const work = (async () => {
			let result: unknown;
			let reason: string | undefined;
			try {
				result = await handler(structuredClone(op), { firstEntry });
			} catch (e) {
				if (!(e instanceof OperationRejected)) return (await this.lookup(op))!;
				reason = e.message.slice(0, 512);
				result = e.result;
			}
			return this.serial(async () => {
				const previous = this.checked(op)!;
				const updated: StoredOperation = {
					operation: previous.operation,
					receipt: {
						...previous.receipt,
						state: reason === undefined ? "accepted" : "rejected",
						...(reason === undefined ? { result } : { reason, ...(result === undefined ? {} : { result }) }),
					},
				};
				if (Buffer.byteLength(JSON.stringify(updated)) > MAX_PAYLOAD * 2) throw new Error("Receipt too large");
				await this.persist(join(this.directory, `${payloadHash(op.operationId)}.json`), updated);
				this.records.set(op.operationId, updated);
				for (const listener of this.settledListeners) {
					try {
						listener(structuredClone(op));
					} catch {
						/* Observers cannot undo a durable receipt. */
					}
				}
				return structuredClone(updated.receipt);
			});
		})().finally(() => {
			this.running.delete(op.operationId);
		});
		this.running.set(op.operationId, work);
		return work;
	}
	/** Durable bounded progress before entering an effect. Lookup never invokes a handler. */
	async checkpoint(op: DurableOperation, result: unknown): Promise<void> {
		const snapshot = structuredClone(result);
		await this.serial(async () => {
			await this.init();
			const previous = this.checked(op);
			if (previous?.receipt.state !== "pending") throw new OperationConflict("Operation is not pending");
			const updated = { operation: previous.operation, receipt: { ...previous.receipt, result: snapshot } };
			if (Buffer.byteLength(JSON.stringify(updated)) > MAX_PAYLOAD * 2)
				throw new OperationConflict("Receipt too large");
			await this.persist(join(this.directory, `${payloadHash(op.operationId)}.json`), updated);
			this.records.set(op.operationId, updated);
		});
	}
	async recover(
		handler: (op: DurableOperation) => Promise<unknown>,
		eligible: (op: Readonly<DurableOperation>) => boolean = () => true,
	): Promise<void> {
		await this.serial(async () => {
			await this.init();
			await this.cleanRetired();
		});
		const pending = [...this.records.values()].filter(
			({ receipt, operation }) => receipt.state === "pending" && eligible(operation),
		);
		let cursor = 0;
		await Promise.all(
			Array.from({ length: Math.min(4, pending.length) }, async () => {
				for (;;) {
					const record = pending[cursor++];
					if (!record) return;
					await this.execute(record.operation, handler);
				}
			}),
		);
	}
	/** Only a durable peer-acknowledged prefix may retire. Persist rejection floor BEFORE deleting receipts. */
	async retire(origin: OperationHost, producerId: string, through: number): Promise<void> {
		await this.serial(async () => {
			await this.init();
			if (!Number.isSafeInteger(through) || through < 1) throw new OperationConflict("Invalid replay floor");
			const key = payloadHash(canonicalJSON([origin, producerId]));
			if (!(key in this.floors) && Object.keys(this.floors).length >= MAX_STREAMS)
				throw new Error("Replay floor capacity full");
			const records = [...this.records.values()].filter(
				({ operation }) => streamKey(operation) === key && operation.sequence <= through,
			);
			if (records.some(({ receipt }) => receipt.state === "pending"))
				throw new OperationConflict("Pending operations cannot retire");
			const floors = { ...this.floors, [key]: Math.max(this.floors[key] ?? 0, through) };
			await this.prepareDirectory();
			await this.persist(join(this.directory, "floors.json"), floors);
			this.floors = floors;
			for (const { operation } of records) {
				await unlink(join(this.directory, `${payloadHash(operation.operationId)}.json`));
				this.records.delete(operation.operationId);
				this.sequences.delete(`${key}:${operation.sequence}`);
			}
		});
	}
}
