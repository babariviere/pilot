import type {
	DashboardTrackedSource,
	Project,
	ProjectTrackingConfig,
	TrackedKind,
	TrackingJson,
	TrackingSource,
} from "@pilot/protocol";
import { createHash } from "node:crypto";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import type { ProjectStore } from "./projects.ts";
import { SourceSignInRequired, type SourceMcpClient } from "./source-mcp.ts";
import type { SourceCheckpoint, TrackedInput, TrackedItemStore } from "./tracked-items.ts";

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
}
export type SourcePoller = (context: SourcePollContext) => Promise<SourcePollResult>;
export type TrackingChange = { type: "sources" | "items"; projectId: string };
type Run = { key: string; controller: AbortController; promise: Promise<TrackingSource> };
type Health = { key: string; status: "ok" | "sign_in_required" | "error"; error?: string };

/** Manual polling framework. Adapters add fetch/normalization, scheduling can be layered on later. */
export class SourceRegistry {
	private readonly pollers = new Map<TrackedKind, SourcePoller>();
	private readonly running = new Map<string, Run>();
	private readonly health = new Map<string, Health>();
	private readonly listeners = new Set<(change: TrackingChange) => void>();
	private readonly disposers: Array<() => void>;
	private knownProjects: Set<string>;
	private stopped = false;
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
				for (const id of this.health.keys())
					if (this.currentKey(id) !== this.health.get(id)?.key) this.health.delete(id);
				for (const project of projects.list()) this.emit({ type: "sources", projectId: project.id });
			}),
		];
	}
	register(kind: TrackedKind, poller: SourcePoller): void {
		if (this.pollers.has(kind)) throw new Error(`Source ${kind} is already registered`);
		this.pollers.set(kind, poller);
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
		const running = this.running.get(id);
		if (running) {
			if (running.key !== key) throw new Conflict("Previous poll is cancelling, retry shortly");
			return running.promise;
		}
		const poller = this.pollers.get(source.kind);
		if (!poller) throw new ServiceUnavailable("Source adapter is not installed");
		if (this.running.size >= 2) throw new ServiceUnavailable("Tracking is busy, retry shortly");
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
				};
				await this.items.commit(project.id, source.kind, result.items, checkpoint);
				this.health.set(id, { key, status: "ok" });
			})
			.catch((error) => {
				if (this.currentKey(id) !== key || this.stopped) return;
				this.health.set(id, {
					key,
					status: error instanceof SourceSignInRequired ? "sign_in_required" : "error",
					error:
						error instanceof SourceSignInRequired
							? "Sign in required"
							: "Could not sync this source. Check pi mcp list and retry.",
				});
			})
			.finally(() => {
				clearTimeout(timer);
				this.running.delete(id);
				this.emit({ type: "sources", projectId: project.id });
			})
			.then(() => this.require(id));
		this.emit({ type: "sources", projectId: project.id });
		return run.promise;
	}
	dashboard(projectId: string): DashboardTrackedSource[] {
		return this.list(projectId)
			.filter((source) => source.configured)
			.map((source) => {
				const { items, total } = this.items.preview(projectId, source.kind);
				return {
					source: source.kind,
					label: source.label,
					status: source.status,
					...(source.error ? { error: source.error } : {}),
					total,
					items,
				};
			});
	}
	async stop(): Promise<void> {
		this.stopped = true;
		for (const dispose of this.disposers) dispose();
		for (const run of this.running.values()) run.controller.abort(new Error("Tracking stopped"));
		await Promise.allSettled([...this.running.values()].map((run) => run.promise));
		await this.mcp.close?.();
		this.listeners.clear();
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
				"dedicated-v1",
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
