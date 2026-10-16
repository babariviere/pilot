import type { SourceMcpClient } from "./source-mcp.ts";
import { SourceRateLimited, SourceSignInRequired } from "./source-mcp.ts";
import type { TrackedInput } from "./tracked-items.ts";
import type { WatchService } from "./watch-service.ts";

const TYPES = new Set(["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"]);

/** Existing tracker observations plus a bounded, read-only list_issues fallback for out-of-scope watches. */
export class LinearWatchSource {
	private readonly watches: WatchService;
	private readonly mcp: SourceMcpClient;
	private readonly covered = new Map<string, { projectId: string; externalId: string; seenAt: number }>();
	private timer?: ReturnType<typeof setTimeout>;
	private run?: { controller: AbortController; promise: Promise<void> };
	private stopped = true;
	private cursor = "";
	private targetsKey = "";
	private readonly unsubscribe: () => void;
	private registration?: Promise<void>;
	constructor(watches: WatchService, mcp: SourceMcpClient) {
		this.watches = watches;
		this.mcp = mcp;
		this.unsubscribe = watches.onChange(() => this.registrationsChanged());
	}
	start(): void {
		this.stopped = false;
		this.registrationsChanged();
	}
	private registrationsChanged(): void {
		if (this.stopped || this.registration) return;
		this.registration = (async () => {
			const ids = (await this.watches.targets("linear")).map((t) => t.id).sort();
			const key = ids.join(",");
			if (key === this.targetsKey) return;
			this.targetsKey = key;
			const wanted = new Set(ids);
			for (const id of this.covered.keys()) if (!wanted.has(id)) this.covered.delete(id);
			this.schedule(0);
		})()
			.catch((error) => console.warn(`pilotd: Linear watch registration failed: ${error}`))
			.finally(() => {
				this.registration = undefined;
			});
	}
	private schedule(delay: number): void {
		if (this.stopped || this.run) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(new Error("Linear watch poll timed out")), 90000);
			let next = 300000;
			const promise = this.poll(controller.signal)
				.catch((error) => {
					if (error instanceof SourceRateLimited) next = Math.max(next, error.retryAfterMs);
				})
				.finally(() => {
					clearTimeout(timeout);
					this.run = undefined;
					if (this.targetsKey) this.schedule(next);
				});
			this.run = { controller, promise };
		}, delay);
		this.timer.unref();
	}
	async observe(identifier: string, statusType: string, title: string, originSessionId?: string): Promise<number> {
		if (!/^[a-z][a-z0-9]*-\d+$/i.test(identifier) || !TYPES.has(statusType))
			throw new Error("Invalid Linear watch observation");
		const id = identifier.toUpperCase();
		return this.watches.transition({
			source: `linear:${id}`,
			state: statusType,
			candidate:
				statusType === "completed"
					? {
							source: id,
							event: "linear.done",
							targets: [{ kind: "linear", id }],
							at: Date.now(),
							text: `Linear ${id} completed: ${title.slice(0, 500)}`,
							originSessionId,
						}
					: undefined,
		});
	}
	async tracked(projectId: string, items: TrackedInput[], activeIds: string[]): Promise<void> {
		const wanted = new Set((await this.watches.targets("linear")).map((t) => t.id));
		const active = new Set(activeIds);
		for (const [id, scope] of this.covered)
			if (scope.projectId === projectId) {
				if (!active.has(scope.externalId)) this.covered.delete(id);
				else scope.seenAt = Date.now();
			}
		for (const item of items) {
			const id = typeof item.metadata.identifier === "string" ? item.metadata.identifier.toUpperCase() : "";
			const type = item.metadata.statusType;
			if (!wanted.has(id) || typeof type !== "string" || !TYPES.has(type)) continue;
			this.covered.set(id, { projectId, externalId: item.externalId, seenAt: Date.now() });
			await this.observe(id, type, item.title);
		}
	}
	/** At most 25 exact-identity searches per five-minute run, rotating fairly. */
	async poll(signal: AbortSignal): Promise<void> {
		const ids = (await this.watches.targets("linear"))
			.map((t) => t.id)
			.filter((id) => !this.covered.has(id) || this.covered.get(id)!.seenAt < Date.now() - 600000)
			.sort();
		if (!ids.length) return;
		const offset = ids.findIndex((id) => id > this.cursor);
		const ordered = offset < 0 ? ids : [...ids.slice(offset), ...ids.slice(0, offset)];
		for (const id of ordered.slice(0, 25)) {
			signal.throwIfAborted();
			this.cursor = id;
			try {
				// The logical issues capability is fixed to list_issues, never get_issue or arbitrary MCP.
				const response = await this.mcp.call(
					"linear",
					"issues",
					{ query: id, includeArchived: true, limit: 100, fields: ["id", "identifier", "title", "statusType"] },
					signal,
				);
				signal.throwIfAborted();
				if (!response || typeof response !== "object" || Array.isArray(response)) continue;
				const issues = response.issues;
				if (!Array.isArray(issues) || issues.length > 100) continue;
				const exact = issues.filter(
					(issue) =>
						issue &&
						typeof issue === "object" &&
						!Array.isArray(issue) &&
						typeof issue.identifier === "string" &&
						issue.identifier.toUpperCase() === id,
				);
				if (exact.length !== 1) continue;
				const issue = exact[0] as { statusType?: unknown; title?: unknown };
				if (typeof issue.statusType !== "string" || !TYPES.has(issue.statusType) || typeof issue.title !== "string")
					continue;
				await this.observe(id, issue.statusType, issue.title);
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof SourceRateLimited || error instanceof SourceSignInRequired) throw error;
			}
		}
	}
	async stop(): Promise<void> {
		this.stopped = true;
		this.unsubscribe();
		clearTimeout(this.timer);
		this.run?.controller.abort(new Error("Linear watches stopped"));
		await this.run?.promise;
		await this.registration;
	}
}
