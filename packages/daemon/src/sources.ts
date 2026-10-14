import type {
	DashboardTrackedSource,
	Inbox,
	LinearTeamOption,
	Project,
	ProjectTrackingConfig,
	SlackChannelOption,
	SlackChannelStatus,
	SourceSignIn,
	TrackedKind,
	TrackingJson,
	TrackingLookup,
	TrackingSource,
	LinearSourceSummary,
	SlackExcerpt,
	TrackedItemPrefill,
	TrackedItem,
	TrackedItemPatch,
} from "@pilot/protocol";
import { createHash } from "node:crypto";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import type { ProjectStore } from "./projects.ts";
import { SourceRateLimited, SourceSignInRequired, type SourceMcpClient } from "./source-mcp.ts";
import { SourceSignIns } from "./source-sign-in.ts";
import { linearPrefill, linearStart } from "./linear-source.ts";
import { slackChannelProgress, slackExcerpt } from "./slack-source.ts";
import { lookupLinearTeams, lookupSlackChannels } from "./tracking-lookup.ts";
import type { SourceCheckpoint, TrackedInput, TrackedItemStore, TrackedQuery } from "./tracked-items.ts";
import { SlackFormatChanged } from "./slack-format.ts";
import { SlackModelUnavailable } from "./slack-classifier.ts";

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
	issue?: "slack_classification" | "slack_budget" | "slack_channel";
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
	/** Sources to poll at the next timer tick, for example after a sign-in. */
	private readonly due = new Set<string>();
	private timer?: ReturnType<typeof setTimeout>;
	private readonly details = new Map<
		string,
		{ sourceId: string; key: string; controller: AbortController; promise: Promise<TrackedItemPrefill> }
	>();
	/** Confirmed starts, coalesced per item and sharing the two MCP slots. */
	private readonly starts = new Map<
		string,
		{ sourceId: string; key: string; controller: AbortController; promise: Promise<void> }
	>();
	/** Settings lookups, at most one per kind, sharing slots with polls and prefills. */
	private readonly lookups = new Map<TrackedKind, { controller: AbortController; promise: Promise<unknown> }>();
	/** The triage inspector's excerpt: latest selection wins, at most one, sharing the two MCP slots. */
	private excerptRun?: { itemId: string; controller: AbortController; promise: Promise<SlackExcerpt> };
	private excerptGeneration = 0;
	/** Configured Slack channels per project, to hide items of removed channels once. */
	private slackChannels = new Map<string, string>();
	private readonly projects: Pick<ProjectStore, "list" | "require" | "onChange">;
	readonly items: TrackedItemStore;
	private readonly mcp: SourceMcpClient;
	private readonly signIns: SourceSignIns;
	constructor(
		projects: Pick<ProjectStore, "list" | "require" | "onChange">,
		items: TrackedItemStore,
		mcp: SourceMcpClient,
		signInTimeoutMs?: number,
	) {
		this.projects = projects;
		this.items = items;
		this.mcp = mcp;
		this.signIns = new SourceSignIns(
			(kind, options) => mcp.signIn!(kind, options),
			(state) => {
				for (const project of projects.list()) this.emit({ type: "sources", projectId: project.id });
				if (state.state === "done") this.resync(state.kind);
			},
			signInTimeoutMs,
		);
		this.knownProjects = new Set(projects.list().map((project) => project.id));
		this.slackChannels = new Map(
			projects.list().map((project) => [project.id, JSON.stringify(project.tracking?.slackChannels ?? [])]),
		);
		this.disposers = [
			items.onChange((projectId) => this.emit({ type: "items", projectId })),
			projects.onChange(() => {
				const current = new Set(projects.list().map((project) => project.id));
				for (const id of this.knownProjects) if (!current.has(id)) items.unload(id);
				this.knownProjects = current;
				for (const project of projects.list()) {
					const channels = project.tracking?.slackChannels ?? [];
					if (this.slackChannels.get(project.id) === JSON.stringify(channels)) continue;
					this.slackChannels.set(project.id, JSON.stringify(channels));
					// Removing a channel hides its items; adding it back shows them again. Links are kept.
					void items.retainSlack(project.id, channels).catch(() => {});
				}
				for (const [id, run] of this.running)
					if (this.currentKey(id) !== run.key) run.controller.abort(new Error("Tracking configuration changed"));
				for (const run of [...this.details.values(), ...this.starts.values()])
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
		const dueAt = (source: TrackingSource) =>
			this.due.has(source.id) ? 0 : (source.nextPollAt ?? (source.lastPolledAt ?? 0) + 300_000);
		const next = Math.min(...sources.map(dueAt));
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				const source = this.list().find(
					(source) =>
						source.configured &&
						this.automatic.has(source.kind) &&
						!this.running.has(source.id) &&
						dueAt(source) <= Date.now(),
				);
				if (source && this.busy() < 2)
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
		if (this.busy() >= 2) throw new ServiceUnavailable("Tracking is busy, retry shortly");
		this.due.delete(id);
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
				call: (tool, args) => this.readCall(source.kind, tool, args, controller.signal),
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
				if (source.kind === "slack")
					await this.items.retainSlack(
						project.id,
						this.projects.require(project.id).tracking?.slackChannels ?? [],
					);
				const nextPollAt =
					result.issue === "slack_budget"
						? (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000
						: Date.now() + 300_000;
				this.health.set(id, {
					key,
					failures: 0,
					nextPollAt,
					status: result.issue ? "error" : "ok",
					...(result.issue
						? {
								error:
									result.issue === "slack_budget"
										? "Slack classification daily budget reached. Remaining threads will resume tomorrow."
										: result.issue === "slack_channel"
											? "A Slack channel could not be read. Check its access in Tracking settings."
											: "Some Slack threads could not be classified. Failed or interrupted attempts are cached and never retried.",
							}
						: {}),
				});
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
				const { items, total, done } =
					checkpoint && checkpoint.configKey !== this.currentKey(source.id)
						? { items: [], total: 0, done: undefined }
						: this.items.preview(projectId, source.kind);
				return {
					source: source.kind,
					label: source.label,
					status: source.status,
					...(source.error ? { error: source.error } : {}),
					total,
					items,
					...(done ? { done } : {}),
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
	/** Open tracked items the Inbox lists for a project, from cached counts: no disk read. */
	inboxCount(projectId: string): number {
		const project = this.projects.require(projectId);
		const hidden = new Set(hiddenLabels(project));
		let total = 0;
		for (const kind of ["linear", "slack"] as const) {
			if (!this.synced(project, kind)) continue;
			for (const [label, count] of Object.entries(this.items.inboxCounts(projectId, kind)))
				if (!label || !hidden.has(label)) total += count;
		}
		return total;
	}
	/** Open tracked work of one project or every project, for the Inbox. A kind no project tracks is omitted. */
	async inbox(projectId: string | undefined, limit: number): Promise<Pick<Inbox, "linear" | "slack">> {
		const projects = projectId ? [this.projects.require(projectId)] : this.projects.list();
		const linear = projects.filter((project) => this.synced(project, "linear")).map((project) => project.id);
		const slack = projects
			.filter((project) => this.synced(project, "slack"))
			.map((project) => ({ projectId: project.id, hidden: hiddenLabels(project) }));
		const tracks = (kind: TrackedKind) => projects.some((project) => isConfigured(project, kind));
		const result = await this.items.inbox({ linear, slack, limit });
		return {
			...(tracks("linear") ? { linear: result.linear } : {}),
			...(tracks("slack") ? { slack: result.slack } : {}),
		};
	}
	/** Configured, with stored rows from its current settings (a team change must not show the old team's rows). */
	private synced(project: Project, kind: TrackedKind): boolean {
		if (!isConfigured(project, kind)) return false;
		const checkpoint = this.items.checkpoint(`${project.id}:${kind}`);
		return !checkpoint || checkpoint.configKey === configKey(project, kind);
	}
	async prefill(itemId: string): Promise<TrackedItemPrefill> {
		if (this.stopped) throw new ServiceUnavailable("Tracking is stopped");
		const existing = this.details.get(itemId);
		if (existing) return existing.promise;
		if (this.busy() >= 2) throw new ServiceUnavailable("Tracking is busy, retry shortly");
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
					call: (tool, args) => this.readCall("linear", tool, args, controller.signal),
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
	/** The first message of a Slack item's thread, for the triage inspector. Read on demand, never stored. A newer
	 * request replaces the one in flight, so moving through the list never queues Slack reads. Failures are plain,
	 * logged without content, and leave the source's health alone: the inspector shows them quietly. */
	async slackExcerpt(itemId: string): Promise<SlackExcerpt> {
		if (this.stopped) throw new ServiceUnavailable("Tracking is stopped");
		const previous = this.excerptRun;
		if (previous?.itemId === itemId && !previous.controller.signal.aborted) return previous.promise;
		const generation = ++this.excerptGeneration;
		if (previous) {
			previous.controller.abort(new Conflict("Superseded by a newer selection"));
			await previous.promise.catch(() => {});
		}
		const item = await this.items.require(itemId);
		if (generation !== this.excerptGeneration || this.excerptRun)
			throw new Conflict("Superseded by a newer selection");
		if (this.stopped) throw new ServiceUnavailable("Tracking is stopped");
		if (item.kind !== "slack") throw new Conflict("Only Slack messages have an excerpt");
		const id = `${item.projectId}:slack`,
			key = this.currentKey(id);
		if (!key || this.items.checkpoint(id)?.configKey !== key)
			throw new Conflict("Sync this project's Slack source first");
		const health = this.health.get(id);
		if (health?.key === key && health.failures > 0 && health.nextPollAt > Date.now())
			throw new ServiceUnavailable("Slack is unavailable right now");
		if (this.busy() >= 2) throw new ServiceUnavailable("Tracking is busy, retry shortly");
		const project = structuredClone(this.projects.require(item.projectId));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("Excerpt timed out")), 30_000);
		const run = { itemId, controller, promise: Promise.resolve({} as SlackExcerpt) };
		const work = slackExcerpt(
			{
				project,
				config: project.tracking!,
				signal: controller.signal,
				call: (tool, args) => this.readCall("slack", tool, args, controller.signal),
			},
			item,
		);
		run.promise = abortable(work, controller.signal)
			.then((excerpt) => {
				if (this.currentKey(id) !== key) throw new Conflict("Tracking configuration changed");
				return excerpt;
			})
			.catch((error: unknown) => {
				if (error instanceof Conflict) throw error;
				console.warn(`pilotd: Slack excerpt failed for project ${item.projectId}: ${logCause(error)}`);
				throw new ServiceUnavailable(
					error instanceof SourceSignInRequired
						? "Sign in to Slack to read this message"
						: "Couldn't read this message from Slack",
				);
			})
			.finally(() => {
				clearTimeout(timer);
				if (this.excerptRun === run) this.excerptRun = undefined;
				this.schedule();
			});
		this.excerptRun = run;
		return run.promise;
	}
	/** Binding is local and completes before any remote work. A normal link never writes. */
	async patch(itemId: string, patch: TrackedItemPatch): Promise<TrackedItem> {
		const before = await this.items.require(itemId);
		const item = await this.items.patch(itemId, patch);
		const newLink =
			(patch.sessionId && !before.sessionIds?.includes(patch.sessionId)) ||
			(patch.missionId && !before.missionIds?.includes(patch.missionId));
		if (patch.start && newLink && item.kind === "linear") void this.startLinear(item).catch(() => {});
		return item;
	}
	/** Best effort, single flight per item, bounded with all other MCP work, no retry queue. */
	startLinear(item: TrackedItem): Promise<void> {
		if (item.kind !== "linear") return Promise.resolve();
		const existing = this.starts.get(item.id);
		if (existing) return existing.promise;
		if (this.stopped || this.busy() >= 2) return this.items.linearStartResult(item.id, "error");
		const sourceId = `${item.projectId}:linear`;
		const key = this.currentKey(sourceId) ?? "";
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("Linear start timed out")), 60_000);
		const work = Promise.resolve().then(async () => {
			if (!key || this.items.checkpoint(sourceId)?.configKey !== key)
				throw new Conflict("Sync Linear before starting");
			const health = this.health.get(sourceId);
			if (health && health.status !== "ok" && health.nextPollAt > Date.now())
				throw new Conflict("Source is backing off");
			const project = structuredClone(this.projects.require(item.projectId));
			return linearStart(
				{
					project,
					config: project.tracking!,
					signal: controller.signal,
					call: (tool, args) => {
						controller.signal.throwIfAborted();
						if (this.currentKey(sourceId) !== key) throw new Conflict("Tracking configuration changed");
						return this.mcp.call("linear", tool, args, controller.signal);
					},
				},
				item,
			);
		});
		const promise = abortable(work, controller.signal)
			.catch(() => "error" as const)
			.then((outcome) => this.items.linearStartResult(item.id, outcome))
			.finally(() => {
				clearTimeout(timer);
				this.starts.delete(item.id);
				this.schedule();
			});
		this.starts.set(item.id, { sourceId, key, controller, promise });
		return promise;
	}
	private readCall(
		kind: TrackedKind,
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<TrackingJson> {
		if (tool === "startIssue") return Promise.reject(new Error("Source reads cannot write"));
		return this.mcp.call(kind, tool, args, signal);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		for (const dispose of this.disposers) dispose();
		const signIns = this.signIns.stop();
		for (const run of this.running.values()) run.controller.abort(new Error("Tracking stopped"));
		for (const run of this.details.values()) run.controller.abort(new Error("Tracking stopped"));
		for (const run of this.starts.values()) run.controller.abort(new Error("Tracking stopped"));
		for (const run of this.lookups.values()) run.controller.abort(new Error("Tracking stopped"));
		const excerpt = this.excerptRun;
		excerpt?.controller.abort(new Error("Tracking stopped"));
		await Promise.allSettled([...this.running.values()].map((run) => run.promise));
		await Promise.allSettled([...this.details.values()].map((run) => run.promise));
		await Promise.allSettled([...this.lookups.values()].map((run) => run.promise));
		await Promise.allSettled([...this.starts.values()].map((run) => run.promise));
		await excerpt?.promise.catch(() => {});
		await signIns;
		await this.mcp.close?.();
		this.listeners.clear();
	}
	/** Browser sign-in to the kind's dedicated server (pi's MCP OAuth flow). One per server; repeated starts
	 * return the waiting one. Once done, that source resyncs in every project. */
	signIn(kind: TrackedKind, again = false): SourceSignIn {
		if (this.stopped) throw new ServiceUnavailable("Tracking is stopped");
		if (!this.mcp.signIn) throw new ServiceUnavailable("Sign-in is unavailable");
		return this.signIns.start(kind, again);
	}
	cancelSignIn(kind: TrackedKind): SourceSignIn {
		const state = this.signIns.cancel(kind);
		if (!state) throw new NotFound("No sign-in to cancel");
		return state;
	}
	private resync(kind: TrackedKind): void {
		if (this.stopped) return;
		const now = Date.now();
		for (const source of this.list()) {
			if (source.kind !== kind || !source.configured) continue;
			const health = this.health.get(source.id);
			// Keep rate-limit and error backoff; sign-in only answers "sign-in required".
			if (health?.status === "error" && health.nextPollAt > now) continue;
			if (health?.status === "sign_in_required") this.health.delete(source.id);
			this.due.add(source.id);
		}
		this.schedule();
	}
	/** Linear teams for the project settings picker. Read-only, never stored. */
	linearTeams(query?: string): Promise<TrackingLookup<LinearTeamOption>> {
		return this.lookup("linear", (call) => lookupLinearTeams(call, query));
	}
	/** Slack channels matching a query, or the channels I'm in. Read-only, never stored. */
	slackChannelOptions(query?: string): Promise<TrackingLookup<SlackChannelOption>> {
		return this.lookup("slack", (call) => lookupSlackChannels(call, query));
	}
	/** Latest wins per kind, so typing in a search field never queues MCP work. */
	private async lookup<T>(
		kind: TrackedKind,
		work: (call: (tool: string, args: Record<string, unknown>) => Promise<TrackingJson>) => Promise<{
			items: T[];
			more: boolean;
		}>,
	): Promise<TrackingLookup<T>> {
		if (this.stopped) throw new ServiceUnavailable("Tracking is stopped");
		const previous = this.lookups.get(kind);
		if (previous) {
			previous.controller.abort(new Error("Superseded by a newer lookup"));
			await previous.promise.catch(() => {});
			if (this.lookups.get(kind)) return { status: "error", items: [], error: "Superseded by a newer search." };
		}
		if (this.busy() >= 2) return { status: "error", items: [], error: "Tracking is syncing. Try again in a moment." };
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("Lookup timed out")), 45_000);
		const label = kind === "linear" ? "Linear" : "Slack";
		const promise = abortable(
			work((tool, args) => this.readCall(kind, tool, args, controller.signal)),
			controller.signal,
		)
			.then(({ items, more }): TrackingLookup<T> => ({ status: "ok", items, ...(more ? { more } : {}) }))
			.catch((error): TrackingLookup<T> => {
				if (error instanceof SourceSignInRequired)
					return {
						status: "sign_in_required",
						items: [],
						error: "Sign in required",
						signInCommand: `pi mcp login ${kind}`,
					};
				return {
					status: "error",
					items: [],
					error:
						error instanceof SourceRateLimited
							? `${label} is rate limiting requests. Try again in a minute.`
							: controller.signal.aborted
								? "The search was cancelled. Try again."
								: `Couldn't reach ${label}. Try again in a moment.`,
				};
			})
			.finally(() => {
				clearTimeout(timer);
				if (this.lookups.get(kind)?.controller === controller) this.lookups.delete(kind);
				this.schedule();
			});
		this.lookups.set(kind, { controller, promise });
		return promise;
	}
	private busy(): number {
		return this.running.size + this.details.size + this.lookups.size + this.starts.size + (this.excerptRun ? 1 : 0);
	}
	private failed(id: string, key: string, error: unknown): void {
		if (this.currentKey(id) !== key || this.stopped) return;
		const failures = (this.health.get(id)?.failures ?? 0) + 1;
		const label = id.endsWith(":slack") ? "Slack" : "Linear";
		// The app shows plain text and the retry time. The technical cause goes to the daemon log only.
		console.warn(`pilotd: ${label} sync failed for project ${id.slice(0, id.lastIndexOf(":"))}: ${logCause(error)}`);
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
						? `${label} is limiting requests.`
						: error instanceof SlackFormatChanged || error instanceof SlackModelUnavailable
							? error.message
							: `Couldn't read ${label}.`,
		});
	}
	private describe(project: Project, kind: TrackedKind): TrackingSource {
		const id = `${project.id}:${kind}`;
		const configured = isConfigured(project, kind);
		const key = configKey(project, kind),
			health = this.health.get(id),
			checkpoint = this.items.checkpoint(id),
			signIn = this.signIns.get(kind);
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
			...(kind === "slack" && configured
				? {
						channels: this.channelStatus(
							project.tracking!,
							status,
							checkpoint?.configKey === key ? checkpoint : undefined,
						),
					}
				: {}),
			...(signIn ? { signIn } : {}),
		};
	}
	private channelStatus(
		config: ProjectTrackingConfig,
		status: TrackingSource["status"],
		checkpoint: SourceCheckpoint | undefined,
	): SlackChannelStatus[] {
		const progress = slackChannelProgress(checkpoint?.cursor, config.slackChannels);
		return config.slackChannels.map((id, index) => {
			const { pulledAt, failedAt } = progress[index]!;
			const name = config.slackChannelNames?.[id];
			const failed = !!failedAt && (!pulledAt || failedAt > pulledAt);
			return {
				id,
				...(name ? { name } : {}),
				status: status === "sign_in_required" ? "sign_in_required" : failed ? "error" : pulledAt ? "ok" : "pending",
				...(pulledAt ? { lastPulledAt: pulledAt } : {}),
				...(failed && status !== "sign_in_required"
					? { error: "Couldn't read this channel. Check that you can open it in Slack." }
					: {}),
			};
		});
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
				// Slack progress is kept per channel, so editing the list does not restart the others.
				kind === "linear" ? project.tracking?.linearTeam : null,
				kind,
				kind === "linear" ? "linear-mine-cycle-descendants-v1" : "dedicated-v2",
			]),
		)
		.digest("hex");
}

/** Project labels whose Slack messages stay out of the Inbox. */
function hiddenLabels(project: Project): string[] {
	return (project.tracking?.slackLabels ?? []).filter((label) => label.hideFromInbox).map((label) => label.name);
}

function isConfigured(project: Project, kind: TrackedKind): boolean {
	return kind === "linear" ? !!project.tracking?.linearTeam : !!project.tracking?.slackChannels.length;
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
/** One bounded line for the daemon log. Never message content: JSON syntax errors quote their input. */
export function logCause(error: unknown): string {
	if (error instanceof SlackFormatChanged) return `Slack response format changed (${error.reason})`;
	if (error instanceof SyntaxError) return "SyntaxError: invalid JSON";
	const text = error instanceof Error ? `${error.name}: ${error.message}` : `non-error ${typeof error}`;
	return text.replace(/\s+/g, " ").slice(0, 200);
}
