/**
 * Read-only view of the shared model catalog store.
 *
 * An isolated worker cannot use the SDK's own store: the whole host is read-only except the worker's
 * private state, so the SDK's lock file cannot be created and its store read fails. The provider then
 * falls back to the bundled catalog, which is older than the published one, and a model that only
 * exists in the published catalog is reported as unavailable. The daemon owns the catalog, so the
 * worker only reads it, and a write is a no-op instead of a failure that would discard the models the
 * refresh just published.
 */
import { readFileSync, statSync } from "node:fs";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";

/** The published catalog stays far below this; a larger file is refused instead of parsed. */
const MAX_STORE_BYTES = 8 * 1024 * 1024;
/** A torn read is possible without the SDK's lock: the daemon rewrites the store in place. */
const READ_ATTEMPTS = 3;

interface CachedStore {
	size: number;
	mtimeMs: number;
	entries: Record<string, ModelsStoreEntry>;
}

let cached: CachedStore | undefined;

function readEntries(path: string): Record<string, ModelsStoreEntry> {
	const info = statSync(path);
	if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.entries;
	const content = readFileSync(path, "utf8");
	if (content.length > MAX_STORE_BYTES) throw new Error("Model catalog store is too large");
	const parsed = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content) as Record<
		string,
		ModelsStoreEntry
	>;
	if (!parsed || typeof parsed !== "object") throw new Error("Model catalog store is malformed");
	cached = { size: info.size, mtimeMs: info.mtimeMs, entries: parsed };
	return parsed;
}

export function readonlyModelsStore(path: string): ModelsStore {
	return {
		async read(providerId, options) {
			options?.signal?.throwIfAborted();
			let last: unknown;
			for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
				try {
					const entry = readEntries(path)[providerId];
					return entry ? structuredClone(entry) : undefined;
				} catch (error) {
					last = error;
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				}
			}
			throw last instanceof Error ? last : new Error("Model catalog store is unreadable");
		},
		// The daemon owns the catalog. A worker never writes it.
		async write() {},
		async delete() {},
	};
}
