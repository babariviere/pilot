/** Background requests use the existing subscription policy, independently of dollar funding. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Conflict } from "../../runtime/contracts/errors.ts";
import { durableJSON } from "../../transport/operations/operation-journal.ts";
import { recordSubscriptionLimit, refreshSubscriptionPolicy, type SubscriptionPolicy } from "../usage/subscription-policy.ts";
import {
	type SubscriptionProvider,
	type SubscriptionUsageReading,
	subscriptionProvider,
} from "../usage/subscription-usage.ts";

export class BackgroundSubscription {
	private readonly file: string;
	private initialized?: Promise<void>;
	private policy: SubscriptionPolicy = { version: 1, windows: [] };
	private tail: Promise<unknown> = Promise.resolve();
	private readonly snapshot: () => Record<SubscriptionProvider, SubscriptionUsageReading>;
	constructor(home: string, snapshot: () => Record<SubscriptionProvider, SubscriptionUsageReading>) {
		this.file = join(home, "background-subscription.json");
		this.snapshot = snapshot;
	}
	private load(): Promise<void> {
		this.initialized ??= (async () => {
			let text: string;
			try {
				text = await readFile(this.file, "utf8");
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
				throw e;
			}
			const p = JSON.parse(text) as SubscriptionPolicy;
			if (
				text.length > 16384 ||
				p.version !== 1 ||
				!Array.isArray(p.windows) ||
				p.windows.some(
					(w) =>
						!["anthropic", "openai"].includes(w.provider) ||
						typeof w.label !== "string" ||
						!Number.isFinite(w.usedPercent),
				)
			)
				throw new Error("Background subscription policy unavailable");
			this.policy = p;
		})();
		return this.initialized;
	}
	async read(): Promise<SubscriptionPolicy> {
		return this.update();
	}
	private update(
		force?: SubscriptionProvider,
		limit?: { provider: SubscriptionProvider; resetsAt?: string },
		expected?: SubscriptionPolicy,
	): Promise<SubscriptionPolicy> {
		const work = this.tail.then(async () => {
			await this.load();
			const readings = this.snapshot();
			const source = {
				start: async () => {},
				close: () => {},
				get: (p: SubscriptionProvider) => {
					const r = readings[p];
					return r.status === "current" && r.fetchedAt !== undefined
						? {
								provider: p,
								fetchedAt: r.fetchedAt,
								windows: r.windows.map((w) => ({ ...w, resetsAt: w.resetsAt ?? undefined })),
							}
						: undefined;
				},
			};
			const next = limit
				? recordSubscriptionLimit(this.policy, source, limit)
				: refreshSubscriptionPolicy(this.policy, source);
			if (force) {
				if (JSON.stringify(next) !== JSON.stringify(expected) || !next.windows.some((w) => w.provider === force))
					throw new Conflict("Subscription hold changed; read it again before continuing");
				next.force = [...new Set([...(next.force ?? []), force])];
			}
			if (JSON.stringify(next) !== JSON.stringify(this.policy)) await durableJSON(this.file, next);
			this.policy = next;
			return structuredClone(next);
		});
		this.tail = work.catch(() => undefined);
		return work;
	}
	async assert(piProvider: string): Promise<void> {
		const provider = subscriptionProvider(piProvider);
		if (!provider) return;
		const policy = await this.update();
		if (policy.windows.some((w) => w.provider === provider) && !policy.force?.includes(provider))
			throw new Error("Background subscription hold. Continue anyway is explicit; funding cannot clear it.");
	}
	async continueAnyway(provider: SubscriptionProvider, expected: SubscriptionPolicy): Promise<void> {
		if (!["anthropic", "openai"].includes(provider)) throw new Error("Invalid provider");
		await this.update(provider, undefined, expected);
	}
	async limit(limit: { provider: SubscriptionProvider; resetsAt?: string }): Promise<void> {
		await this.update(undefined, limit);
	}
	async close() {
		await this.tail;
	}
}
