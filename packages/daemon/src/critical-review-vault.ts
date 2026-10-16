/** Host-only sealed text evidence. No live path is ever returned to the model. */
import { randomUUID, webcrypto } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CriticalReviewEvidence, ReviewEvidenceEntry, ReviewOmission } from "@pilot/protocol";
import type { CriticalReviewStore } from "./critical-review-store.ts";
import { canonicalJSON } from "./operation-journal.ts";
import { scopedPath } from "./repository-browser.ts";

export const REVIEW_VAULT_LIMITS = Object.freeze({
	runBytes: 128 * 1024 * 1024,
	blobBytes: 8 * 1024 * 1024,
	paths: 20_000,
	exportBytes: 20 * 1024 * 1024,
	guidanceBytes: 24 * 1024,
	readBytes: 50 * 1024,
});
const opaqueId = /^[A-Za-z0-9_-]{1,128}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const secretPath =
	/(?:^|\/)(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.npmrc|\.netrc|credentials(?:\..*)?|auth\.json|models\.json|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))(?:\/|$)/i;
const secretText =
	/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
const utf8 = new TextDecoder("utf-8", { fatal: true });
export const evidenceDigest = async (bytes: Uint8Array): Promise<string> =>
	Buffer.from(await webcrypto.subtle.digest("SHA-256", Uint8Array.from(bytes))).toString("hex");
export interface ReviewSelection {
	selectionId: string;
	sourceId: string;
	label: string;
	category: ReviewEvidenceEntry["category"];
	selected: boolean;
	/** Host-selected bytes OR an explicitly selected file. Never model input. */
	bytes?: Uint8Array;
	file?: { root: string; relative: string };
}
export interface ReviewCapture {
	id: string;
	projectId: string;
	hostId: string;
	sourceIds: string[];
	createdAt: number;
	selections: ReviewSelection[];
	/** Known secrets from the trusted capture scope. Values never enter records/logs. */
	knownSecrets: string[];
}
function labelAllowed(label: string): boolean {
	return (
		typeof label === "string" &&
		label.length <= 512 &&
		!/[\x00-\x1f\\:]/.test(label) &&
		label.split("/").every((part) => part !== "" && part !== "." && part !== "..")
	);
}
async function privateDirectory(root: string): Promise<void> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || (await realpath(root)) !== root)
		throw new Error("Vault requires a canonical private directory");
}
async function selectedFile(file: NonNullable<ReviewSelection["file"]>): Promise<Buffer> {
	const path = await scopedPath(file.root, file.relative);
	const before = await lstat(path);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		const checked = await lstat(await scopedPath(file.root, file.relative));
		if (
			!info.isFile() ||
			info.nlink !== 1 ||
			before.dev !== info.dev ||
			before.ino !== info.ino ||
			checked.dev !== info.dev ||
			checked.ino !== info.ino
		)
			throw new Error("Unsafe selected file");
		if (info.size > REVIEW_VAULT_LIMITS.blobBytes) throw new Error("Selected file quota");
		const bytes = Buffer.alloc(info.size + 1);
		let size = 0;
		while (size < bytes.length) {
			const read = await handle.read(bytes, size, bytes.length - size, size);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		const after = await handle.stat();
		if (size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
			throw new Error("Selected file changed during capture");
		return bytes.subarray(0, size);
	} finally {
		await handle.close();
	}
}

export class CriticalReviewVault {
	private queue: Promise<unknown> = Promise.resolve();
	private queued = 0;
	readonly root: string;
	readonly store: CriticalReviewStore;
	constructor(root: string, store: CriticalReviewStore) {
		this.root = root;
		this.store = store;
	}
	/** Serial read/delete/capture leases prevent returning text after an acknowledged erase. */
	protected serial<T>(action: () => Promise<T>): Promise<T> {
		if (this.queued >= 16) return Promise.reject(new Error("Vault busy"));
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
	async capture(input: ReviewCapture): Promise<CriticalReviewEvidence> {
		return this.serial(async () => {
			if (
				![input.id, input.projectId, input.hostId, ...input.sourceIds].every(
					(id) => typeof id === "string" && opaqueId.test(id),
				) ||
				input.selections.length > REVIEW_VAULT_LIMITS.paths ||
				input.knownSecrets.some((s) => !s || s.length > 8192)
			)
				throw new Error("Invalid evidence capture");
			await privateDirectory(this.root);
			if (await this.store.get("evidence", input.id)) throw new Error("Evidence already sealed");
			const staging = join(this.root, `${randomUUID()}.part`);
			await mkdir(staging, { mode: 0o700 });
			const entries: ReviewEvidenceEntry[] = [];
			const omissions: ReviewOmission[] = [];
			let total = 0,
				exports = 0,
				guidance = 0;
			const selectedIds = new Set<string>();
			let published = false;
			try {
				for (const selection of input.selections) {
					if (
						!opaqueId.test(selection.selectionId) ||
						!opaqueId.test(selection.sourceId) ||
						!input.sourceIds.includes(selection.sourceId) ||
						selectedIds.has(selection.selectionId)
					)
						throw new Error("Invalid selection identity");
					selectedIds.add(selection.selectionId);
					const omit = (reason: ReviewOmission["reason"]) =>
						omissions.push({ selectionId: selection.selectionId, reason });
					if (!selection.selected) {
						omit("unselected");
						continue;
					}
					if (!labelAllowed(selection.label) || (selection.file && !labelAllowed(selection.file.relative))) {
						omit("unsafe");
						continue;
					}
					if (secretPath.test(selection.label) || (selection.file && secretPath.test(selection.file.relative))) {
						omit("secret");
						continue;
					}
					let bytes: Uint8Array;
					if (selection.bytes && selection.bytes.byteLength > REVIEW_VAULT_LIMITS.blobBytes) {
						omit("quota");
						continue;
					}
					try {
						bytes = selection.file ? await selectedFile(selection.file) : Uint8Array.from(selection.bytes ?? []);
					} catch (error) {
						omit((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe");
						continue;
					}
					if (bytes.byteLength > REVIEW_VAULT_LIMITS.blobBytes) {
						omit("quota");
						continue;
					}
					let value: string;
					try {
						value = utf8.decode(bytes);
						if (value.includes("\0")) throw new Error("Binary");
					} catch {
						omit("binary");
						continue;
					}
					// Fail closed for recognizable credentials and host-known secrets, including labels.
					if (
						secretText.test(value) ||
						input.knownSecrets.some((secret) => value.includes(secret) || selection.label.includes(secret))
					) {
						omit("secret");
						continue;
					}
					const isExport = selection.category === "transcript" || selection.category === "discussion";
					if (
						total + bytes.byteLength > REVIEW_VAULT_LIMITS.runBytes ||
						(isExport && exports + bytes.byteLength > REVIEW_VAULT_LIMITS.exportBytes) ||
						(selection.category === "guidance" && guidance + bytes.byteLength > REVIEW_VAULT_LIMITS.guidanceBytes)
					) {
						omit("quota");
						continue;
					}
					const blobId = randomUUID();
					const sha256 = await evidenceDigest(bytes);
					const handle = await open(join(staging, blobId), "wx", 0o600);
					try {
						await handle.writeFile(bytes);
						await handle.sync();
					} finally {
						await handle.close();
					}
					entries.push({
						blobId,
						sha256,
						bytes: bytes.byteLength,
						label: selection.label,
						sourceId: selection.sourceId,
						category: selection.category,
					});
					total += bytes.byteLength;
					if (isExport) exports += bytes.byteLength;
					if (selection.category === "guidance") guidance += bytes.byteLength;
				}
				const sha256 = await evidenceDigest(Buffer.from(canonicalJSON({ entries, omissions })));
				const manifest: CriticalReviewEvidence = {
					schemaVersion: 1,
					kind: "evidence",
					id: input.id,
					projectId: input.projectId,
					hostId: input.hostId,
					sourceIds: input.sourceIds,
					createdAt: input.createdAt,
					sealed: true,
					sha256,
					entries,
					omissions,
					complete: omissions.length === 0,
				};
				const stagedDirectory = await open(staging, "r");
				try {
					await stagedDirectory.sync();
				} finally {
					await stagedDirectory.close();
				}
				await rename(staging, join(this.root, input.id));
				published = true;
				const directory = await open(this.root, "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
				await this.store.put(manifest);
				return manifest;
			} catch (error) {
				if (published) await rm(join(this.root, input.id), { recursive: true, force: true });
				throw error;
			} finally {
				await rm(staging, { recursive: true, force: true });
			}
		});
	}
	async manifest(id: string): Promise<CriticalReviewEvidence> {
		if (!opaqueId.test(id)) throw new Error("Invalid manifest ID");
		const manifest = await this.store.get("evidence", id);
		if (
			manifest?.sealed !== true ||
			!digestPattern.test(manifest.sha256) ||
			manifest.sha256 !==
				(await evidenceDigest(
					Buffer.from(canonicalJSON({ entries: manifest.entries, omissions: manifest.omissions })),
				))
		)
			throw new Error("Evidence unavailable");
		return manifest;
	}
	read(
		manifestId: string,
		blobId: string,
		offset = 0,
		limit = REVIEW_VAULT_LIMITS.readBytes,
	): Promise<{ text: string; next?: number }> {
		return this.serial(async () => {
			if (
				!opaqueId.test(blobId) ||
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > REVIEW_VAULT_LIMITS.readBytes
			)
				throw new Error("Invalid evidence page");
			const manifest = await this.manifest(manifestId);
			const entry = manifest.entries.find((item) => item.blobId === blobId);
			if (
				!entry ||
				!digestPattern.test(entry.sha256) ||
				entry.bytes > REVIEW_VAULT_LIMITS.blobBytes ||
				offset > entry.bytes
			)
				throw new Error("Blob outside sealed manifest");
			const path = await scopedPath(this.root, `${manifestId}/${blobId}`);
			const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const info = await handle.stat();
				if (!info.isFile() || info.size !== entry.bytes || info.nlink !== 1)
					throw new Error("Evidence unavailable");
				const bytes = Buffer.alloc(entry.bytes + 1);
				const read = await handle.read(bytes, 0, bytes.length, 0);
				if (
					read.bytesRead !== entry.bytes ||
					(await evidenceDigest(bytes.subarray(0, read.bytesRead))) !== entry.sha256
				)
					throw new Error("Evidence digest mismatch");
				const end = Math.min(offset + limit, entry.bytes);
				return { text: bytes.subarray(offset, end).toString("utf8"), ...(end < entry.bytes ? { next: end } : {}) };
			} finally {
				await handle.close();
			}
		});
	}
}
