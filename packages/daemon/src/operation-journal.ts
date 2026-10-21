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
const sameHost = (a: OperationHost, b: OperationHost): boolean =>
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
	private queue: Promise<unknown> = Promise.resolve();
	private queued = 0;
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
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			const parent = await open(join(this.directory, ".."), "r");
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
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
			const files = await readdir(this.directory);
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
					// A crash can interrupt GC after publishing its floor. Finish that deletion on recovery.
					await unlink(join(this.directory, file));
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
	async reserve(op: DurableOperation): Promise<OperationReceipt> {
		op = structuredClone(op);
		return this.serial(async () => {
			await this.init();
			const existing = this.checked(op);
			if (existing) return structuredClone(existing.receipt);
			if (this.records.size >= MAX_RECORDS) throw new Error("Operation receipt retention is full");
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
			return structuredClone(record.receipt);
		});
	}
	async execute(op: DurableOperation, handler: (op: DurableOperation) => Promise<unknown>): Promise<OperationReceipt> {
		op = structuredClone(op);
		const receipt = await this.reserve(op);
		if (receipt.state !== "pending") return receipt;
		const running = this.running.get(op.operationId);
		if (running) return running;
		if (this.running.size >= 4) return receipt;
		const work = (async () => {
			let result: unknown;
			let reason: string | undefined;
			try {
				result = await handler(structuredClone(op));
			} catch (e) {
				if (!(e instanceof OperationRejected)) return receipt;
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
	async recover(
		handler: (op: DurableOperation) => Promise<unknown>,
		eligible: (op: Readonly<DurableOperation>) => boolean = () => true,
	): Promise<void> {
		await this.init();
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
