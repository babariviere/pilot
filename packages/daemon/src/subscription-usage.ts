/**
 * Account-wide subscription usage, shared by every session. pi's usage extension elects one poller
 * per provider across all pi processes (including Pilot's kernels) and writes the shared cache;
 * pilotd only reads it, so it adds no polling and never touches credentials.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubscriptionUsage } from "@pilot/protocol";

export type SubscriptionProvider = NonNullable<SubscriptionUsage["provider"]>;
export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = ["anthropic", "openai"];

/** Agent reads use cached provider snapshots only, with a two-minute freshness budget. */
export const SUBSCRIPTION_USAGE_MAX_AGE_MS = 120_000;
export interface SubscriptionUsageReading {
	status: "current" | "stale" | "unknown";
	fetchedAt?: number;
	windows: Array<{ label: string; usedPercent: number; resetsAt: string | null }>;
}

/** Explicit allowlist: never forward provider errors, costs, credentials or account metadata. */
export function subscriptionUsageReadings(
	source: SubscriptionUsageSource | undefined,
	now = Date.now(),
): Record<SubscriptionProvider, SubscriptionUsageReading> {
	const read = (provider: SubscriptionProvider): SubscriptionUsageReading => {
		let usage: SubscriptionUsage | undefined;
		try {
			usage = source?.get(provider);
		} catch {
			return { status: "unknown", windows: [] };
		}
		if (!usage || usage.error || !usage.windows.length) return { status: "unknown", windows: [] };
		return {
			status: usage.fetchedAt > now || now - usage.fetchedAt >= SUBSCRIPTION_USAGE_MAX_AGE_MS ? "stale" : "current",
			fetchedAt: usage.fetchedAt,
			windows: usage.windows.map(({ label, usedPercent, resetsAt }) => ({
				label,
				usedPercent,
				resetsAt: resetsAt ?? null,
			})),
		};
	};
	return { anthropic: read("anthropic"), openai: read("openai") };
}

/** pi providers whose subscription windows are reported. Virtual routers resolve to these first. */
export function subscriptionProvider(piProvider: string | undefined): SubscriptionProvider | undefined {
	if (piProvider === "anthropic") return "anthropic";
	if (piProvider === "openai-codex") return "openai";
	return undefined;
}

/** pi provider of a `provider/model` reference. */
export function modelProvider(model: string | undefined): string | undefined {
	const slash = model?.indexOf("/") ?? -1;
	return slash > 0 ? model!.slice(0, slash) : undefined;
}

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Validate and copy one provider's cache entry, forwarding only display data. */
export function parseUsageCache(data: unknown, provider: SubscriptionProvider): SubscriptionUsage | undefined {
	if (!record(data) || !finite(data.fetchedAt) || data.fetchedAt < 0 || !record(data.snapshot)) return undefined;
	const snapshot = data.snapshot;
	if (!Array.isArray(snapshot.windows)) return undefined;
	if (snapshot.provider !== undefined && snapshot.provider !== provider) return undefined;
	if (snapshot.error !== undefined && typeof snapshot.error !== "string") return undefined;
	const windows: SubscriptionUsage["windows"] = [];
	for (const window of snapshot.windows) {
		if (!record(window) || typeof window.label !== "string" || !finite(window.usedPercent) || window.usedPercent < 0)
			return undefined;
		if (window.resetsAt !== undefined && typeof window.resetsAt !== "string") return undefined;
		windows.push({
			label: window.label,
			usedPercent: window.usedPercent,
			...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
		});
	}
	return {
		fetchedAt: data.fetchedAt,
		provider,
		windows,
		...(snapshot.error === undefined ? {} : { error: snapshot.error }),
	};
}

export interface SubscriptionUsageSource {
	/** Synchronous in-memory read only. Refreshes/provider I/O belong in the source's background work. */
	get(provider: SubscriptionProvider): SubscriptionUsage | undefined;
	start(): Promise<void>;
	close(): void;
}

/** Reads `<agentDir>/cache/usage-status/<provider>/cache.json`, polling cheap stats for changes. */
export class SubscriptionUsageCache implements SubscriptionUsageSource {
	private readonly dir: string;
	private readonly intervalMs: number;
	private readonly onChange: (provider: SubscriptionProvider) => void;
	private readonly current = new Map<SubscriptionProvider, { mtimeMs: number; usage?: SubscriptionUsage }>();
	private timer?: ReturnType<typeof setInterval>;
	private reading?: Promise<void>;

	constructor(
		onChange: (provider: SubscriptionProvider) => void,
		options: { agentDir?: string; intervalMs?: number } = {},
	) {
		this.onChange = onChange;
		this.dir = join(options.agentDir ?? getAgentDir(), "cache", "usage-status");
		this.intervalMs = options.intervalMs ?? 2_000;
	}

	get(provider: SubscriptionProvider): SubscriptionUsage | undefined {
		const usage = this.current.get(provider)?.usage;
		return usage && structuredClone(usage);
	}

	async start(): Promise<void> {
		await this.refresh();
		if (this.timer) return;
		this.timer = setInterval(() => void this.refresh(), this.intervalMs);
		this.timer.unref?.();
	}

	close(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Read changed cache files. Concurrent calls share one pass. */
	refresh(): Promise<void> {
		this.reading ??= Promise.all(SUBSCRIPTION_PROVIDERS.map((provider) => this.read(provider))).then(
			() => {
				this.reading = undefined;
			},
			() => {
				this.reading = undefined;
			},
		);
		return this.reading;
	}

	private async read(provider: SubscriptionProvider): Promise<void> {
		const path = join(this.dir, provider, "cache.json");
		const previous = this.current.get(provider);
		const mtimeMs = await stat(path).then(
			(info) => info.mtimeMs,
			() => 0,
		);
		if (previous && previous.mtimeMs === mtimeMs) return;
		let usage: SubscriptionUsage | undefined;
		if (mtimeMs) {
			try {
				usage = parseUsageCache(JSON.parse(await readFile(path, "utf8")), provider);
			} catch {
				// A partially written or malformed file. The writer renames atomically, so retry on the next change.
			}
			// Keep the last good snapshot rather than flapping to unavailable on a bad read.
			if (!usage && previous?.usage) usage = previous.usage;
		}
		this.current.set(provider, { mtimeMs, ...(usage ? { usage } : {}) });
		if (JSON.stringify(usage) !== JSON.stringify(previous?.usage)) this.onChange(provider);
	}
}
