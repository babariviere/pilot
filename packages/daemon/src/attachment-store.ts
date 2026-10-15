import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentUpload, DurableOperation, StagedAttachmentRef } from "@pilot/protocol";
import { canonicalJSON, durableJSON, OperationRejected } from "./operation-journal.ts";

const MAX_IMAGE = 100 * 1024 * 1024; // 24MP RGBA normalized PNG, including compression overhead.
const MAX_DISK = 2 * 1024 * 1024 * 1024;
const MAX_RECORDS = 512;
const idPattern = /^[a-f0-9-]{36}$/i;
interface UploadRecord extends AttachmentUpload {
	ready: boolean;
	owner?: { operationId: string; targetId: string };
}

/** Staged blobs are not arbitrary filesystem sync. Mac import normalizes every supported image to PNG.
 * No TTL may discard possibly referenced bytes. Unused uploads require explicit discard; adopted images
 * remain available to durable history. Quotas backpressure instead of evicting uncertain/accepted work.
 */
export class AttachmentStore {
	private readonly root: string;
	private records = new Map<string, UploadRecord>();
	private loaded?: Promise<void>;
	private queue: Promise<unknown> = Promise.resolve();
	private queued = 0;
	private readonly uploads = new Set<string>();
	constructor(home: string) {
		this.root = join(home, "attachments");
	}
	private async init(): Promise<void> {
		this.loaded ??= (async () => {
			await mkdir(this.root, { recursive: true, mode: 0o700 });
			const parent = await open(join(this.root, ".."), "r");
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
			const files = await readdir(this.root);
			if (files.length > MAX_RECORDS * 3) throw new Error("Attachment index exceeds capacity");
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				if ((await stat(join(this.root, file))).size > 4096) throw new Error("Invalid attachment metadata");
				const record = JSON.parse(await readFile(join(this.root, file), "utf8")) as UploadRecord;
				this.validate(record);
				if (file !== `${record.uploadId}.json`) throw new Error("Attachment identity mismatch");
				this.records.set(record.uploadId, record);
			}
		})();
		await this.loaded;
	}
	private validate(value: AttachmentUpload): void {
		if (
			!value ||
			!idPattern.test(value.uploadId) ||
			!/^[a-f0-9]{64}$/.test(value.sha256) ||
			!Number.isSafeInteger(value.bytes) ||
			value.bytes < 33 ||
			value.bytes > MAX_IMAGE ||
			!value.origin ||
			![value.origin.hostId, value.origin.daemonId, value.origin.lineageId].every(
				(id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
			)
		)
			throw new Error("Invalid image upload");
	}
	private serial<T>(action: () => Promise<T>): Promise<T> {
		if (this.queued >= 32) return Promise.reject(new Error("Attachment metadata busy"));
		this.queued++;
		const next = this.queue
			.catch(() => {})
			.then(action)
			.finally(() => {
				this.queued--;
			});
		this.queue = next;
		return next;
	}
	async stage(metadata: AttachmentUpload, body: AsyncIterable<Uint8Array>): Promise<StagedAttachmentRef> {
		this.validate(metadata);
		if (this.uploads.size >= 2 || this.uploads.has(metadata.uploadId)) throw new Error("Image uploads are busy");
		this.uploads.add(metadata.uploadId);
		try {
			const record = await this.serial(async () => {
				await this.init();
				const existing = this.records.get(metadata.uploadId);
				if (existing) {
					const { ready: _ready, owner: _owner, ...original } = existing;
					if (canonicalJSON(original) !== canonicalJSON(metadata))
						throw new Error("Upload ID already has other bytes/owner");
					return existing;
				}
				const bytes = [...this.records.values()].reduce((total, item) => total + item.bytes, 0);
				if (this.records.size >= MAX_RECORDS || bytes + metadata.bytes > MAX_DISK)
					throw new Error("Attachment storage is full");
				const created = { ...metadata, ready: false };
				await durableJSON(join(this.root, `${metadata.uploadId}.json`), created);
				this.records.set(metadata.uploadId, created);
				return created;
			});
			if (record.ready) return { uploadId: record.uploadId, sha256: record.sha256, bytes: record.bytes };
			const temp = join(this.root, `${metadata.uploadId}.part`);
			const file = await open(temp, "w", 0o600);
			let bytes = 0;
			const digest = createHash("sha256");
			let header = Buffer.alloc(0);
			try {
				for await (const chunk of body) {
					bytes += chunk.byteLength;
					if (bytes > metadata.bytes) throw new Error("Image exceeds reserved size");
					if (header.length < 24)
						header = Buffer.concat([header, Buffer.from(chunk).subarray(0, 24 - header.length)]);
					digest.update(chunk);
					await file.writeFile(chunk);
				}
				if (bytes !== metadata.bytes || digest.digest("hex") !== metadata.sha256)
					throw new Error("Image digest/length mismatch");
				if (
					!header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
					header.subarray(12, 16).toString("ascii") !== "IHDR"
				)
					throw new Error("Only normalized PNG images can be uploaded");
				const width = header.readUInt32BE(16);
				const height = header.readUInt32BE(20);
				if (!width || !height || width * height > 24_000_000) throw new Error("Image exceeds 24 megapixels");
				await file.sync();
			} finally {
				await file.close();
			}
			await this.serial(async () => {
				await rename(temp, join(this.root, `${metadata.uploadId}.png`));
				const next = { ...record, ready: true };
				await durableJSON(join(this.root, `${metadata.uploadId}.json`), next);
				this.records.set(metadata.uploadId, next);
			});
			return { uploadId: metadata.uploadId, sha256: metadata.sha256, bytes: metadata.bytes };
		} finally {
			this.uploads.delete(metadata.uploadId);
			await unlink(join(this.root, `${metadata.uploadId}.part`)).catch(() => {});
		}
	}
	/** Must follow journal reservation and precede prompt/kernel admission. Replays use the same owner. */
	async adopt(operation: DurableOperation, refs: StagedAttachmentRef[]): Promise<string[]> {
		return this.serial(async () => {
			await this.init();
			if (!Array.isArray(refs) || refs.length > 8 || new Set(refs.map((ref) => ref.uploadId)).size !== refs.length)
				throw new OperationRejected("Attach up to 8 distinct images");
			const records = refs.map((ref) => {
				const record = this.records.get(ref.uploadId);
				if (
					!record?.ready ||
					record.sha256 !== ref.sha256 ||
					record.bytes !== ref.bytes ||
					canonicalJSON(record.origin) !== canonicalJSON(operation.origin)
				)
					throw new OperationRejected("Attachment is not ready or belongs to another origin");
				if (
					record.owner &&
					(record.owner.operationId !== operation.operationId || record.owner.targetId !== operation.targetId)
				)
					throw new OperationRejected("Attachment already belongs to another operation");
				return record;
			});
			for (const record of records) {
				if (record.owner) continue;
				const updated = { ...record, owner: { operationId: operation.operationId, targetId: operation.targetId } };
				await durableJSON(join(this.root, `${record.uploadId}.json`), updated);
				this.records.set(record.uploadId, updated);
			}
			return records.map((record) => join(this.root, `${record.uploadId}.png`));
		});
	}
	async discard(uploadId: string): Promise<void> {
		await this.serial(async () => {
			await this.init();
			const record = this.records.get(uploadId);
			if (!record || !idPattern.test(uploadId)) throw new Error("Unknown attachment");
			if (record.owner || this.uploads.has(uploadId))
				throw new Error("Receipt-owned or active attachments cannot be discarded");
			// Remove bytes first. A crash retaining metadata only consumes quota, never exposes missing bytes as ready.
			await unlink(join(this.root, `${uploadId}.png`)).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
			await unlink(join(this.root, `${uploadId}.json`));
			this.records.delete(uploadId);
		});
	}

	/** Caller must have looked up a conclusive rejected receipt in the same intact journal domain. */
	async releaseRejected(operation: DurableOperation, refs: StagedAttachmentRef[]): Promise<void> {
		await this.serial(async () => {
			await this.init();
			if (!Array.isArray(refs) || refs.length > 8) throw new Error("Invalid attachment list");
			const records = refs.map((ref) => {
				const record = this.records.get(ref.uploadId);
				if (
					!record ||
					record.sha256 !== ref.sha256 ||
					record.bytes !== ref.bytes ||
					canonicalJSON(record.origin) !== canonicalJSON(operation.origin) ||
					(record.owner &&
						(record.owner.operationId !== operation.operationId || record.owner.targetId !== operation.targetId))
				)
					throw new Error("Attachment receipt ownership mismatch");
				return record;
			});
			for (const record of records) {
				await unlink(join(this.root, `${record.uploadId}.png`)).catch((error) => {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				});
				await unlink(join(this.root, `${record.uploadId}.json`));
				this.records.delete(record.uploadId);
			}
		});
	}
}
