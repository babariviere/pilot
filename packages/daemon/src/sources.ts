import { createHash } from "node:crypto";
import type {
	DashboardTrackedSource,
	Inbox,
	LinearParentHeader,
	LinearSourceSummary,
	LinearTeamOption,
	LinearWorkflowStateOption,
	Project,
	ProjectTrackingConfig,
	RefreshObservation,
	RefreshReason,
	SlackChannelOption,
	SlackChannelStatus,
	SlackExcerpt,
	SourceSignIn,
	TrackedItem,
	TrackedItemList,
	TrackedItemPatch,
	TrackedItemPrefill,
	TrackedKind,
	TrackingJson,
	TrackingLookup,
	TrackingSource,
} from "@pilot/protocol";
import { redactDiagnosticText } from "./diagnostic-redaction.ts";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import { linearParentHeaders, linearPrefill, linearStart } from "./linear-source.ts";
import { workflowStates } from "./linear-workflow.ts";
import type { ProjectStore } from "./projects.ts";
import { SlackModelUnavailable } from "./slack-classifier.ts";
import { parseSlackMessageLink, SlackFormatChanged } from "./slack-format.ts";
import type { SlackReactionOwner } from "./slack-reaction-owner.ts";
import { addSlackDone, refreshSlackReactions, removeSlackEyes } from "./slack-reactions.ts";
import { type SlackAdder, slackChannelProgress, slackExcerpt } from "./slack-source.ts";
import { slackStart, slackStartAllowed } from "./slack-start.ts";
import type { SlackWaitingWatcher } from "./slack-waiting.ts";
import {
	SlackRemovalError,
	type SlackRemovalFailure,
	type SourceMcpClient,
	SourceRateLimited,
	SourceSignInRequired,
	SourceToolError,
} from "./source-mcp.ts";
import {
	refreshAssessment,
	SOURCE_REFRESH_CADENCE_MS,
	SOURCE_REFRESH_TIMEOUT_MS,
	SourceRefreshDiagnostics,
} from "./source-refresh-diagnostics.ts";
import { SourceSignIns } from "./source-sign-in.ts";
import type { SourceCheckpoint, TrackedInput, TrackedItemStore, TrackedQuery } from "./tracked-items.ts";
import { SLACK_BUDGET_WINDOW_MS, SLACK_REACTION_RECHECK_MS } from "./tracked-items-disk.ts";
import { lookupLinearTeams, lookupSlackChannels } from "./tracking-lookup.ts";
import type { TriageGroomer } from "./triage-grooming.ts";

export interface SourcePollContext {
	/** Manual override for this pass only. Provider rate limits and batch caps still apply. */
	force?: boolean;
	/** Closed process-local observation only. Never carries source content or model/tool arguments. */
	observe?(event: RefreshObservation): void;
	project: Project;
	config: ProjectTrackingConfig;
	cursor?: TrackingJson;
	signal: AbortSignal;
	/** Logical capability: dedicated source tools, except the local opt-in eyes removal route. No model here. */
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
type Run = {
	key: string;
	startedAt: number;
	controller: AbortController;
	promise: Promise<TrackingSource>;
	allowed?: () => boolean;
};
type Health = {
	key: string;
	status: "ok" | "sign_in_required" | "error";
	error?: string;
	localBudget?: boolean;
	/** The provider asked Pilot to wait (rate limit). Manual syncs respect it; ordinary error backoff they skip. */
	limited?: boolean;
	failures: number;
	nextPollAt: number;
};

/** Bounded manual and background polling. Only explicitly registered sources do work. */
export class SourceRegistry {
	readonly refreshDiagnostics = new SourceRefreshDiagnostics();
	/** Optional read-only consumer. Runs only after a validated Linear poll is committed. */
	linearObserved?: (projectId: string, items: TrackedInput[], activeIds: string[]) => Promise<void>;
	triage?: TriageGroomer;
	/** Reads and classifies a Slack message the user pasted. Without it, adding by link is unavailable. */
	slackAdder?: SlackAdder;
	/** Reads waiting messages' threads after each Slack poll and resumes their chats. Set once chats can be resumed. */
	slackWaiting?: SlackWaitingWatcher;
	/** How long an open Slack item waits before its ✅ is checked again. Tests shorten it. */
	slackReactionRecheckMs = SLACK_REACTION_RECHECK_MS;
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
		{ sourceId: string; key: string; controller: AbortController; promise: Promise<void>; allowed?: () => boolean }
	>();
	/** At most one done write per project, sharing the two MCP slots. The durable store is the backlog. */
	private readonly doneRuns = new Map<
		string,
		{
			sourceId: string;
			key: string;
			controller: AbortController;
			promise: Promise<void>;
			allowed: () => boolean;
			itemId: () => string | undefined;
		}
	>();
	private readonly doneDue = new Set<string>();
	private doneScheduled = false;
	/** Settings lookups, at most one per kind, sharing slots with polls and prefills. */
	private readonly lookups = new Map<TrackedKind, { controller: AbortController; promise: Promise<unknown> }>();
	/** The triage inspector's excerpt: latest selection wins, at most one, sharing the two MCP slots. */
	private excerptRun?: { itemId: string; controller: AbortController; promise: Promise<SlackExcerpt> };
	private excerptGeneration = 0;
	/** Slack messages being added from pasted links, coalesced per message and sharing the two MCP slots. */
	private readonly adds = new Map<string, { controller: AbortController; promise: Promise<TrackedItem> }>();
	/** Configured Slack channels per project, to hide items of removed channels once. */
	private slackChannels = new Map<string, string>();
	/** Close labels last sent to the store per project, so only changed effects reconcile stored messages. */
	private readonly slackClose = new Map<string, string>();
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
		this.syncLabelEffects();
		this.disposers = [
			items.onChange((projectId) => {
				this.emit({ type: "items", projectId });
				this.queueSlackDone(projectId);
			}),
			projects.onChange(() => {
				const current = new Set(projects.list().map((project) => project.id));
				for (const id of this.knownProjects) if (!current.has(id)) items.unload(id);
				this.knownProjects = current;
				for (const id of this.slackClose.keys()) if (!current.has(id)) this.slackClose.delete(id);
				this.syncLabelEffects();
				for (const project of projects.list()) {
					const channels = project.tracking?.slackChannels ?? [];
					if (this.slackChannels.get(project.id) === JSON.stringify(channels)) continue;
					this.slackChannels.set(project.id, JSON.stringify(channels));
					// Removing a channel hides its items; adding it back shows them again. Links are kept.
					void items.retainSlack(project.id, channels).catch(() => {});
				}
				for (const [id, run] of this.running)
					if (this.currentKey(id) !== run.key || run.allowed?.() === false)
						run.controller.abort(new Error("Tracking configuration changed"));
				for (const run of [...this.details.values(), ...this.starts.values(), ...this.doneRuns.values()])
					if (this.currentKey(run.sourceId) !== run.key || ("allowed" in run && run.allowed && !run.allowed()))
						run.controller.abort(new Conflict("Tracking configuration changed"));
				for (const id of this.health.keys())
					if (this.currentKey(id) !== this.health.get(id)?.key) this.health.delete(id);
				this.refreshDiagnostics.prune((id) => this.currentKey(id));
				for (const project of projects.list()) this.emit({ type: "sources", projectId: project.id });
				this.schedule();
			}),
		];
		for (const project of projects.list()) this.queueSlackDone(project.id);
	}
	register(kind: TrackedKind, poller: SourcePoller): void {
		if (this.pollers.has(kind)) throw new Error(`Source ${kind} is already registered`);
		this.pollers.set(kind, poller);
	}
	/** Sends changed close labels to the store, which closes and reopens stored messages to match. At startup every
	 * project is sent, so effects and stored rows agree after a restart or an edit made while pilotd was stopped. */
	private syncLabelEffects(): void {
		const entries = this.projects
			.list()
			.map((project) => ({ projectId: project.id, close: closeLabels(project) }))
			.filter((entry) => this.slackClose.get(entry.projectId) !== JSON.stringify(entry.close));
		if (!entries.length) return;
		for (const entry of entries) this.slackClose.set(entry.projectId, JSON.stringify(entry.close));
		void this.items.slackLabelEffects(entries).catch((error: unknown) => {
			// Retry with the next settings change.
			for (const entry of entries)
				if (this.slackClose.get(entry.projectId) === JSON.stringify(entry.close))
					this.slackClose.delete(entry.projectId);
			console.warn(`pilotd: Slack label effects failed: ${logCause(error)}`);
		});
	}
	/** Five-minute cadence, no app polling, timer released when nothing is configured. */
	startPolling(kind: TrackedKind): void {
		if (!this.pollers.has(kind)) throw new Error("Register the source before scheduling it");
		this.automatic.add(kind);
		this.schedule();
	}
	private schedule(): void {
		this.pumpSlackDone();
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.stopped) return;
		const sources = this.list().filter(
			(source) => source.configured && this.automatic.has(source.kind) && !this.running.has(source.id),
		);
		if (!sources.length) return;
		const dueAt = (source: TrackingSource) =>
			this.due.has(source.id) ? 0 : (source.nextPollAt ?? (source.lastPolledAt ?? 0) + SOURCE_REFRESH_CADENCE_MS);
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
	/** Pure local projection. Never schedules, reserves work, polls MCP or writes product state. */
	refreshHealth(
		options: { projectId?: string; kind?: TrackedKind; offset?: number; limit?: number; channelOffset?: number } = {},
	) {
		const coverage = this.refreshDiagnostics.coverage();
		const now = Date.now();
		if (!coverage.enabled)
			return {
				schemaVersion: 1,
				collectedAt: now,
				coverage,
				availability: "disabled",
				sources: [],
				total: 0,
				more: false,
				scanned: 0,
			};
		const projects = options.projectId ? [this.projects.require(options.projectId)] : this.projects.list();
		const kinds: TrackedKind[] = options.kind ? [options.kind] : ["linear", "slack"];
		const offset = options.offset ?? 0,
			limit = Math.min(5, options.limit ?? 5),
			channelOffset = options.channelOffset ?? 0;
		const total = projects.length * kinds.length;
		const slots = this.busy();
		const sources = [];
		for (let position = offset; position < Math.min(total, offset + limit); position++) {
			const project = projects[Math.floor(position / kinds.length)]!,
				kind = kinds[position % kinds.length]!;
			const id = `${project.id}:${kind}`,
				key = configKey(project, kind);
			const configured = isConfigured(project, kind),
				adapter = this.pollers.has(kind),
				automatic = this.automatic.has(kind);
			const run = this.running.get(id);
			const health = this.health.get(id)?.key === key ? this.health.get(id) : undefined;
			const checkpoint = this.items.checkpoint(id);
			const currentCheckpoint = checkpoint?.configKey === key ? checkpoint : undefined;
			const live = this.refreshDiagnostics.read(id, key);
			const explicitDueAt = this.refreshDiagnostics.dueAt(id, key);
			const nextDueAt = this.due.has(id)
				? (explicitDueAt ?? now)
				: (health?.nextPollAt ?? (currentCheckpoint?.lastPolledAt ?? 0) + SOURCE_REFRESH_CADENCE_MS);
			const backoff = health?.localBudget
				? live?.stages.some((stage) => stage.reason === "local_classification_budget")
					? "local_classification_budget"
					: live?.stages.some((stage) => stage.reason === "local_read_budget")
						? "local_read_budget"
						: "local_budget_unknown_stage"
				: health?.limited
					? "provider_rate_limit"
					: health?.status === "sign_in_required"
						? "sign_in"
						: health?.status === "error" && health.failures > 0
							? "failure_backoff"
							: undefined;
			const channels = kind === "slack" ? (project.tracking?.slackChannels ?? []).slice(0, 100) : [];
			const progress = slackChannelProgress(currentCheckpoint?.cursor, channels, true);
			const channelRows = channels.slice(channelOffset, channelOffset + 20).map((channel, index) => {
				const ordinal = channelOffset + index,
					value = progress[ordinal]!;
				const clockSkew =
					(value.pulledAt !== undefined && value.pulledAt > now) ||
					(value.failedAt !== undefined && value.failedAt > now);
				const pageAgeMs = value.pulledAt === undefined || clockSkew ? undefined : Math.max(0, now - value.pulledAt);
				return {
					ref: `refresh-channel:v1:${createHash("sha256").update(`${project.id}\0${channel}`).digest("hex").slice(0, 24)}`,
					index: ordinal,
					...(/^[CDG][A-Z0-9]{1,199}$/.test(channel) ? { channelId: channel } : {}),
					lastPulledAt: value.pulledAt,
					failedAt: value.failedAt,
					hasMore: value.hasMore === true ? true : undefined,
					provenance: "retained_checkpoint_page_only_not_full_channel_freshness",
					pageAgeMs,
					clockSkew,
					coverage: clockSkew
						? "unknown_clock"
						: value.failedAt !== undefined && (value.pulledAt === undefined || value.failedAt >= value.pulledAt)
							? "failed_page"
							: value.pulledAt === undefined
								? "unknown"
								: value.hasMore
									? "partial_backlog"
									: "one_page_observed",
					...(pageAgeMs !== undefined &&
					pageAgeMs > channels.length * SOURCE_REFRESH_CADENCE_MS + SOURCE_REFRESH_TIMEOUT_MS
						? { nominallyOverdue: true }
						: {}),
				};
			});
			const stages = live?.stages ?? [];
			const error = health?.error;
			sources.push({
				id,
				projectId: project.id,
				kind,
				configured,
				adapterAvailable: adapter,
				scheduler: {
					automatic,
					stopped: this.stopped,
					timerInstalled: this.timer !== undefined,
					timerScope: "shared_registry",
					cadenceMs: SOURCE_REFRESH_CADENCE_MS,
					sharedSlots: 2,
					busySlots: slots,
					timeoutMs: SOURCE_REFRESH_TIMEOUT_MS,
					...(configured && automatic && !this.stopped ? { nextDueAt } : {}),
				},
				assessment: refreshAssessment(
					{
						configured,
						adapter,
						automatic,
						stopped: this.stopped,
						...(run
							? {
									running: {
										startedAt: run.startedAt,
										cancelling: run.controller.signal.aborted || run.key !== key,
									},
								}
							: {}),
						nextDueAt,
						busySlots: slots,
						live,
						backoff,
						checkpointAt: currentCheckpoint?.lastPolledAt,
						unobservedDueOverride: this.due.has(id) && explicitDueAt === undefined,
					},
					now,
				),
				live,
				checkpointCommittedAt: currentCheckpoint?.lastPolledAt,
				checkpointProvenance: "retained_only_not_live_scheduler_or_all_channel_success",
				...(backoff ? { backoff: { reason: backoff, until: health?.nextPollAt } } : {}),
				...(error ? { error: error.length <= 512 ? redactDiagnosticText(error) : "[Error detail withheld]" } : {}),
				stageCoverage: [
					"discovery",
					"classification",
					"commit",
					...(kind === "slack" ? ["waiting_replies", "reaction_reads"] : []),
				].map((stage) => {
					const observation = stages.find((s) => s.stage === stage);
					const unavailable = stage === "waiting_replies" && !this.slackWaiting;
					const incomplete = observation?.lastStartedAt !== undefined && observation.lastCompletedAt === undefined;
					return {
						stage,
						availability: unavailable ? "not_installed" : observation ? "observed_this_process" : "unknown",
						state: unavailable
							? "unavailable"
							: !observation
								? "unknown"
								: incomplete
									? run?.key === key && !run.controller.signal.aborted
										? "running"
										: "incomplete"
									: (observation.outcome ?? "unknown"),
					};
				}),
				...(kind === "slack"
					? {
							channelCoverage: {
								total: project.tracking?.slackChannels.length ?? 0,
								returned: channelRows.length,
								offset: channelOffset,
								more: channelOffset + channelRows.length < (project.tracking?.slackChannels.length ?? 0),
								nominalRoundRobinMs: channels.length * SOURCE_REFRESH_CADENCE_MS,
								unit: "one_history_page_per_poll_shared_slot_and_backoff_delays_possible",
								channels: channelRows,
							},
						}
					: {}),
			});
		}
		return {
			schemaVersion: 1,
			collectedAt: now,
			availability: "partial",
			limits: { sourcesPerPage: 5, channelStatesPerSource: 100, channelsReturnedPerSource: 20 },
			coverage,
			sources,
			total,
			more: offset + sources.length < total,
			scanned: sources.length,
			coverageGaps: [
				"linked_linear_mission_sync",
				"linear_parent_header_refresh",
				"manual_discovery_lookups",
				"slack_done_writes",
				"triage_guide_rebuilds",
			],
			stageCountMeaning: {
				discovery: "returned_items_or_messages",
				classification: "classification_admissions_when_reported_not_provider_calls",
				commit: "committed_items",
				waiting_replies: "reserved_batch_size_not_read_count",
				reaction_reads: "reserved_batch_size_not_read_count",
			},
			freshnessRule:
				"Only process-local attempts/completions and successful commits establish observed progress; checkpoints and silence never prove live scheduling or all-channel freshness.",
		};
	}

	/** Single flight per source, at most two sources. No unbounded backlog from repeated clicks. */
	poll(id: string, force = false): Promise<TrackingSource> {
		if (this.stopped) throw new ServiceUnavailable("Tracking is stopped");
		const source = this.require(id);
		if (!source.configured) throw new Conflict("Attach a Linear team or Slack channels in project settings first");
		if (force && source.kind !== "slack") throw new Conflict("Only Slack supports forcing the local budget");
		const key = this.currentKey(id)!;
		// Background polling waits out error backoff on its own schedule. A manual sync retries right away,
		// except while the provider is rate limiting or Slack's local hourly budget is spent.
		const health = this.health.get(id);
		if (
			health &&
			health.status !== "ok" &&
			health.nextPollAt > Date.now() &&
			(health.limited || (health.localBudget && !force))
		)
			throw new Conflict(
				health.localBudget
					? (health.error ?? "Slack hourly budget reached.")
					: `${source.kind === "slack" ? "Slack" : "Linear"} is limiting requests. Pilot will retry automatically.`,
			);
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
		const timer = setTimeout(() => controller.abort(new Error("Poll timed out")), SOURCE_REFRESH_TIMEOUT_MS);
		const checkpoint = this.items.checkpoint(id);
		const run: Run = {
			key,
			startedAt: Date.now(),
			controller,
			promise: Promise.resolve(source),
			...(source.kind === "slack"
				? {
						allowed: () =>
							this.knownProjects.has(project.id) &&
							slackPollScope(this.projects.require(project.id)) === slackPollScope(project),
					}
				: {}),
		};
		this.running.set(id, run);
		this.refreshDiagnostics.begin(id, key);
		let discoveryObserved = false;
		const observe = (event: RefreshObservation) => {
			if (
				this.running.get(id) !== run ||
				controller.signal.aborted ||
				this.currentKey(id) !== key ||
				run.allowed?.() === false
			)
				return;
			if (event.stage === "discovery" && event.phase === "completed") discoveryObserved = true;
			this.refreshDiagnostics.observe(id, key, event);
		};
		observe({ stage: "discovery", phase: "started" });
		const work = Promise.resolve().then(() =>
			poller({
				force,
				observe,
				project,
				config: project.tracking!,
				signal: controller.signal,
				...(checkpoint?.configKey === key && checkpoint.cursor !== undefined ? { cursor: checkpoint.cursor } : {}),
				call: (tool, args) => this.readCall(source.kind, tool, args, controller.signal),
			}),
		);
		run.promise = abortable(work, controller.signal)
			.then(async (result) => {
				if (controller.signal.aborted || this.currentKey(id) !== key || run.allowed?.() === false) return;
				if (!discoveryObserved)
					observe({
						stage: "discovery",
						phase: "completed",
						outcome: result.issue ? "partial" : "success",
						count: result.items.length,
					});
				observe({ stage: "commit", phase: "started" });
				const checkpoint: SourceCheckpoint = {
					configKey: key,
					lastPolledAt: Date.now(),
					...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
					...(result.linear ? { linear: result.linear } : {}),
				};
				await this.items.commit(project.id, source.kind, result.items, checkpoint, result.activeIds);
				observe({ stage: "commit", phase: "completed", outcome: "success", count: result.items.length });
				if (source.kind === "linear")
					await this.linearObserved?.(
						project.id,
						result.items,
						result.activeIds ?? result.items.map((item) => item.externalId),
					);
				if (source.kind === "slack")
					await this.items.retainSlack(
						project.id,
						this.projects.require(project.id).tracking?.slackChannels ?? [],
					);
				if (source.kind === "slack") {
					const context: SourcePollContext = {
						force,
						observe,
						project,
						config: project.tracking!,
						signal: controller.signal,
						call: (tool, args) => this.readCall("slack", tool, args, controller.signal),
					};
					// Replies to waiting messages resume work, so they go before reaction checks in the shared budget.
					if (this.slackWaiting) observe({ stage: "waiting_replies", phase: "started" });
					const waiting = this.slackWaiting ? await this.slackWaiting(context) : false;
					// A budget spent by reaction checks only defers them. New messages keep being read.
					observe({ stage: "reaction_reads", phase: "started" });
					await refreshSlackReactions(this.items, context, this.slackReactionRecheckMs);
					if (waiting) result.issue = "slack_budget";
				}
				const nextPollAt =
					result.issue === "slack_budget"
						? (Math.floor(Date.now() / SLACK_BUDGET_WINDOW_MS) + 1) * SLACK_BUDGET_WINDOW_MS
						: Date.now() + SOURCE_REFRESH_CADENCE_MS;
				this.health.set(id, {
					key,
					failures: 0,
					nextPollAt,
					status: result.issue ? "error" : "ok",
					...(result.issue === "slack_budget" ? { localBudget: true } : {}),
					...(result.issue
						? {
								error:
									result.issue === "slack_budget"
										? "Slack hourly budget reached. Resumes next hour."
										: result.issue === "slack_channel"
											? "A Slack channel could not be read. Check its access in project settings."
											: "Some Slack threads could not be classified. Failed or interrupted attempts are cached and never retried.",
							}
						: {}),
				});
				this.refreshDiagnostics.end(
					id,
					key,
					controller.signal.aborted ? "cancelled" : result.issue ? "partial" : "success",
					controller.signal.aborted ? (this.stopped ? "stopped" : "config_changed") : undefined,
				);
			})
			.catch((error) => {
				const reason: RefreshReason = controller.signal.aborted
					? this.stopped
						? "stopped"
						: this.currentKey(id) !== key || run.allowed?.() === false
							? "config_changed"
							: "timeout"
					: error instanceof SourceSignInRequired
						? "sign_in"
						: error instanceof SourceRateLimited
							? "provider_rate_limit"
							: error instanceof SlackModelUnavailable
								? "classifier_unavailable"
								: "read_failed";
				this.refreshDiagnostics.end(id, key, controller.signal.aborted ? "cancelled" : "failure", reason);
				this.failed(id, key, error);
			})
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
				const { items, total, done, commonCases } =
					checkpoint && checkpoint.configKey !== this.currentKey(source.id)
						? { items: [], total: 0, done: undefined }
						: this.items.preview(projectId, source.kind);
				return {
					source: source.kind,
					label: source.label,
					status: source.status,
					...(source.error ? { error: source.error } : {}),
					total,
					items: this.withParents(items, () => projectId),
					...(done ? { done: { ...done, items: this.withParents(done.items, () => projectId) } } : {}),
					...(commonCases ? { commonCases } : {}),
					...(source.linear ? { linear: source.linear } : {}),
				};
			});
	}
	async commonCases(projectId: string): Promise<import("@pilot/protocol").SlackCommonCaseList> {
		const source = this.require(`${projectId}:slack`),
			checkpoint = this.items.checkpoint(source.id);
		if (!source.configured || (checkpoint && checkpoint.configKey !== this.currentKey(source.id)))
			return { cases: [], windowDays: 30, windowLimit: 200, truncated: false };
		return this.items.commonCases(projectId);
	}
	async listItems(query: TrackedQuery): Promise<import("@pilot/protocol").TrackedItemList> {
		// A team setting change must not leak rows from the previously attached team.
		const kinds = (query.kind ? [query.kind] : (["linear", "slack"] as const)).filter((kind) => {
			const id = `${query.projectId}:${kind}`,
				checkpoint = this.items.checkpoint(id);
			return this.require(id).configured && (!checkpoint || checkpoint.configKey === this.currentKey(id));
		});
		const { kind: _kind, ...rest } = query;
		const list = await this.items.list({ ...rest, kinds });
		return { ...list, items: this.withParents(list.items, (item) => item.projectId) };
	}
	/** Slack messages in triage, of one project or every project that tracks Slack, matching every word of a query
	 * in their title, channel or thread text, or the thread of a pasted Slack link. Latest first, done and dismissed
	 * included. Local only: no Slack reads. */
	async searchSlack(query: string, projectId: string | undefined, limit: number): Promise<TrackedItemList> {
		const projects = projectId ? [this.projects.require(projectId)] : this.projects.list();
		const projectIds = projects.filter((project) => this.synced(project, "slack")).map((project) => project.id);
		const link = parseSlackMessageLink(query);
		return this.items.searchSlack({
			projectIds,
			query: link ? "" : query.slice(0, 500),
			...(link
				? { externalIds: [...new Set([`${link.channel}/${link.threadTs}`, `${link.channel}/${link.ts}`])] }
				: {}),
			limit,
		});
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
			...(tracks("linear")
				? { linear: { ...result.linear, items: this.withParents(result.linear.items, (item) => item.projectId) } }
				: {}),
			...(tracks("slack") ? { slack: result.slack } : {}),
		};
	}
	/** Attach cached parent headers to Linear sub-issues. Headers live in each project's Linear checkpoint, so
	 * this reads no disk and makes no source calls. */
	private withParents<T extends { metadata?: Record<string, TrackingJson>; linearParent?: LinearParentHeader }>(
		items: T[],
		projectOf: (item: T) => string,
	): T[] {
		const headers = new Map<string, Record<string, LinearParentHeader>>();
		return items.map((item) => {
			const parentId = item.metadata?.parentId;
			if (typeof parentId !== "string") return item;
			const projectId = projectOf(item);
			let project = headers.get(projectId);
			if (!project) {
				const id = `${projectId}:linear`,
					checkpoint = this.items.checkpoint(id);
				project = checkpoint?.configKey === this.currentKey(id) ? linearParentHeaders(checkpoint?.cursor) : {};
				headers.set(projectId, project);
			}
			const header = project[parentId];
			return header ? { ...item, linearParent: header } : item;
		});
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
			const item = this.withParents([await this.items.require(itemId)], (item) => item.projectId)[0]!;
			controller.signal.throwIfAborted();
			const id = `${item.projectId}:linear`,
				key = this.currentKey(id);
			if (item.kind !== "linear" || !key || this.items.checkpoint(id)?.configKey !== key)
				throw new Conflict("Sync this project's Linear source first");
			if ((this.health.get(id)?.nextPollAt ?? 0) > Date.now() && this.health.get(id)?.status !== "ok")
				throw new Conflict("Linear is unavailable right now. Try again shortly.");
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
		const checkpoint = this.items.checkpoint(id);
		// A message added by hand can be read before the first sync; it is listed then too.
		if (!key || (checkpoint ? checkpoint.configKey !== key : item.metadata.manual !== true))
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
	/** Adds one Slack message from a pasted link to a project's triage, from any channel the user's Slack account can
	 * read. The project must track Slack. Repeated requests for the same message share one read; a message already
	 * in triage is returned as it is, with its local status and links. Failures are plain and leave the source's
	 * health alone. */
	addSlackMessage(projectId: string, url: string): Promise<TrackedItem> {
		if (this.stopped) throw new ServiceUnavailable("Tracking is stopped");
		const link = parseSlackMessageLink(url);
		if (!link) throw new Conflict("Paste a link to a Slack message");
		const project = structuredClone(this.projects.require(projectId));
		const id = `${projectId}:slack`,
			key = this.currentKey(id);
		if (!key) throw new Conflict("Add Slack channels to this project's settings first");
		if (this.items.checkpoint(id) && this.items.checkpoint(id)?.configKey !== key)
			throw new Conflict("Sync this project's Slack source first");
		const adder = this.slackAdder;
		if (!adder) throw new ServiceUnavailable("Adding Slack messages is unavailable");
		const runKey = `${projectId}/${link.channel}/${link.threadTs}`;
		const existing = this.adds.get(runKey);
		if (existing) return existing.promise;
		if (this.busy() >= 2) throw new ServiceUnavailable("Tracking is busy, retry shortly");
		const controller = new AbortController();
		// Below the app's one-minute request timeout, so the app shows pilotd's plain reason.
		const timer = setTimeout(() => controller.abort(new Error("Adding the message timed out")), 50_000);
		const work = adder(
			{
				project,
				config: project.tracking!,
				signal: controller.signal,
				call: (tool, args) => this.readCall("slack", tool, args, controller.signal),
			},
			link,
		).then(async (input) => {
			controller.signal.throwIfAborted();
			if (this.currentKey(id) !== key) throw new Conflict("Tracking configuration changed");
			await this.items.commit(projectId, "slack", [input]);
			// A message stored earlier from a channel no longer tracked is shown again.
			await this.items.retainSlack(projectId, this.projects.require(projectId).tracking?.slackChannels ?? []);
			return this.items.requireExternal(projectId, "slack", input.externalId);
		});
		const promise = abortable(work, controller.signal)
			.catch((error: unknown) => {
				if (error instanceof Conflict) throw error;
				console.warn(`pilotd: adding a Slack message failed for project ${projectId}: ${logCause(error)}`);
				if (error instanceof SourceSignInRequired)
					throw new ServiceUnavailable("Sign in to Slack to add this message");
				if (error instanceof SourceRateLimited)
					throw new ServiceUnavailable("Slack is limiting requests. Try again in a minute.");
				if (error instanceof SourceToolError || error instanceof SlackFormatChanged)
					throw new Conflict(
						"Couldn't read this message from Slack. Check the link and that you can see it in Slack.",
					);
				throw new ServiceUnavailable("Couldn't add this message. Try again in a moment.");
			})
			.finally(() => {
				clearTimeout(timer);
				this.adds.delete(runKey);
				this.schedule();
			});
		this.adds.set(runKey, { controller, promise });
		return promise;
	}
	/** Binding is local and completes before any remote work. A normal link never writes. */
	async patch(itemId: string, patch: TrackedItemPatch): Promise<TrackedItem> {
		const before = await this.items.require(itemId);
		const item = await this.items.patch(itemId, patch);
		if (item.kind === "slack" && item.slack?.status !== "done") {
			const run = this.doneRuns.get(item.projectId);
			if (run?.itemId() === item.id) run.controller.abort(new Error("Slack item reopened"));
		}
		const newLink =
			(patch.sessionId && !before.sessionIds?.includes(patch.sessionId)) ||
			(patch.missionId && !before.missionIds?.includes(patch.missionId));
		if (patch.start && newLink && item.kind === "linear") void this.startLinear(item).catch(() => {});
		if (patch.start && newLink && item.kind === "slack") void this.startSlack(item).catch(() => {});
		return this.withParents([item], (item) => item.projectId)[0]!;
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
						if (
							JSON.stringify(this.projects.require(item.projectId).tracking?.linearStateMappings) !==
							JSON.stringify(project.tracking?.linearStateMappings)
						)
							throw new Conflict("Linear start states changed");
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
	/** Single durable attempt per Slack item, independent of how many chats or missions it starts. */
	startSlack(item: TrackedItem): Promise<void> {
		if (item.kind !== "slack") return Promise.resolve();
		const existing = this.starts.get(item.id);
		if (existing) return existing.promise;
		if (this.stopped || this.busy() >= 2)
			return this.items.reserveSlackStart(item.id).then(async (reserved) => {
				if (reserved) await this.items.slackStartResult(item.id, "error");
			});
		const sourceId = `${item.projectId}:slack`;
		const key = this.currentKey(sourceId) ?? "";
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("Slack start timed out")), 60_000);
		const work = Promise.resolve().then(async () => {
			if (!(await this.items.reserveSlackStart(item.id))) return;
			// Read the durable parent identity, not a stale caller snapshot.
			const current = await this.items.require(item.id);
			let outcome: "reacted" | "skipped" | "error" = "error";
			let owner: SlackReactionOwner | undefined;
			try {
				controller.signal.throwIfAborted();
				if (!key || this.items.checkpoint(sourceId)?.configKey !== key)
					throw new Conflict("Sync Slack before starting");
				const health = this.health.get(sourceId);
				if (health && health.status !== "ok" && health.nextPollAt > Date.now())
					throw new Conflict("Source is backing off");
				const project = structuredClone(this.projects.require(item.projectId));
				const result = await abortable(
					slackStart(
						{
							project,
							config: project.tracking!,
							signal: controller.signal,
							call: (tool, args) => {
								controller.signal.throwIfAborted();
								if (this.currentKey(sourceId) !== key) throw new Conflict("Tracking configuration changed");
								return this.mcp.call("slack", tool, args, controller.signal);
							},
						},
						current,
					),
					controller.signal,
				);
				outcome = result.outcome;
				owner = result.owner;
			} catch {
				/* The chat is already linked. Never expose provider errors or retry this write. */
			}
			await this.items.slackStartResult(item.id, outcome, owner);
		});
		const promise = work.finally(() => {
			clearTimeout(timer);
			this.starts.delete(item.id);
			this.schedule();
		});
		this.starts.set(item.id, {
			sourceId,
			key,
			controller,
			promise,
			// Slack's poll key deliberately ignores the channel list. Starts must still cancel on removal.
			allowed: () => slackStartAllowed(this.projects.require(item.projectId).tracking?.slackChannels ?? [], item),
		});
		return promise;
	}
	private queueSlackDone(projectId: string): void {
		if (
			this.stopped ||
			!this.knownProjects.has(projectId) ||
			!this.projects.require(projectId).tracking?.slackChannels.length
		)
			return;
		this.doneDue.add(projectId);
		if (this.doneScheduled) return;
		this.doneScheduled = true;
		queueMicrotask(() => {
			this.doneScheduled = false;
			this.pumpSlackDone();
		});
	}
	private pumpSlackDone(): void {
		if (this.stopped) return;
		for (const projectId of this.doneDue) {
			if (this.busy() >= 2) break;
			if (this.doneRuns.has(projectId)) continue;
			this.doneDue.delete(projectId);
			if (!this.knownProjects.has(projectId)) continue;
			const sourceId = `${projectId}:slack`,
				key = this.currentKey(sourceId);
			if (!key) continue;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new Error("Slack done reaction timed out")), 60_000);
			let admitted: TrackedItem | undefined;
			const work = Promise.resolve()
				.then(async () => {
					admitted = await this.items.reserveSlackDone(projectId);
					if (!admitted) return;
					let outcome: "reacted" | "skipped" | "error" = "error";
					let context: SourcePollContext | undefined;
					let current: TrackedItem | undefined;
					try {
						controller.signal.throwIfAborted();
						current = await this.items.require(admitted.id);
						if (this.currentKey(sourceId) !== key || this.items.checkpoint(sourceId)?.configKey !== key)
							throw new Conflict("Sync Slack first");
						const health = this.health.get(sourceId);
						if (health && !health.localBudget && health.status !== "ok" && health.nextPollAt > Date.now())
							throw new Conflict("Source is backing off");
						const project = structuredClone(this.projects.require(projectId));
						context = {
							project,
							config: project.tracking!,
							signal: controller.signal,
							call: (tool, args) => {
								controller.signal.throwIfAborted();
								if (
									this.currentKey(sourceId) !== key ||
									!slackStartAllowed(this.projects.require(projectId).tracking?.slackChannels ?? [], current!)
								)
									throw new Conflict("Tracking configuration changed");
								return this.mcp.call("slack", tool, args, controller.signal);
							},
						};
						outcome = await abortable(addSlackDone(context, current), controller.signal);
					} catch {
						/* Done is local and never rolled back by a reaction failure. */
					}
					await this.items.slackDoneResult(admitted.id, outcome);
					let removal: "removed" | "absent" | "skipped" | "error" = "error";
					let reason: SlackRemovalFailure | undefined;
					try {
						controller.signal.throwIfAborted();
						if (context && current)
							removal = await abortable(removeSlackEyes(context, current), controller.signal);
					} catch (error) {
						reason = error instanceof SlackRemovalError ? error.reason : "error";
					}
					await this.items.slackEyesRemovalResult(admitted.id, removal, reason);
				})
				.catch((error: unknown) => console.warn(`pilotd: Slack done reaction failed: ${logCause(error)}`))
				.finally(() => {
					clearTimeout(timer);
					this.doneRuns.delete(projectId);
					if (admitted) this.queueSlackDone(projectId);
					this.schedule();
				});
			this.doneRuns.set(projectId, {
				sourceId,
				key,
				controller,
				promise: work,
				itemId: () => admitted?.id,
				allowed: () =>
					this.knownProjects.has(projectId) &&
					(!admitted ||
						slackStartAllowed(this.projects.require(projectId).tracking?.slackChannels ?? [], admitted)),
			});
		}
	}
	private readCall(
		kind: TrackedKind,
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<TrackingJson> {
		if (tool === "startIssue" || tool === "startSlack" || tool === "doneSlack" || tool === "removeSlackEyes")
			return Promise.reject(new Error("Source reads cannot write"));
		return this.mcp.call(kind, tool, args, signal);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.doneDue.clear();
		clearTimeout(this.timer);
		for (const dispose of this.disposers) dispose();
		const signIns = this.signIns.stop();
		for (const run of this.running.values()) run.controller.abort(new Error("Tracking stopped"));
		for (const run of this.details.values()) run.controller.abort(new Error("Tracking stopped"));
		for (const run of this.starts.values()) run.controller.abort(new Error("Tracking stopped"));
		for (const run of this.doneRuns.values()) run.controller.abort(new Error("Tracking stopped"));
		for (const run of this.lookups.values()) run.controller.abort(new Error("Tracking stopped"));
		for (const run of this.adds.values()) run.controller.abort(new Error("Tracking stopped"));
		const excerpt = this.excerptRun;
		excerpt?.controller.abort(new Error("Tracking stopped"));
		await Promise.allSettled([...this.running.values()].map((run) => run.promise));
		await Promise.allSettled([...this.details.values()].map((run) => run.promise));
		await Promise.allSettled([...this.lookups.values()].map((run) => run.promise));
		await Promise.allSettled([...this.starts.values()].map((run) => run.promise));
		await Promise.allSettled([...this.doneRuns.values()].map((run) => run.promise));
		await Promise.allSettled([...this.adds.values()].map((run) => run.promise));
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
			const key = this.currentKey(source.id);
			if (key) this.refreshDiagnostics.requestDue(source.id, key);
		}
		this.schedule();
	}
	/** Linear teams for the project settings picker. Read-only, never stored. */
	linearTeams(query?: string): Promise<TrackingLookup<LinearTeamOption>> {
		return this.lookup("linear", (call) => lookupLinearTeams(call, query));
	}
	linearStates(team: string): Promise<TrackingLookup<LinearWorkflowStateOption>> {
		return this.lookup("linear", async (call) => ({
			items: workflowStates(await call("states", { team })),
			more: false,
		}));
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
		return (
			this.running.size +
			this.details.size +
			this.lookups.size +
			this.starts.size +
			this.doneRuns.size +
			this.adds.size +
			(this.excerptRun ? 1 : 0)
		);
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
						? SOURCE_REFRESH_CADENCE_MS
						: Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 6)),
				),
			status: error instanceof SourceSignInRequired ? "sign_in_required" : "error",
			...(error instanceof SourceRateLimited ? { limited: true } : {}),
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
			...(health?.key === key && health.localBudget ? { budgetLimited: true } : {}),
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

/** Admission changes cancel in-flight discovery without invalidating existing rows/checkpoints. */
function slackPollScope(project: Project): string {
	return JSON.stringify([
		project.tracking?.slackChannels ?? [],
		project.tracking?.slackMentionOnlyChannels ?? [],
		project.tracking?.slackGroupHandles ?? [],
	]);
}

/** Project labels whose Slack messages stay out of the Inbox. */
function hiddenLabels(project: Project): string[] {
	return (project.tracking?.slackLabels ?? []).filter((label) => label.effect === "hide").map((label) => label.name);
}
/** Project labels that close their Slack messages. */
function closeLabels(project: Project): string[] {
	return (project.tracking?.slackLabels ?? []).filter((label) => label.effect === "close").map((label) => label.name);
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
