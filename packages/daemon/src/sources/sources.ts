/** The source scheduler: shared slots, single-flight polls, timeouts, health and backoff, and the poll timer.
 * Slack and Linear features live in their adapters (slack-tracking.ts, linear-tracking.ts). */
import type {
	DashboardTrackedItem,
	DashboardTrackedSource,
	Inbox,
	OperationHost,
	Project,
	ProjectTrackingConfig,
	RefreshObservation,
	RefreshReason,
	SlackChannelStatus,
	SourceSignIn,
	TodayIntake,
	TrackedItem,
	TrackedItemPatch,
	TrackedKind,
	TrackingJson,
	TrackingLookup,
	TrackingSource,
} from "@pilot/protocol";
import {
	type BackgroundJob,
	BackgroundJobDiagnostics,
	jobConfigurationKey,
	jobFailureReason,
} from "../runtime/diagnostics/background-job-diagnostics.ts";
import { Conflict, NotFound, ServiceUnavailable } from "../runtime/contracts/errors.ts";
import { LinearTracking, type LinearTrackingOptions } from "./linear/linear-tracking.ts";
import type { ProjectStore } from "../projects/projects.ts";
import { type RefreshEvidenceInput, RefreshEvidenceStore } from "./refresh/refresh-evidence.ts";
import { RuntimeBackground } from "../runtime/lifecycle/runtime-background.ts";
import { SlackModelUnavailable } from "./slack/slack-classifier.ts";
import { SlackFormatChanged } from "./slack/slack-format.ts";
import { slackChannelProgress } from "./slack/slack-source.ts";
import { hiddenLabels, SlackTracking, type SlackTrackingOptions } from "./slack/slack-tracking.ts";
import { configKey, isConfigured, parseSourceId, SOURCE_KINDS, sourceId, sourceLabel } from "./source-kinds.ts";
import { SOURCE_SLOTS, type SourceMcpClient } from "./auth/source-mcp.ts";
import {
	abortable,
	logCause,
	SOURCE_REFRESH_CADENCE_MS,
	SOURCE_REFRESH_TIMEOUT_MS,
	type SourceHealth,
	type SourcePoller,
	type SourceScheduler,
	type SourceSlot,
	TRACKING_BUSY,
	TRACKING_STOPPED,
} from "./refresh/source-poll.ts";
import { SourceRefreshDiagnostics } from "./refresh/source-refresh-diagnostics.ts";
import { type JobHealth, refreshHealth } from "./refresh/source-refresh-health.ts";
import { SourceSignIns } from "./auth/source-sign-in.ts";
import { SOURCE_WRITE_TOOLS, SourceRateLimited, SourceSignInRequired } from "./source-tool-rules.ts";
import type { SourceCheckpoint, TrackedItemStore, TrackedQuery } from "./tracking/tracked-items.ts";
import type { TriageGroomer } from "./triage/triage-grooming.ts";

type TrackingChange = { type: "sources" | "items"; projectId: string };

export interface SourceRegistryOptions {
	pollers?: Partial<Record<TrackedKind, SourcePoller>>;
	slack?: SlackTrackingOptions;
	linear?: LinearTrackingOptions;
	/** Shared with other background work, such as triage and linked Linear sync. */
	jobDiagnostics?: BackgroundJobDiagnostics;
	triage?: TriageGroomer;
	/** No polls or label effects until start(). */
	deferStart?: boolean;
	signInTimeoutMs?: number;
}

/** Limited manual and background polling. Only explicitly registered sources do work. */
export class SourceRegistry {
	readonly runtime = new RuntimeBackground(
		"tracking",
		() => {
			if (this.started) {
				this.syncLabelEffects();
				this.schedule();
			}
		},
		() => clearTimeout(this.timer),
		() => (this.slots.size ? [{ kind: "background", id: "tracking:active" }] : []),
	);
	private started = false;
	readonly refreshDiagnostics = new SourceRefreshDiagnostics();
	readonly jobDiagnostics: BackgroundJobDiagnostics;
	private evidence?: RefreshEvidenceStore;
	readonly triage?: TriageGroomer;
	readonly slack: SlackTracking;
	readonly linear: LinearTracking;
	private readonly pollers = new Map<TrackedKind, SourcePoller>();
	/** Every piece of MCP work in flight, by name. Polls are "poll:<source id>". */
	private readonly slots = new Map<string, SourceSlot & { key?: string }>();
	private readonly health = new Map<string, SourceHealth>();
	private readonly listeners = new Set<(change: TrackingChange) => void>();
	private readonly disposers: Array<() => void>;
	private knownProjects: Set<string>;
	private stopped = false;
	private readonly automatic = new Set<TrackedKind>();
	/** Sources to poll at the next timer tick, for example after a sign-in. */
	private readonly due = new Set<string>();
	private timer?: ReturnType<typeof setTimeout>;
	private readonly projects: Pick<ProjectStore, "list" | "require" | "onChange">;
	readonly items: TrackedItemStore;
	private readonly mcp: SourceMcpClient;
	private readonly signIns: SourceSignIns;
	constructor(
		projects: Pick<ProjectStore, "list" | "require" | "onChange">,
		items: TrackedItemStore,
		mcp: SourceMcpClient,
		options: SourceRegistryOptions = {},
	) {
		this.started = !options.deferStart;
		this.projects = projects;
		this.items = items;
		this.mcp = mcp;
		this.jobDiagnostics = options.jobDiagnostics ?? new BackgroundJobDiagnostics();
		this.triage = options.triage;
		for (const kind of SOURCE_KINDS) this.jobDiagnostics.register("manual_lookup", kind);
		const scheduler = this.scheduler();
		this.slack = new SlackTracking(scheduler, options.slack);
		this.linear = new LinearTracking(scheduler, options.linear);
		for (const kind of SOURCE_KINDS) {
			const poller = options.pollers?.[kind];
			if (poller) this.register(kind, poller);
		}
		this.signIns = new SourceSignIns(
			(kind, options) => mcp.signIn!(kind, options),
			(state) => {
				for (const project of projects.list()) this.emit({ type: "sources", projectId: project.id });
				if (state.state === "done") this.resync(state.kind);
			},
			options.signInTimeoutMs,
		);
		this.knownProjects = new Set(projects.list().map((project) => project.id));
		this.syncLabelEffects();
		this.disposers = [
			items.onChange((projectId) => {
				this.emit({ type: "items", projectId });
			}),
			projects.onChange(() => {
				const current = new Set(projects.list().map((project) => project.id));
				for (const id of this.knownProjects) if (!current.has(id)) items.unload(id);
				this.knownProjects = current;
				this.slack.projectsChanged(current);
				this.syncLabelEffects();
				this.slack.retainChannels();
				for (const slot of this.slots.values()) {
					if (!slot.sourceId) continue;
					let allowed: boolean;
					try {
						allowed = slot.allowed?.() !== false;
					} catch {
						allowed = false;
					}
					if (this.currentKey(slot.sourceId) !== slot.key || !allowed)
						slot.controller.abort(new Conflict("Tracking configuration changed"));
				}
				for (const id of this.health.keys())
					if (this.currentKey(id) !== this.health.get(id)?.key) this.health.delete(id);
				this.refreshDiagnostics.prune((id) => this.diagnosticKey(id));
				this.jobDiagnostics.prune((projectId) => this.jobConfigKey(projectId));
				for (const project of projects.list()) this.emit({ type: "sources", projectId: project.id });
				this.schedule();
			}),
		];
	}
	/** The narrow access the Slack and Linear adapters get. */
	private scheduler(): SourceScheduler {
		return {
			items: this.items,
			projects: this.projects,
			jobDiagnostics: this.jobDiagnostics,
			open: () => !this.stopped && !this.runtime.frozen,
			free: () => this.slots.size < SOURCE_SLOTS,
			slot: (name) => this.slots.get(name),
			admit: (name, timeout, work, guard) => this.admit(name, timeout, work, guard),
			currentKey: (id) => this.currentKey(id),
			health: (id) => this.health.get(id),
			failed: (id, key, error) => this.failed(id, key, error),
			read: (kind, tool, args, signal) => this.readCall(kind, tool, args, signal),
			write: (kind, tool, args, signal) => this.mcp.call(kind, tool, args, signal),
			sourcesChanged: (projectId) => this.emit({ type: "sources", projectId }),
			lookup: (kind, work) => this.lookup(kind, work),
			jobConfigKey: (projectId) => this.jobConfigKey(projectId),
		};
	}
	private admit<T>(
		name: string,
		timeout: { ms: number; message: string },
		work: (signal: AbortSignal, slot: SourceSlot) => Promise<T>,
		guard: Pick<SourceSlot, "sourceId" | "key" | "allowed"> = {},
	): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(timeout.message)), timeout.ms);
		const slot: SourceSlot = { controller, startedAt: Date.now(), promise: Promise.resolve(), ...guard };
		this.slots.set(name, slot);
		const promise = Promise.resolve()
			.then(() => work(controller.signal, slot))
			.finally(() => {
				clearTimeout(timer);
				if (this.slots.get(name) === slot) this.slots.delete(name);
				this.schedule();
			});
		slot.promise = promise;
		return promise;
	}
	async retainDiagnosticEvidence(directory: string, host: OperationHost): Promise<void> {
		this.evidence = new RefreshEvidenceStore({
			directory,
			host,
			enabled: this.refreshDiagnostics.coverage().enabled,
		});
		const schedule = () => this.evidence?.schedule(() => this.evidenceSnapshot());
		this.refreshDiagnostics.onChange = schedule;
		this.jobDiagnostics.onChange = schedule;
		await this.evidence.load();
		schedule();
	}
	private evidenceSnapshot(): RefreshEvidenceInput[] {
		if (!this.evidence) return [];
		const sources = this.refreshDiagnostics
			.snapshots()
			.filter((row) => this.diagnosticKey(row.id) === row.key)
			.map((row) => ({
				ref: this.evidence!.ref("source", row.id, row.key),
				type: "source" as const,
				value: row.value as unknown as Record<string, unknown>,
			}));
		const jobs = this.jobDiagnostics
			.snapshots()
			.filter((row) => row.key === (row.value.projectId ? this.jobConfigKey(row.value.projectId) : "host"))
			.map((row) => {
				const { projectId, ...value } = row.value;
				return {
					ref: this.evidence!.ref("job", JSON.stringify([value.job, value.kind, projectId ?? null]), row.key),
					type: "job" as const,
					value: value as unknown as Record<string, unknown>,
				};
			});
		return [...sources, ...jobs].sort(
			(a, b) =>
				Number(b.value.completedAt ?? b.value.lastAttemptAt ?? b.value.startedAt ?? b.value.queuedAt ?? 0) -
				Number(a.value.completedAt ?? a.value.lastAttemptAt ?? a.value.startedAt ?? a.value.queuedAt ?? 0),
		);
	}
	private readJobHealth(job: BackgroundJob, kind: TrackedKind, projectId: string | undefined, key: string): JobHealth {
		const evidenceKey = projectId ? this.jobConfigKey(projectId) : "host";
		return {
			...this.jobDiagnostics.read(job, kind, projectId, key),
			historical: evidenceKey
				? this.evidence?.read(this.evidence.ref("job", JSON.stringify([job, kind, projectId ?? null]), evidenceKey))
				: undefined,
		};
	}
	async flushDiagnosticEvidence(): Promise<void> {
		await this.evidence?.flush();
		if (this.evidence && !this.evidence.coverage().enabled && this.evidence.coverage().error)
			throw new ServiceUnavailable(
				"Local refresh evidence could not be cleared. Check private storage permissions.",
			);
	}
	async closeDiagnosticEvidence(): Promise<void> {
		await this.evidence?.close();
	}
	jobConfigKey(projectId: string): string | undefined {
		try {
			const project = this.projects.require(projectId);
			return jobConfigurationKey(project.tracking, project.trackingGeneration);
		} catch {
			return undefined;
		}
	}
	private diagnosticKey(id: string): string | undefined {
		const key = this.currentKey(id);
		return key ? `${key}:${this.jobConfigKey(id.slice(0, id.lastIndexOf(":")))}` : undefined;
	}
	setDiagnosticsEnabled(value: boolean): void {
		this.refreshDiagnostics.setEnabled(value);
		this.jobDiagnostics.setEnabled(value);
		this.evidence?.setEnabled(value);
	}
	async clearDiagnosticEvidence(): Promise<void> {
		this.refreshDiagnostics.clear();
		this.jobDiagnostics.clear();
		await this.evidence?.clear();
	}
	register(kind: TrackedKind, poller: SourcePoller): void {
		if (this.pollers.has(kind)) throw new Error(`Source ${kind} is already registered`);
		this.pollers.set(kind, poller);
	}
	private syncLabelEffects(): void {
		if (!this.started || this.runtime.frozen || this.stopped) return;
		this.slack.syncLabelEffects(this.runtime);
	}
	/** Five-minute cadence, no app polling, timer released when nothing is configured. */
	startPolling(kind: TrackedKind): void {
		this.start();
		if (!this.pollers.has(kind)) throw new Error("Register the source before scheduling it");
		this.automatic.add(kind);
		this.schedule();
	}
	start(): void {
		if (this.stopped || this.started) return;
		this.started = true;
		this.syncLabelEffects();
	}
	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.stopped || !this.started || this.runtime.frozen) return;
		const sources = this.list().filter(
			(source) => source.configured && this.automatic.has(source.kind) && !this.polling(source.id),
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
						!this.polling(source.id) &&
						dueAt(source) <= Date.now(),
				);
				if (source && this.slots.size < SOURCE_SLOTS)
					void this.poll(source.id)
						.catch(() => {})
						.finally(() => this.schedule());
				else this.schedule();
			},
			Math.max(1000, next - Date.now()),
		);
		this.timer.unref();
	}
	private polling(id: string): SourceSlot | undefined {
		return this.slots.get(`poll:${id}`);
	}
	onChange(listener: (change: TrackingChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	list(projectId?: string): TrackingSource[] {
		const projects = projectId ? [this.projects.require(projectId)] : this.projects.list();
		return projects.flatMap((project) => SOURCE_KINDS.map((kind) => this.describe(project, kind)));
	}
	require(id: string): TrackingSource {
		const parsed = parseSourceId(id);
		if (!parsed) throw new NotFound(`Unknown source: ${id}`);
		return this.describe(this.projects.require(parsed.projectId), parsed.kind);
	}
	refreshHealth(options: Parameters<typeof refreshHealth>[1] = {}) {
		return refreshHealth(
			{
				projects: this.projects,
				items: this.items,
				refreshDiagnostics: this.refreshDiagnostics,
				jobDiagnostics: this.jobDiagnostics,
				evidence: this.evidence,
				adapterInstalled: (kind) => this.pollers.has(kind),
				automatic: (kind) => this.automatic.has(kind),
				waitingInstalled: !!this.slack.waiting,
				stopped: this.stopped,
				timerInstalled: this.timer !== undefined,
				busySlots: this.slots.size,
				running: (id) => {
					const slot = this.polling(id);
					return slot && { key: slot.key, startedAt: slot.startedAt, aborted: slot.controller.signal.aborted };
				},
				health: (id) => this.health.get(id),
				due: (id) => this.due.has(id),
				diagnosticKey: (id) => this.diagnosticKey(id),
				jobConfigKey: (projectId) => this.jobConfigKey(projectId),
				readJobHealth: (job, kind, projectId, key) => this.readJobHealth(job, kind, projectId, key),
			},
			options,
		);
	}
	/** Single flight per source, sharing the slots with all other MCP work. No unlimited backlog from repeated clicks. */
	poll(id: string): Promise<TrackingSource> {
		if (this.stopped || this.runtime.frozen) throw new ServiceUnavailable(TRACKING_STOPPED);
		const source = this.require(id);
		if (!source.configured) throw new Conflict("Attach a Linear team or Slack channels in project settings first");
		const key = this.currentKey(id)!;
		// Manual sync retries failures, but never bypasses provider Retry-After.
		const health = this.health.get(id);
		if (health?.limited && health.nextPollAt > Date.now())
			throw new Conflict(`${sourceLabel(source.kind)} is limiting requests. Pilot will retry automatically.`);
		const running = this.polling(id);
		if (running) {
			if (running.key !== key) throw new Conflict("Previous poll is cancelling, retry shortly");
			return running.promise as Promise<TrackingSource>;
		}
		const poller = this.pollers.get(source.kind);
		if (!poller) throw new ServiceUnavailable("Source adapter is not installed");
		if (this.slots.size >= SOURCE_SLOTS) throw new ServiceUnavailable(TRACKING_BUSY);
		this.due.delete(id);
		const project = structuredClone(this.projects.require(source.projectId));
		const checkpoint = this.items.checkpoint(id);
		const allowed = source.kind === "slack" ? this.slack.pollAllowed(project) : undefined;
		const diagnosticKey = this.diagnosticKey(id) ?? key;
		this.refreshDiagnostics.begin(id, diagnosticKey);
		let slot: SourceSlot | undefined;
		let discoveryObserved = false;
		const current = (signal: AbortSignal) => !signal.aborted && this.currentKey(id) === key && allowed?.() !== false;
		const observe = (event: RefreshObservation) => {
			if (!slot || this.polling(id) !== slot || !current(slot.controller.signal)) return;
			if (event.stage === "discovery" && event.phase === "completed") discoveryObserved = true;
			this.refreshDiagnostics.observe(id, diagnosticKey, event);
		};
		const name = `poll:${id}`;
		const promise = this.admit(
			name,
			{ ms: SOURCE_REFRESH_TIMEOUT_MS, message: "Poll timed out" },
			(signal) => {
				const context = {
					observe,
					project,
					config: project.tracking!,
					signal,
					call: (tool: string, args: Record<string, unknown>) => this.readCall(source.kind, tool, args, signal),
				};
				return abortable(
					(async () =>
						poller({
							...context,
							...(checkpoint?.configKey === key && checkpoint.cursor !== undefined
								? { cursor: checkpoint.cursor }
								: {}),
						}))(),
					signal,
				)
					.then(async (result) => {
						if (!current(signal)) return;
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
						signal.throwIfAborted();
						observe({ stage: "commit", phase: "completed", outcome: "success", count: result.items.length });
						if (source.kind === "slack") await this.slack.afterCommit(context);
						signal.throwIfAborted();
						this.health.set(id, {
							key,
							failures: 0,
							nextPollAt: Date.now() + SOURCE_REFRESH_CADENCE_MS,
							status: result.issue ? "error" : "ok",
							...(result.issue
								? {
										error:
											result.issue === "slack_channel"
												? "A Slack channel could not be read. Check its access in project settings."
												: "Some Slack threads could not be classified. Failed or interrupted attempts are cached and never retried.",
									}
								: {}),
						});
						this.refreshDiagnostics.end(
							id,
							diagnosticKey,
							signal.aborted ? "cancelled" : result.issue ? "partial" : "success",
							signal.aborted ? (this.stopped ? "stopped" : "config_changed") : undefined,
						);
					})
					.catch((error) => {
						const reason: RefreshReason = signal.aborted
							? this.stopped
								? "stopped"
								: this.currentKey(id) !== key || allowed?.() === false
									? "config_changed"
									: "timeout"
							: error instanceof SourceSignInRequired
								? "sign_in"
								: error instanceof SourceRateLimited
									? "provider_rate_limit"
									: error instanceof SlackModelUnavailable
										? "classifier_unavailable"
										: "read_failed";
						this.refreshDiagnostics.end(id, diagnosticKey, signal.aborted ? "cancelled" : "failure", reason);
						// A Slack channel edit may cancel this run without changing the stored checkpoint key.
						if (reason !== "config_changed") this.failed(id, key, error);
					});
			},
			{ sourceId: id, key, allowed },
		);
		slot = this.slots.get(name)!;
		observe({ stage: "discovery", phase: "started" });
		slot.promise = promise
			.finally(() => this.emit({ type: "sources", projectId: project.id }))
			.then(() => this.require(id));
		this.emit({ type: "sources", projectId: project.id });
		return slot.promise as Promise<TrackingSource>;
	}
	dashboard(projectId: string): DashboardTrackedSource[] {
		return this.list(projectId)
			.filter((source) => source.configured || source.kind === "slack")
			.flatMap((source) => {
				const checkpoint = this.items.checkpoint(source.id);
				const { items, total, done, commonCases } =
					source.kind !== "slack" && checkpoint && checkpoint.configKey !== this.currentKey(source.id)
						? { items: [], total: 0, done: undefined }
						: this.items.preview(projectId, source.kind);
				if (!source.configured && !total && !done?.total) return [];
				return [
					{
						source: source.kind,
						label: source.label,
						status: !source.configured ? ("idle" as const) : source.status,
						...(source.error ? { error: source.error } : {}),
						total,
						items: this.decorate(source.kind, projectId, items),
						...(done ? { done: { ...done, items: this.decorate(source.kind, projectId, done.items) } } : {}),
						...(commonCases ? { commonCases } : {}),
						...(source.linear ? { linear: source.linear } : {}),
					},
				];
			});
	}
	/** Linear rows get their parent headers and managing missions. */
	private decorate(kind: TrackedKind, projectId: string, items: DashboardTrackedItem[]): DashboardTrackedItem[] {
		const withParents = this.linear.withParents(items, () => projectId);
		return kind === "linear" ? this.linear.withManagers(projectId, withParents) : withParents;
	}
	/** Linear needs its current team. Slack imports need no channel configuration. */
	assertIntakeSource(projectId: string, kind: TrackedKind): void {
		if (!this.synced(this.projects.require(projectId), kind)) throw new Conflict("Sync this request source first");
	}
	async intakeSources(projectId: string): Promise<TodayIntake["sources"]> {
		const project = structuredClone(this.projects.require(projectId));
		const rows = await this.items.intake(projectId);
		if (JSON.stringify(this.projects.require(projectId)) !== JSON.stringify(project))
			throw new Conflict("Intake project changed");
		return rows.map((page) => {
			const health = this.require(sourceId(projectId, page.kind));
			const current = this.synced(project, page.kind);
			return {
				...page,
				items: page.kind === "linear" ? this.linear.withManagers(projectId, page.items) : page.items,
				source: page.kind,
				label: sourceLabel(page.kind),
				status: !health.configured ? (page.total ? "idle" : "not_configured") : !current ? "idle" : health.status,
				...(health.error ? { error: health.error } : {}),
				...(!current ? { items: [], total: 0, complete: true } : {}),
			};
		});
	}
	async listItems(query: TrackedQuery): Promise<import("@pilot/protocol").TrackedItemList> {
		// A team setting change must not leak rows from the previously attached team.
		const kinds = (query.kind ? [query.kind] : SOURCE_KINDS).filter((kind) => {
			const id = sourceId(query.projectId, kind),
				checkpoint = this.items.checkpoint(id);
			return (
				kind === "slack" ||
				(this.require(id).configured && (!checkpoint || checkpoint.configKey === this.currentKey(id)))
			);
		});
		const { kind: _kind, ...rest } = query;
		const list = await this.items.list({ ...rest, kinds });
		return { ...list, items: this.linear.withParents(list.items, (item) => item.projectId) };
	}
	/** Saved data only. No polling, source/profile writes or inferred associations. */
	async savedLinear(
		projectId: string,
	): Promise<Omit<import("@pilot/protocol").SavedLinearRead, "version" | "projectId" | "contextDigest">> {
		const project = structuredClone(this.projects.require(projectId));
		const id = sourceId(projectId, "linear");
		const checkpoint = this.items.checkpoint(id);
		const configurationCurrent =
			isConfigured(project, "linear") && checkpoint?.configKey === configKey(project, "linear");
		const page = configurationCurrent
			? await this.items.list({ projectId, kind: "linear", limit: 100 })
			: { items: [], total: 0 };
		if (
			JSON.stringify(this.projects.require(projectId)) !== JSON.stringify(project) ||
			JSON.stringify(this.items.checkpoint(id)) !== JSON.stringify(checkpoint)
		)
			throw new Conflict("Linear source changed; read again");
		const { kind, label, configured, status, lastPolledAt, error, linear } = this.require(id);
		return {
			scope: "saved-own-issues",
			configurationCurrent,
			source: { id, projectId, kind, label, configured, status, lastPolledAt, error, linear },
			items: this.linear.withParents(page.items, () => projectId),
			limit: 100,
			total: page.total,
			complete: page.total === page.items.length,
			more: page.total - page.items.length,
		};
	}
	/** Open tracked items the Inbox lists for a project, from cached counts: no disk read. */
	inboxCount(projectId: string): number {
		const project = this.projects.require(projectId);
		const hidden = new Set(hiddenLabels(project));
		let total = 0;
		for (const kind of SOURCE_KINDS) {
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
				? {
						linear: {
							...result.linear,
							items: this.linear.withParents(result.linear.items, (item) => item.projectId),
						},
					}
				: {}),
			...(tracks("slack") || result.slack.total > 0 ? { slack: result.slack } : {}),
		};
	}
	/** Slack retention hides removed channels but keeps imports. Linear rows require the current team key. */
	private synced(project: Project, kind: TrackedKind): boolean {
		if (kind === "slack") return true;
		if (!isConfigured(project, kind)) return false;
		const checkpoint = this.items.checkpoint(sourceId(project.id, kind));
		return !checkpoint || checkpoint.configKey === configKey(project, kind);
	}
	/** Binding is local and completes before any remote work. A normal link never writes. */
	async patch(itemId: string, patch: TrackedItemPatch, intakeOperationId?: string): Promise<TrackedItem> {
		const before = await this.items.require(itemId);
		const item = await this.items.patch(itemId, patch, intakeOperationId);
		const newLink =
			(patch.sessionId && !before.sessionIds?.includes(patch.sessionId)) ||
			(patch.missionId && !before.missionIds?.includes(patch.missionId));
		if (patch.start && newLink && item.kind === "slack") void this.slack.start(item).catch(() => {});
		return this.linear.withParents([item], (item) => item.projectId)[0]!;
	}
	private readCall(
		kind: TrackedKind,
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<TrackingJson> {
		if (SOURCE_WRITE_TOOLS.has(tool)) return Promise.reject(new Error("Source reads cannot write"));
		if (signal.aborted) return Promise.reject(signal.reason);
		return this.mcp.call(kind, tool, args, signal);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		for (const dispose of this.disposers) dispose();
		const signIns = this.signIns.stop();
		for (const slot of this.slots.values()) slot.controller.abort(new Error("Tracking stopped"));
		await Promise.allSettled([...this.slots.values()].map((slot) => slot.promise));
		await signIns;
		await this.mcp.close?.();
		this.listeners.clear();
	}
	/** Browser sign-in to the kind's dedicated server (pi's MCP OAuth flow). One per server; repeated starts
	 * return the waiting one. Once done, that source resyncs in every project. */
	signIn(kind: TrackedKind, again = false): SourceSignIn {
		if (this.stopped || this.runtime.frozen) throw new ServiceUnavailable(TRACKING_STOPPED);
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
			if (key) this.refreshDiagnostics.requestDue(source.id, this.diagnosticKey(source.id) ?? key);
		}
		this.schedule();
	}
	/** Latest wins per kind, so typing in a search field never queues MCP work. */
	private async lookup<T>(
		kind: TrackedKind,
		work: (call: (tool: string, args: Record<string, unknown>) => Promise<TrackingJson>) => Promise<{
			items: T[];
			more: boolean;
		}>,
	): Promise<TrackingLookup<T>> {
		if (this.stopped || this.runtime.frozen) throw new ServiceUnavailable(TRACKING_STOPPED);
		const name = `lookup:${kind}`;
		const previous = this.slots.get(name);
		if (previous) {
			previous.controller.abort(new Error("Superseded by a newer lookup"));
			await previous.promise.catch(() => {});
			if (this.slots.get(name)) return { status: "error", items: [], error: "Superseded by a newer search." };
		}
		if (this.stopped || this.runtime.frozen) throw new ServiceUnavailable(TRACKING_STOPPED);
		if (this.slots.size >= SOURCE_SLOTS) {
			const token = this.jobDiagnostics.begin("manual_lookup", kind, undefined, "host");
			this.jobDiagnostics.end(token, "skipped", "shared_slot_capacity");
			return { status: "error", items: [], error: "Tracking is syncing. Try again in a moment." };
		}
		const label = sourceLabel(kind);
		const job = this.jobDiagnostics.begin("manual_lookup", kind, undefined, "host");
		return this.admit(name, { ms: 45_000, message: "Lookup timed out" }, (signal) =>
			abortable(
				work(async (tool, args) => {
					this.jobDiagnostics.stage(job, "lookup", false);
					const result = await this.readCall(kind, tool, args, signal);
					this.jobDiagnostics.progress(job);
					return result;
				}),
				signal,
			)
				.then(({ items, more }): TrackingLookup<T> => {
					this.jobDiagnostics.end(
						job,
						more ? "partial" : items.length ? "success" : "no_work",
						more ? "batch_limit" : undefined,
						items.length,
					);
					return { status: "ok", items, ...(more ? { more } : {}) };
				})
				.catch((error): TrackingLookup<T> => {
					this.jobDiagnostics.end(job, signal.aborted ? "cancelled" : "failure", jobFailureReason(error, signal));
					if (error instanceof SourceSignInRequired)
						return {
							status: "sign_in_required",
							items: [],
							error: "Sign in required",
							signInCommand: signInCommand(kind),
						};
					return {
						status: "error",
						items: [],
						error:
							error instanceof SourceRateLimited
								? `${label} is rate limiting requests. Try again in a minute.`
								: signal.aborted
									? "The search was cancelled. Try again."
									: `Couldn't reach ${label}. Try again in a moment.`,
					};
				}),
		);
	}
	private failed(id: string, key: string, error: unknown): void {
		if (this.currentKey(id) !== key || this.stopped) return;
		const parsed = parseSourceId(id);
		if (!parsed) return;
		const failures = (this.health.get(id)?.failures ?? 0) + 1;
		const label = sourceLabel(parsed.kind);
		// The app shows plain text and the retry time. The technical cause goes to the daemon log only.
		console.warn(`pilotd: ${label} sync failed for project ${parsed.projectId}: ${logCause(error)}`);
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
		const id = sourceId(project.id, kind);
		const configured = isConfigured(project, kind);
		const key = configKey(project, kind),
			health = this.health.get(id),
			checkpoint = this.items.checkpoint(id),
			signIn = this.signIns.get(kind);
		const status = !configured
			? "not_configured"
			: this.polling(id)?.key === key
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
			label: sourceLabel(kind),
			configured,
			status,
			...(checkpoint?.configKey === key ? { lastPolledAt: checkpoint.lastPolledAt } : {}),
			...(checkpoint?.configKey === key && checkpoint.linear ? { linear: structuredClone(checkpoint.linear) } : {}),
			...(health?.key === key ? { nextPollAt: health.nextPollAt } : {}),
			...(health?.key === key && health.error ? { error: health.error } : {}),
			...(status === "sign_in_required" ? { signInCommand: signInCommand(kind) } : {}),
			...(kind === "slack" && configured
				? {
						channels: channelStatus(
							project.tracking!,
							status,
							checkpoint?.configKey === key ? checkpoint : undefined,
						),
					}
				: {}),
			...(signIn ? { signIn } : {}),
		};
	}
	private currentKey(id: string): string | undefined {
		const parsed = parseSourceId(id);
		if (!parsed) return undefined;
		let project: Project;
		try {
			project = this.projects.require(parsed.projectId);
		} catch {
			return undefined;
		}
		return isConfigured(project, parsed.kind) || parsed.kind === "slack"
			? configKey(project, parsed.kind)
			: undefined;
	}
	private emit(change: TrackingChange): void {
		for (const listener of this.listeners) listener(change);
	}
}

function signInCommand(kind: TrackedKind): string {
	return `pi mcp login ${kind}`;
}

function channelStatus(
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
