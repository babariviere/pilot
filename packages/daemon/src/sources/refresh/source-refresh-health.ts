/** Refresh health: a pure local projection of the source scheduler for diagnostics. Never schedules, reserves work,
 * polls MCP or writes product state. */
import { createHash } from "node:crypto";
import type { Project, TrackedKind } from "@pilot/protocol";
import type { BackgroundJob, BackgroundJobDiagnostics } from "../../runtime/diagnostics/background-job-diagnostics.ts";
import { redactDiagnosticText } from "../../runtime/diagnostics/diagnostic-redaction.ts";
import type { ProjectStore } from "../../projects/projects.ts";
import type { RefreshEvidenceStore } from "./refresh-evidence.ts";
import { isSlackChannelId } from "../slack/slack-ids.ts";
import { slackChannelProgress } from "../slack/slack-source.ts";
import { configKey, isConfigured, SOURCE_KINDS, sourceId } from "../source-kinds.ts";
import { SOURCE_SLOTS } from "../auth/source-mcp.ts";
import { SOURCE_REFRESH_CADENCE_MS, SOURCE_REFRESH_TIMEOUT_MS, type SourceHealth } from "./source-poll.ts";
import { refreshAssessment, type SourceRefreshDiagnostics } from "./source-refresh-diagnostics.ts";
import type { TrackedItemStore } from "../tracking/tracked-items.ts";

/** What the scheduler shows of itself. */
export interface RefreshHealthView {
	projects: Pick<ProjectStore, "list" | "require">;
	items: Pick<TrackedItemStore, "checkpoint">;
	refreshDiagnostics: SourceRefreshDiagnostics;
	jobDiagnostics: BackgroundJobDiagnostics;
	evidence?: RefreshEvidenceStore;
	adapterInstalled(kind: TrackedKind): boolean;
	automatic(kind: TrackedKind): boolean;
	waitingInstalled: boolean;
	stopped: boolean;
	timerInstalled: boolean;
	busySlots: number;
	running(id: string): { key?: string; startedAt: number; aborted: boolean } | undefined;
	health(id: string): SourceHealth | undefined;
	due(id: string): boolean;
	diagnosticKey(id: string): string | undefined;
	jobConfigKey(projectId: string): string | undefined;
	readJobHealth(job: BackgroundJob, kind: TrackedKind, projectId: string | undefined, key: string): JobHealth;
}

export type JobHealth = ReturnType<BackgroundJobDiagnostics["read"]> & {
	historical: ReturnType<RefreshEvidenceStore["read"]> | undefined;
};

export function refreshHealth(
	view: RefreshHealthView,
	options: { projectId?: string; kind?: TrackedKind; offset?: number; limit?: number; channelOffset?: number } = {},
) {
	const coverage = view.refreshDiagnostics.coverage();
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
	const projects: Project[] = options.projectId ? [view.projects.require(options.projectId)] : view.projects.list();
	const kinds: TrackedKind[] = options.kind ? [options.kind] : [...SOURCE_KINDS];
	const offset = options.offset ?? 0,
		limit = Math.min(5, options.limit ?? 5),
		channelOffset = options.channelOffset ?? 0;
	const total = projects.length * kinds.length;
	const slots = view.busySlots;
	const sources = [];
	for (let position = offset; position < Math.min(total, offset + limit); position++) {
		const project = projects[Math.floor(position / kinds.length)]!,
			kind = kinds[position % kinds.length]!;
		const id = sourceId(project.id, kind),
			key = configKey(project, kind);
		const configured = isConfigured(project, kind),
			adapter = view.adapterInstalled(kind),
			automatic = view.automatic(kind);
		const run = view.running(id);
		const health = view.health(id)?.key === key ? view.health(id) : undefined;
		const checkpoint = view.items.checkpoint(id);
		const currentCheckpoint = checkpoint?.configKey === key ? checkpoint : undefined;
		const live = view.refreshDiagnostics.read(id, view.diagnosticKey(id) ?? "");
		const explicitDueAt = view.refreshDiagnostics.dueAt(id, view.diagnosticKey(id) ?? "");
		const nextDueAt = view.due(id)
			? (explicitDueAt ?? now)
			: (health?.nextPollAt ?? (currentCheckpoint?.lastPolledAt ?? 0) + SOURCE_REFRESH_CADENCE_MS);
		const backoff = health?.limited
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
				...(isSlackChannelId(channel) ? { channelId: channel } : {}),
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
		const jobKey = view.jobConfigKey(project.id) ?? "";
		sources.push({
			id,
			projectId: project.id,
			kind,
			configured,
			adapterAvailable: adapter,
			scheduler: {
				automatic,
				stopped: view.stopped,
				timerInstalled: view.timerInstalled,
				timerScope: "shared_registry",
				cadenceMs: SOURCE_REFRESH_CADENCE_MS,
				sharedSlots: SOURCE_SLOTS,
				busySlots: slots,
				timeoutMs: SOURCE_REFRESH_TIMEOUT_MS,
				...(configured && automatic && !view.stopped ? { nextDueAt } : {}),
			},
			assessment: refreshAssessment(
				{
					configured,
					adapter,
					automatic,
					stopped: view.stopped,
					...(run
						? {
								running: {
									startedAt: run.startedAt,
									cancelling: run.aborted || run.key !== key,
								},
							}
						: {}),
					nextDueAt,
					busySlots: slots,
					live,
					backoff,
					checkpointAt: currentCheckpoint?.lastPolledAt,
					unobservedDueOverride: view.due(id) && explicitDueAt === undefined,
				},
				now,
			),
			live,
			historical: view.evidence?.read(view.evidence.ref("source", id, view.diagnosticKey(id) ?? "")),
			jobs: [
				view.readJobHealth("triage_rebuild", kind, project.id, jobKey),
				...(kind === "linear"
					? [
							view.readJobHealth("linked_linear_sync", kind, project.id, jobKey),
							view.readJobHealth("linear_parent_header", kind, project.id, jobKey),
						]
					: []),
			],
			checkpointCommittedAt: currentCheckpoint?.lastPolledAt,
			checkpointProvenance: "retained_only_not_live_scheduler_or_all_channel_success",
			...(backoff ? { backoff: { reason: backoff, until: health?.nextPollAt } } : {}),
			...(error ? { error: error.length <= 512 ? redactDiagnosticText(error) : "[Error detail withheld]" } : {}),
			stageCoverage: [
				"discovery",
				"classification",
				"commit",
				...(kind === "linear" ? ["parent_headers"] : []),
				...(kind === "slack" ? ["waiting_replies"] : []),
			].map((stage) => {
				const observation = stages.find((s) => s.stage === stage);
				const unavailable = stage === "waiting_replies" && !view.waitingInstalled;
				const incomplete = observation?.lastStartedAt !== undefined && observation.lastCompletedAt === undefined;
				return {
					stage,
					availability: unavailable ? "not_installed" : observation ? "observed_this_process" : "unknown",
					state: unavailable
						? "unavailable"
						: !observation
							? "unknown"
							: incomplete
								? run?.key === key && !run.aborted
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
		jobCoverage: view.jobDiagnostics.coverage(),
		historyCoverage: view.evidence?.coverage() ?? { enabled: false, reason: "not_installed" },
		hostJobs: [
			...kinds.map((kind) => view.readJobHealth("manual_lookup", kind, undefined, "host")),
			...(kinds.includes("linear") ? [view.readJobHealth("linked_linear_sync", "linear", undefined, "host")] : []),
		],
		coverageGaps: [],
		stageCountMeaning: {
			discovery: "returned_items_or_messages",
			classification: "classification_admissions_when_reported_not_provider_calls",
			commit: "committed_items",
			waiting_replies: "reserved_batch_size_not_read_count",
		},
		freshnessRule:
			"Only process-local attempts/completions and successful commits establish observed progress; checkpoints and silence never prove live scheduling or all-channel freshness.",
	};
}
