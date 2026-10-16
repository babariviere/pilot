import { createHash } from "node:crypto";
import type { MemoryEntry, SharedMemoryMutation } from "@pilot/protocol";

/** Leaves room for the operation envelope, identities and receipt metadata. */
export const MEMORY_PAGE_BYTES = 24 * 1024;
export const MEMORY_PAGE_LIMIT = 128;
export function checkBindingKey(key: string): void {
	if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid memory binding key");
}
export function memoryFingerprint(text: string): string {
	return createHash("sha256").update(text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
}
export function memoryLine(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || /[\r\n\x00]/.test(value) || Buffer.byteLength(value.trim()) > 280)
		throw new Error("Memory must be one nonempty line, at most 280 UTF-8 bytes");
	return value.trim();
}
export function memoryId(value: unknown): asserts value is string {
	if (typeof value !== "string" || !/^[\w-]{1,100}$/.test(value)) throw new Error("Invalid memory identity");
}
/** Conservative export guard, not a promise to recognize every secret embedded in prose. */
export function checkMemoryExport(text: string): void {
	if (
		/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i.test(text) ||
		/\b(?:sk-(?:ant-(?:api\d+|oat\d+)-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/.test(
			text,
		) ||
		/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(text) ||
		/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i.test(
			text,
		) ||
		/https?:\/\/[^\s/:]+:[^\s/@]+@/i.test(text)
	)
		throw new Error("Memory export blocked: possible credential; curate the shared context before retrying");
}
export function checkMutation(mutation: SharedMemoryMutation): void {
	const fields = (value: object, allowed: string[]) => {
		if (!value || typeof value !== "object" || Object.keys(value).some((key) => !allowed.includes(key)))
			throw new Error("Unexpected memory mutation fields");
	};
	fields(mutation, ["operationId", "payloadHash", "noteId", "origin", "text", "replaces"]);
	fields(mutation.origin, ["host", "sessionId"]);
	fields(mutation.origin.host, ["hostId", "daemonId", "lineageId"]);
	memoryId(mutation.operationId);
	memoryId(mutation.noteId);
	memoryId(mutation.origin?.sessionId);
	for (const id of [mutation.origin?.host?.hostId, mutation.origin?.host?.daemonId, mutation.origin?.host?.lineageId])
		memoryId(id);
	if (typeof mutation.payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(mutation.payloadHash))
		throw new Error("Invalid memory payload hash");
	memoryLine(mutation.text);
	checkMemoryExport(mutation.text);
	if (
		!Array.isArray(mutation.replaces) ||
		mutation.replaces.length > 16 ||
		new Set(mutation.replaces.map((r) => r.id)).size !== mutation.replaces.length
	)
		throw new Error("Invalid memory correction references");
	for (const ref of mutation.replaces) {
		fields(ref, ["id", "expectedReplacementId"]);
		memoryId(ref.id);
		if (ref.expectedReplacementId !== null) memoryId(ref.expectedReplacementId);
	}
	if (Buffer.byteLength(JSON.stringify(mutation)) > 12 * 1024) throw new Error("Memory mutation too large");
}
/** Strip derived state and allowlist every persisted/exported field. */
export function rawMemoryEntry(entry: MemoryEntry): MemoryEntry {
	memoryId(entry.id);
	memoryId(entry.deviceId);
	memoryId(entry.sessionId);
	if (
		!Number.isSafeInteger(entry.index) ||
		entry.index < 0 ||
		!Number.isSafeInteger(entry.at) ||
		entry.at < 0 ||
		memoryLine(entry.text) !== entry.text
	)
		throw new Error("Invalid memory entry");
	if (
		entry.replaces !== undefined &&
		(!Array.isArray(entry.replaces) ||
			entry.replaces.length > 16 ||
			new Set(entry.replaces).size !== entry.replaces.length)
	)
		throw new Error("Invalid memory entry corrections");
	for (const id of entry.replaces ?? []) memoryId(id);
	if (entry.sharedOrigin) {
		memoryId(entry.sharedOrigin.sessionId);
		for (const id of [
			entry.sharedOrigin.host?.hostId,
			entry.sharedOrigin.host?.daemonId,
			entry.sharedOrigin.host?.lineageId,
		])
			memoryId(id);
		if (entry.sharedOrigin.sessionId !== entry.sessionId) throw new Error("Memory origin session mismatch");
	}
	return {
		index: entry.index,
		id: entry.id,
		deviceId: entry.deviceId,
		at: entry.at,
		sessionId: entry.sessionId,
		text: entry.text,
		...(entry.replaces?.length ? { replaces: entry.replaces } : {}),
		...(entry.sharedOrigin
			? {
					sharedOrigin: {
						host: {
							hostId: entry.sharedOrigin.host.hostId,
							daemonId: entry.sharedOrigin.host.daemonId,
							lineageId: entry.sharedOrigin.host.lineageId,
						},
						sessionId: entry.sharedOrigin.sessionId,
					},
				}
			: {}),
	};
}
export function digestMemory(entries: Iterable<MemoryEntry>): string {
	const hash = createHash("sha256");
	for (const entry of entries) hash.update(`${JSON.stringify(rawMemoryEntry(entry))}\n`);
	return hash.digest("hex");
}
