import { createHash } from "node:crypto";
import type { MemoryEntry } from "@pilot/protocol";

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
