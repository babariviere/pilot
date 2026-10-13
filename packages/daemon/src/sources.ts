import type {
	DashboardTrackedSource,
	Project,
	ProjectTrackingConfig,
	TrackedKind,
	TrackingJson,
	TrackingSource,
	LinearSourceSummary,
	TrackedItemPrefill,
} from "@pilot/protocol";
import { createHash } from "node:crypto";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import type { ProjectStore } from "./projects.ts";
import { SourceRateLimited, SourceSignInRequired, type SourceMcpClient } from "./source-mcp.ts";
import { linearPrefill } from "./linear-source.ts";
import type { SourceCheckpoint, TrackedInput, TrackedItemStore, TrackedQuery } from "./tracked-items.ts";

export interface SourcePollContext {
	project: Project;
	config: ProjectTrackingConfig;
	cursor?: TrackingJson;
	signal: AbortSignal;
	/** Logical tool name, resolved to a fixed dedicated tool. No model in the fetch path. */
	call(tool: string, args: Record<string, unknown>): Promise<TrackingJson>;
}
export interface SourcePollResult {
	items: TrackedInput[];
	cursor?: TrackingJson;
	linear?: LinearSourceSummary;
	/** Full scoped membership, for removing stale rows without losing local links. */
	activeIds?: string[];
}
export type SourcePoller = (context: SourcePollContext) => Promise<SourcePollResult>;
export type TrackingChange = { type: "sources" | "items"; projectId: string };
type Run = { key: string; controller: AbortController; promise: Promise<TrackingSource> };
type Health = {
	key: string;
	status: "ok" | "sign_in_required" | "error";
	error?: string;
	failures: number;
	nextPollAt: number;
};

/** Bounded manual and background polling. Only explicitly registered sources do work. */
export class SourceRegistry {
	private readonly pollers = new Map<TrackedKind, SourcePoller>();
	private readonly running = new Map<string, Run>();
	private readonly health = new Map<string, Health>();
	private readonly listeners = new Set<(change: TrackingChange) => void>();
	private readonly disposers: Array<() => void>;
	private knownProjects: Set<string>;
	private stopped = false;
	private readonly automatic = new Set<TrackedKind>();
	private timer?: ReturnType<typeof setTimeout>;
	private readonly details = new Map<
		string,
		{ sourceId: string; key: string; controller: AbortController; promise: Promise<TrackedItemPrefill> }
	>();
	private readonly projects: Pick<ProjectStore, "list" | "require" | "onChange">;
	readonly items: TrackedItemStore;
	private readonly mcp: SourceMcpClient;
	constructor(
		projects: Pick<ProjectStore, "list" | "require" | "onChange">,
		items: TrackedItemStore,
		mcp: SourceMcpClient,
	) {
		this.projects = projects;
		this.items = items;
		this.mcp = mcp;
		this.knownProjects = new Set(projects.list().map((project) => project.id));
		this.disposers = [
			items.onChange((projectId) => this.emit({ type: "items", projectId })),
			projects.onChange(() => {
				const current = new Set(projects.list().map((project) => project.id));
				for (const id of this.knownProjects) if (!current.has(id)) items.unload(id);
				this.knownProjects = current;
				for (const [id, run] of this.running)
					if (this.currentKey(id) !== run.key) run.controller.abort(new Error("Tracking configuration changed"));
				for (const run of this.details.values())
					if (this.currentKey(run.sourceId) !== run.key)
						run.controller.abort(new Conflict("Tracking configuration changed"));
				for (const id of this.health.keys())
					if (this.currentKey(id) !== this.health.get(id)?.key) this.health.delete(id);
				for (const project of projects.list()) this.emit({ type: "sources", projectId: project.id });
				this.schedule();
			}),
		];
	}
	register(kind: TrackedKind, poller: SourcePoller): void {
		if (this.pollers.has(kind)) throw new Error(`Source ${kind} is already registered`);
		this.pollers.set(kind, poller);
	}
	/** Five-minute cadence, no app polling, timer released when nothing is configured. */
	startPolling(kind: TrackedKind): void {
		if (!this.pollers.has(kind)) throw new Error("Register the source before scheduling it");
		this.automatic.add(kind);
		this.schedule();
	}
	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.stopped) return;
		const sources = this.list().filter(
			(source) => source.configured && this.automatic.has(source.kind) && !this.running.has(source.id),
		);
		if (!sources.length) return;
		const next = Math.min(...sources.map((source) => source.nextPollAt ?? (source.lastPolledAt ?? 0) + 300_000));
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				const source = this.list().find(
					(source) =>
						source.configured &&
						this.automatic.has(source.kind) &&
						!this.running.has(source.id) &&
						(source.nextPollAt ?? (source.lastPolledAt ?? 0) + 300_000) <= Date.now(),
				);
				if (source && this.running.size + this.details.size < 2)
					void this.poll(source.id)
						.catch(() => {})
						.finally(() => this.schedule());
				else this.schedule();
			},
			Math.max(1000, next - Date.now()),
		);
		this.timer.unref();
	}
	onChange(listener: (change: TrackingChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	list(projectId?: string): TrackingSource[] {
		const projects = projectId ? [this.projects.require(projectId)] : this.projects.list();
		return projects.flatMap((project) => (["linear", "slack"] as const).map((kind) => this.describe(project, kind)));
	}
	require(id: string): TrackingSource {
		const split = id.lastIndexOf(":");
		const kind = id.slice(split + 1);
		if (split < 1 || (kind !== "linear" && kind !== "slack")) throw new NotFound(`Unknown source: ${id}`);
		return this.describe(this.projects.require(id.slice(0, split)), kind);
	}
	/** Single flight per source, at most two sources. No unbounded backlog from repeated clicks. */
	poll(id: string): Promise<TrackingSource> {
		if (this.stopped) throw new ServiceUnavailable("Tracking is stopped");
		const source = this.require(id);
		if (!source.configured) throw new Conflict("Configure tracking in Project settings first");
		const key = this.currentKey(id)!;
		if ((this.health.get(id)?.nextPollAt ?? 0) > Date.now() && this.health.get(id)?.status !== "ok")
			throw new Conflict("Source is backing off. Retry after nextPollAt.");
		const running = this.running.get(id);
		if (running) {
			if (running.key !== key) throw new Conflict("Previous poll is cancelling, retry shortly");
			return running.promise;
		}
		const poller = this.pollers.get(source.kind);
		if (!poller) throw new ServiceUnavailable("Source adapter is not installed");
		if (this.running.size + this.details.size >= 2) throw new ServiceUnavailable("Tracking is busy, retry shortly");
		const project = structuredClone(this.projects.require(source.projectId));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("Poll timed out")), 90_000);
		const checkpoint = this.items.checkpoint(id);
		const run: Run = { key, controller, promise: Promise.resolve(source) };
		this.running.set(id, run);
		const work = Promise.resolve().then(() =>
			poller({
				project,
				config: project.tracking!,
				signal: controller.signal,
				...(checkpoint?.configKey === key && checkpoint.cursor !== undefined ? { cursor: checkpoint.cursor } : {}),
				call: (tool, args) => this.mcp.call(source.kind, tool, args, controller.signal),
			}),
		);
		run.promise = abortable(work, controller.signal)
			.then(async (result) => {
				if (controller.signal.aborted || this.currentKey(id) !== key) return;
				const checkpoint: SourceCheckpoint = {
					configKey: key,
					lastPolledAt: Date.now(),
					...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
					...(result.linear ? { linear: result.linear } : {}),
				};
				await this.items.commit(project.id, source.kind, result.items, checkpoint, result.activeIds);
				this.health.set(id, { key, status: "ok", failures: 0, nextPollAt: Date.now() + 300_000 });
			})
			.catch((error) => this.failed(id, key, error))
			.finally(() => {
				clearTimeout(timer);
				this.running.delete(id);
				this.emit({ type: "sources", projectId: project.id });
				this.schedule();
			})
			.then(() => this.require(id));
		this.emit({ type: "sources", projectId: project.id });
		return run.promise;
	}
	dashboard(projectId: string): DashboardTrackedSource[] {
		return this.list(projectId)
			.filter((source) => source.configured)
			.map((source) => {
				const checkpoint = this.items.checkpoint(source.id);
				const { items, total } =
					checkpoint && checkpoint.configKey !== this.currentKey(source.id)
						? { items: [], total: 0 }
						: this.items.preview(projectId, source.kind);
				return {
					source: source.kind,
					label: source.label,
					status: source.status,
					...(source.error ? { error: source.error } : {}),
					total,
					items,
					...(source.linear ? { linear: source.linear } : {}),
				};
			});
	}
	async listItems(query: TrackedQuery): Promise<import("@pilot/protocol").TrackedItemList> {
		// A team setting change must not leak rows from the previously attached team.
		const kinds = (query.kind ? [query.kind] : (["linear", "slack"] as const)).filter((kind) => {
			const id = `${query.projectId}:${kind}`,
				checkpoint = this.items.checkpoint(id);
			return this.require(id).configured && (!checkpoint || checkpoint.configKey === this.currentKey(id));
		});
		const { kind: _kind, ...rest } = query;
		return this.items.list({ ...rest, kinds });
	}
	async prefill(itemId: string): Promise<TrackedItemPrefill> {
		if (this.stopped) throw new ServiceUnavailable("Tracking is stopped");
		const existing = this.details.get(itemId);
		if (existing) return existing.promise;
		if (this.running.size + this.details.size >= 2) throw new ServiceUnavailable("Tracking is busy, retry shortly");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("Prefill timed out")), 60_000);
		const run = { sourceId: "", key: "", controller, promise: Promise.resolve({} as TrackedItemPrefill) };
		// Reserve the slot before reading disk, so repeated clicks cannot race.
		const work = Promise.resolve().then(async () => {
			const item = await this.items.require(itemId);
			controller.signal.throwIfAborted();
			const id = `${item.projectId}:linear`,
				key = this.currentKey(id);
			if (item.kind !== "linear" || !key || this.items.checkpoint(id)?.configKey !== key)
				throw new Conflict("Sync this project's Linear source first");
			if ((this.health.get(id)?.nextPollAt ?? 0) > Date.now() && this.health.get(id)?.status !== "ok")
				throw new Conflict("Source is backing off. Retry after nextPollAt.");
			run.sourceId = id;
			run.key = key;
			const project = structuredClone(this.projects.require(item.projectId));
			const result = await linearPrefill(
				{
					project,
					config: project.tracking!,
					signal: controller.signal,
					call: (tool, args) => this.mcp.call("linear", tool, args, controller.signal),
				},
				item,
			);
			if (this.currentKey(id) !== key) throw new Conflict("Tracking configuration changed");
			return result;
		});
		run.promise = abortable(work, controller.signal)
			.catch((error) => {
				if (error instanceof SourceRateLimited || error instanceof SourceSignInRequired) {
					this.failed(run.sourceId, run.key, error);
					this.emit({ type: "sources", projectId: run.sourceId.slice(0, -7) });
				}
				throw error;
			})
			.finally(() => {
				clearTimeout(timer);
				this.details.delete(itemId);
				this.schedule();
			});
		this.details.set(itemId, run);
		return run.promise;
	}
	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		for (const dispose of this.disposers) dispose();
		for (const run of this.running.values()) run.controller.abort(new Error("Tracking stopped"));
		for (const run of this.details.values()) run.controller.abort(new Error("Tracking stopped"));
		await Promise.allSettled([...this.running.values()].map((run) => run.promise));
		await Promise.allSettled([...this.details.values()].map((run) => run.promise));
		await this.mcp.close?.();
		this.listeners.clear();
	}
	private failed(id: string, key: string, error: unknown): void {
		if (this.currentKey(id) !== key || this.stopped) return;
		const failures = (this.health.get(id)?.failures ?? 0) + 1;
		this.health.set(id, {
			key,
			failures,
			nextPollAt:
				Date.now() +
				Math.max(
					error instanceof SourceRateLimited ? error.retryAfterMs : 0,
					error instanceof SourceSignInRequired
						? 300_000
						: Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 6)),
				),
			status: error instanceof SourceSignInRequired ? "sign_in_required" : "error",
			error:
				error instanceof SourceSignInRequired
					? "Sign in required"
					: error instanceof SourceRateLimited
						? "Rate limited. Sync will retry after a pause."
						: "Could not sync this source. Check pi mcp list and retry.",
		});
	}
	private describe(project: Project, kind: TrackedKind): TrackingSource {
		const id = `${project.id}:${kind}`;
		const configured = kind === "linear" ? !!project.tracking?.linearTeam : !!project.tracking?.slackChannels.length;
		const key = configKey(project, kind),
			health = this.health.get(id),
			checkpoint = this.items.checkpoint(id);
		const status = !configured
			? "not_configured"
			: this.running.get(id)?.key === key
				? "syncing"
				: health?.key === key
					? health.status
					: checkpoint?.configKey === key
						? "ok"
						: "idle";
		return {
			id,
			projectId: project.id,
			kind,
			label: kind === "linear" ? "Linear" : "Slack",
			configured,
			status,
			...(checkpoint?.configKey === key ? { lastPolledAt: checkpoint.lastPolledAt } : {}),
			...(checkpoint?.configKey === key && checkpoint.linear ? { linear: structuredClone(checkpoint.linear) } : {}),
			...(health?.key === key ? { nextPollAt: health.nextPollAt } : {}),
			...(health?.key === key && health.error ? { error: health.error } : {}),
			...(status === "sign_in_required" ? { signInCommand: `pi mcp login ${kind}` } : {}),
		};
	}
	private currentKey(id: string): string | undefined {
		try {
			const source = this.require(id);
			return source.configured ? configKey(this.projects.require(source.projectId), source.kind) : undefined;
		} catch {
			return undefined;
		}
	}
	private emit(change: TrackingChange): void {
		for (const listener of this.listeners) listener(change);
	}
}
function configKey(project: Project, kind: TrackedKind): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				kind === "linear" ? project.tracking?.linearTeam : project.tracking?.slackChannels,
				kind,
				kind === "linear" ? "linear-mine-cycle-descendants-v1" : "dedicated-v1",
			]),
		)
		.digest("hex");
}

/** Even a buggy adapter ignoring cancellation cannot keep a registry slot or commit stale results. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
