/** Short-lived LRU results with shared in-flight work and bounded admission/storage. */
import { ServiceUnavailable } from "./errors.ts";

interface Entry<T> {
	promise: Promise<T>;
	expires: number;
	bytes: number;
	pending: boolean;
}

export class TtlCache<T> {
	private readonly entries = new Map<string, Entry<T>>();
	private bytes = 0;
	private pending = 0;
	private readonly options;

	constructor(options: {
		ttlMs: number;
		maxEntries: number;
		maxBytes: number;
		maxPending: number;
		weight: (value: T) => number;
		now?: () => number;
		busyMessage?: string;
	}) {
		this.options = { ...options, now: options.now ?? Date.now };
	}

	get(key: string, load: () => Promise<T>): Promise<T> {
		const existing = this.entries.get(key);
		if (existing && (existing.pending || existing.expires > this.options.now())) {
			this.entries.delete(key);
			this.entries.set(key, existing);
			return existing.promise;
		}
		if (existing) this.remove(key, existing);
		if (this.pending >= this.options.maxPending)
			return Promise.reject(new ServiceUnavailable(this.options.busyMessage ?? "Service is busy. Retry shortly."));
		while (this.entries.size >= this.options.maxEntries) {
			if (!this.evict())
				return Promise.reject(
					new ServiceUnavailable(this.options.busyMessage ?? "Service is busy. Retry shortly."),
				);
		}
		this.pending++;
		const entry: Entry<T> = { promise: undefined!, expires: 0, bytes: 0, pending: true };
		entry.promise = Promise.resolve()
			.then(load)
			.then((value) => {
				if (this.entries.get(key) === entry) {
					entry.bytes = this.options.weight(value);
					entry.expires = this.options.now() + this.options.ttlMs;
					entry.pending = false;
					this.bytes += entry.bytes;
					// Oversized results can serve their callers but must not occupy the cache.
					if (entry.bytes > this.options.maxBytes) this.remove(key, entry);
					while (this.bytes > this.options.maxBytes && this.evict()) {}
				}
				return value;
			})
			.catch((error: unknown) => {
				if (this.entries.get(key) === entry) this.remove(key, entry);
				throw error;
			})
			.finally(() => this.pending--);
		this.entries.set(key, entry);
		return entry.promise;
	}

	/** Invalidated in-flight results still reach their original callers, but cannot repopulate the cache. */
	invalidate(matches: (key: string) => boolean): void {
		for (const [key, entry] of this.entries) if (matches(key)) this.remove(key, entry);
	}

	private remove(key: string, entry: Entry<T>): void {
		this.entries.delete(key);
		this.bytes -= entry.bytes;
	}

	private evict(): boolean {
		for (const [key, entry] of this.entries) {
			if (entry.pending) continue;
			this.remove(key, entry);
			return true;
		}
		return false;
	}
}
