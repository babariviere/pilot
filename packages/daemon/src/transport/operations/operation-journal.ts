import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DurableOperation, OperationHost, OperationReceipt } from "@pilot/protocol";
import { canonicalJSON, payloadHash } from "../../runtime/contracts/canonical.ts";
import { durableJSON } from "../../runtime/storage/durable-file.ts";
import { trace } from "../../runtime/diagnostics/trace.ts";

// Existing consumers can keep their imports while the file and hash helpers move out of the journal.
export { canonicalJSON, payloadHash } from "../../runtime/contracts/canonical.ts";
export { durableJSON } from "../../runtime/storage/durable-file.ts";

const MAX_PAYLOAD = 64 * 1024;
const MAX_RECORDS = 4096;
const MAX_STREAMS = 1024;
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const streamKey = (op: DurableOperation): string => payloadHash(canonicalJSON([op.origin, op.producerId]));
export const sameHost = (a: OperationHost, b: OperationHost): boolean =>
	a.daemonId === b.daemonId && a.lineageId === b.lineageId;
export const isChatOperation = (kind: string): boolean =>
	/^(chat-(create|send)(-attached)?|diagnostics-create|repair-create)$/.test(kind);
export function isLocalOperation(op: Readonly<DurableOperation>, home: OperationHost): boolean {
	return [op.origin, op.destination].every(
		(host) => !!host && (host.hostId === "local" || host.hostId === "daemon") && sameHost(host, home),
	);
}
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
	/** The last unknown outcome written to the log. Recovery rechecks the operation at every start;
	 * the same outcome is not logged again. Private: never part of the receipt. */
	unknown?: string;
}

/** Trusted policy view. Original serialization stays owned by the journal. */
export interface JournalObservation {
	readonly operation: Readonly<DurableOperation>;
	readonly receipt: Readonly<OperationReceipt>;
	original(): string;
}
interface JournalReadState {
	readonly records: Iterable<JournalObservation>;
	readonly failed: boolean;
	readonly pendingKinds: Iterable<string>;
}

/** One owner per daemon data home, like SessionManager. Bounded admission, no TTL eviction.
 * Handlers MUST materialize the stable target and use operationId for downstream deduplication.
 * An exception leaves a recoverable pending receipt, not a possibly false rejection.
 */
export class OperationJournal {
	private readonly settledListeners = new Set<(operation: DurableOperation, receipt: OperationReceipt) => void>();
	/** Invalidations follow durable final receipt publication, never merely handler entry. */
	onSettled(listener: (operation: DurableOperation, receipt: OperationReceipt) => void): () => void {
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
	private readonly reservations = new Map<string, number>();
	private fault?: unknown;
	private readonly running = new Map<string, Promise<OperationReceipt>>();
	private safetyReductionRunning = false;
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
	/** Saved operations of one kind for one target, in no particular order. Reads only. */
	async operations(kind: string, targetId: string): Promise<DurableOperation[]> {
		return this.serial(async () => {
			await this.init();
			return structuredClone(
				[...this.records.values()]
					.filter((r) => r.operation.kind === kind && r.operation.targetId === targetId)
					.map((r) => r.operation),
			);
		});
	}
	/** Final synchronous admission fence, after an awaited journal read. Refuse any in-flight
	 * journal I/O rather than missing a revocation that is not published in memory yet. */
	assertNoPending(kinds: readonly string[], targetId: string): void {
		if (!this.initialized || this.fault || this.queued)
			throw new Error("Operation journal is not settled for admission");
		for (const { operation, receipt } of this.records.values()) {
			if (operation.targetId === targetId && kinds.includes(operation.kind) && receipt.state === "pending")
				throw new Error("Revocation is uncertain; no new admission");
		}
	}
	/** Read policy runs on the serialized owner, without exposing a mutable record collection. */
	async readRecords<T>(read: (state: JournalReadState) => T): Promise<T> {
		return this.serial(async () => {
			await this.init();
			return read(this.readState());
		});
	}
	/** Initialized synchronous policy recheck. Includes reservations still awaiting filesystem publication. */
	async openReader<T>(read: (state: JournalReadState) => T): Promise<() => T> {
		await this.serial(() => this.init());
		return () => read(this.readState());
	}
	private readState(): JournalReadState {
		return { records: this.observations(), failed: !!this.fault, pendingKinds: this.reservations.keys() };
	}
	private *observations(): IterableIterator<JournalObservation> {
		for (const record of this.records.values())
			yield {
				operation: record.operation,
				receipt: record.receipt,
				original: () => JSON.stringify(record),
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
		const reserving = typeof op.kind === "string";
		if (reserving) this.reservations.set(op.kind, (this.reservations.get(op.kind) ?? 0) + 1);
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
			if (reserving) {
				const count = this.reservations.get(op.kind)! - 1;
				if (count) this.reservations.set(op.kind, count);
				else this.reservations.delete(op.kind);
			}
		});
	}
	async reserve(op: DurableOperation): Promise<OperationReceipt> {
		return (await this.reserveEntry(op)).receipt;
	}
	async execute(
		op: DurableOperation,
		handler: (op: DurableOperation, entry: { firstEntry: boolean }) => Promise<unknown>,
		options: { safetyReduction?: boolean } = {},
	): Promise<OperationReceipt> {
		op = structuredClone(op);
		// Only this atomic reservation can identify a new confirmation. A pending record,
		// even one without an effect checkpoint, is never fresh authority on re-entry.
		const { receipt, firstEntry } = await this.reserveEntry(op);
		if (receipt.state !== "pending") return receipt;
		const running = this.running.get(op.operationId);
		if (running) return running;
		// One extra host-authorized reduction can stop collection even when four
		// ordinary effects are stuck. Callers must validate an exact no-grant intent.
		if (options.safetyReduction ? this.safetyReductionRunning : this.running.size >= 4) return receipt;
		if (options.safetyReduction) this.safetyReductionRunning = true;
		const work = (async () => {
			let result: unknown;
			let reason: string | undefined;
			try {
				result = await handler(structuredClone(op), { firstEntry });
			} catch (e) {
				if (!(e instanceof OperationRejected)) {
					const unknown = String(e).slice(0, 512);
					await this.serial(async () => {
						const previous = this.checked(op);
						if (previous?.receipt.state !== "pending" || previous.unknown === unknown) return;
						trace(
							`pilotd: operation ${op.kind} ${op.operationId} (target ${op.targetId}) outcome unknown: ${unknown}`,
						);
						const updated = { ...previous, unknown };
						await this.persist(join(this.directory, `${payloadHash(op.operationId)}.json`), updated);
						this.records.set(op.operationId, updated);
					}).catch(() => {
						/* The note only quiets the log; the operation stays pending either way. */
					});
					return (await this.lookup(op))!;
				}
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
				// One line per settled operation, so a stuck mission can be traced from the log.
				trace(
					`pilotd: operation ${op.kind} ${updated.receipt.state} ${op.operationId} (target ${op.targetId})${reason === undefined ? "" : `: ${reason}`}`,
				);
				for (const listener of this.settledListeners) {
					try {
						listener(structuredClone(op), structuredClone(updated.receipt));
					} catch {
						/* Observers cannot undo a durable receipt. */
					}
				}
				return structuredClone(updated.receipt);
			});
		})().finally(() => {
			this.running.delete(op.operationId);
			if (options.safetyReduction) this.safetyReductionRunning = false;
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
