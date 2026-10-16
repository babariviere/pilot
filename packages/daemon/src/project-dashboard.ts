/** Project dashboard: a bounded aggregate of what sessions, missions and PRs already know. No polling of its own. */
import {
	DASHBOARD_SECTION_LIMIT,
	type DashboardMission,
	type DashboardNeedsYouItem,
	type DashboardPullRequest,
	type DashboardPullRequestReadiness,
	type DashboardPullRequestRef,
	type DashboardRecentItem,
	type DashboardScheduledItem,
	type DashboardSection,
	type DashboardTrackedSource,
	type DashboardWorkingItem,
	type Inbox,
	type InboxNeedsYouItem,
	type InboxReadyToMergeItem,
	type Mission,
	type ProjectDashboard,
	type ProjectDashboardCounts,
	type ProjectMemorySummary,
	type SessionPullRequest,
	type SessionSummary,
} from "@pilot/protocol";
import type { MissionStore, MissionTaskProgress } from "./missions.ts";
import { reasonLine, sessionNeedsYouReason } from "./needs-you-reason.ts";
import type { ProjectStore } from "./projects.ts";
import { readinessReasonLabel } from "./pull-request-readiness.ts";
import type { ReviewStore } from "./reviews.ts";

/** Optional data providers. Until registered, their sections are empty or absent. */
export interface DashboardProviders {
	/** Pending and failed scheduled items of a project. Failed ones are listed under Needs you. */
	scheduled?: (projectId: string) => DashboardScheduledItem[];
	/** One group per configured tracking source of a project. */
	tracked?: (projectId: string) => DashboardTrackedSource[];
	/** Cached count, recent notes and background compaction health. No disk I/O while building a dashboard. */
	memory?: (projectId: string) => ProjectMemorySummary;
	/** Open tracked items the Inbox lists for a project, from cached counts. Added to the sidebar counts. */
	inbox?: (projectId: string) => number;
	/** Subscribe to provider changes so the dashboard updates without polling. */
	onChange?: (listener: () => void) => () => void;
}

export interface DashboardInput {
	projectId: string;
	/** The project's active (not archived) chats. */
	sessions: SessionSummary[];
	/** The project's missions, any status. */
	missions: Mission[];
	/** Task counts per mission. */
	progress: Map<string, MissionTaskProgress>;
	isUnread: (sessionId: string, outcomeAt: number) => boolean;
	scheduled?: DashboardScheduledItem[];
	tracked?: DashboardTrackedSource[];
	memory?: ProjectMemorySummary;
}

const KIND_RANK = { failed: 0, question: 1, scheduled_failed: 2, long_job: 3, mcp: 4, pr_stuck: 5, unread: 6 } as const;
const isTerminal = (pr: SessionPullRequest) => pr.state === "merged" || pr.state === "closed";
const isWorking = (session: SessionSummary) =>
	session.working ?? (session.state === "working" || session.state === "starting" || !!session.runningJobs?.length);

/** Mirrors the app: a chat whose PRs have all settled, with nothing left unpublished, no longer asks for review. */
function hasTerminalPullRequest(session: SessionSummary): boolean {
	if (session.activeMissionCoordinator || session.unpublishedWork || !session.pullRequest) return false;
	return isTerminal(session.pullRequest) && (session.pullRequests ?? []).every(isTerminal);
}

function section<T>(items: T[], limit = DASHBOARD_SECTION_LIMIT): DashboardSection<T> {
	return { total: items.length, items: items.slice(0, limit) };
}

function ref(pr: SessionPullRequest | undefined): DashboardPullRequestRef | undefined {
	return pr ? { number: pr.number, url: pr.url, state: pr.state } : undefined;
}

function readinessOf(pr: SessionPullRequest): DashboardPullRequestReadiness | undefined {
	return pr.readiness
		? { state: pr.readiness.state, reasons: pr.readiness.reasons.map(readinessReasonLabel) }
		: undefined;
}

/**
 * A finished chat that has not been reviewed, a failure or one waiting for an answer: it still waits on the user.
 * Reading a result is enough to clear it (the app keeps the open chat's row in place until the user leaves it);
 * a ready current PR supersedes an unreviewed result. Failures stay until retried and questions until answered.
 */
function needsReview(session: SessionSummary, isUnread: DashboardInput["isUnread"]): boolean {
	// Live attention holds while the chat works: a long job, or an MCP server the chat could not use.
	if (session.attentionReason?.kind === "long_job" || session.attentionReason?.kind === "mcp") return true;
	if (isWorking(session)) return false;
	// A scheduled follow-up message is the user's answer: the chat now waits on that schedule.
	if (session.scheduledMessage) return false;
	if (session.attentionReason?.kind === "pr_stuck") return true;
	// A question waits until it is answered, not until the chat is viewed.
	if (session.outcome === "question") return true;
	if (hasTerminalPullRequest(session)) return false;
	// A failure waits until it is retried, not until the chat is viewed.
	if (failed(session)) return true;
	// Mirror SessionSummary.isReadyToMerge: coordinators never represent their PR as ready chat work.
	if (
		!(session.missionCoordinator ?? session.activeMissionCoordinator) &&
		session.pullRequest?.state === "open" &&
		session.pullRequest.readiness?.state === "ready"
	)
		return false;
	if (session.outcomeAt !== undefined && Number.isFinite(session.outcomeAt))
		return session.outcome !== undefined && isUnread(session.id, session.outcomeAt);
	return false;
}

const failed = (session: SessionSummary) =>
	session.outcome === "failed" || (!session.outcome && session.state === "failed");

export function buildProjectDashboard(input: DashboardInput, limit = DASHBOARD_SECTION_LIMIT): ProjectDashboard {
	const { projectId, sessions, isUnread } = input;
	const missionTitles = new Map(input.missions.map((mission) => [mission.id, mission.title]));
	const scheduled = input.scheduled ?? [];

	const needsYou: DashboardNeedsYouItem[] = [];
	const needsYouByMission = new Map<string, number>();
	const reviewing = new Set<string>();
	for (const session of sessions) {
		if (!needsReview(session, isUnread)) continue;
		reviewing.add(session.id);
		if (session.missionId)
			needsYouByMission.set(session.missionId, (needsYouByMission.get(session.missionId) ?? 0) + 1);
		const attentionReason = sessionNeedsYouReason(session);
		const attention =
			attentionReason.kind === "long_job" || attentionReason.kind === "pr_stuck" || attentionReason.kind === "mcp"
				? attentionReason.kind
				: undefined;
		const isFailure = !attention && failed(session);
		const reason = reasonLine(
			attention ? attentionReason.detail : (session.outcomeReason ?? (isFailure ? session.error : undefined)),
		);
		needsYou.push({
			kind: attention ?? (isFailure ? "failed" : session.outcome === "question" ? "question" : "unread"),
			id: `session:${session.id}`,
			title: session.title,
			sessionId: session.id,
			...(session.missionId ? { missionId: session.missionId } : {}),
			...(!attention ? { outcome: session.outcome ?? "failed" } : {}),
			...(reason ? { reason } : {}),
			attentionReason,
			at: (attention ? session.attentionAt : session.outcomeAt) ?? session.updatedAt,
		});
	}

	const activeMissions = input.missions.filter((mission) => mission.status === "active");
	for (const mission of activeMissions) {
		if (mission.needsYouCount <= 0) continue;
		needsYou.push({
			kind: "question",
			id: `mission:${mission.id}`,
			title: mission.title,
			missionId: mission.id,
			count: mission.needsYouCount,
			attentionReason: {
				kind: "mission",
				detail: reasonLine(mission.needsYouReason) ?? "A question or blocked task is waiting on you",
			},
			at: mission.updatedAt,
		});
	}
	for (const item of scheduled)
		if (item.state === "failed")
			needsYou.push({
				kind: "scheduled_failed",
				id: `scheduled:${item.id}`,
				title: item.title,
				scheduledId: item.id,
				...(item.sessionId ? { sessionId: item.sessionId } : {}),
				...(reasonLine(item.error) ? { reason: reasonLine(item.error) } : {}),
				attentionReason: {
					kind: "couldnt_start",
					detail: reasonLine(item.error) ?? "The scheduled chat could not start",
				},
				at: item.at ?? 0,
			});
	needsYou.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.at - a.at || a.id.localeCompare(b.id));

	const working: DashboardWorkingItem[] = sessions
		.filter((session) => isWorking(session) && !reviewing.has(session.id))
		.map((session) => ({
			sessionId: session.id,
			title: session.title,
			state: session.state === "starting" ? ("starting" as const) : ("working" as const),
			mode: session.mode ?? "build",
			...(session.missionId ? { missionId: session.missionId } : {}),
			...(session.missionId && missionTitles.has(session.missionId)
				? { missionTitle: missionTitles.get(session.missionId)! }
				: {}),
			...(session.model ? { model: session.model } : {}),
			...(session.branch ? { branch: session.branch } : {}),
			...(session.pullRequest ? { pullRequest: ref(session.pullRequest)! } : {}),
			startedAt: session.lastUserMessageAt ?? session.createdAt,
		}))
		.sort((a, b) => b.startedAt - a.startedAt || a.sessionId.localeCompare(b.sessionId));

	const byUrl = new Map<string, DashboardPullRequest>();
	for (const session of sessions) {
		for (const pr of [session.pullRequest, ...(session.pullRequests ?? [])]) {
			if (!pr || (pr.state !== "open" && pr.state !== "draft")) continue;
			const existing = byUrl.get(pr.url);
			if (existing && existing.checkedAt >= pr.checkedAt) continue;
			const readiness = readinessOf(pr);
			byUrl.set(pr.url, {
				number: pr.number,
				url: pr.url,
				title: pr.title,
				state: pr.state,
				...(pr.branch ? { branch: pr.branch } : {}),
				sessionId: session.id,
				sessionTitle: session.title,
				...(session.missionId ? { missionId: session.missionId } : {}),
				checkedAt: pr.checkedAt,
				...(readiness ? { readiness } : {}),
			});
		}
	}
	const isReady = (pr: DashboardPullRequest) => pr.state === "open" && pr.readiness?.state === "ready";
	const pullRequests = [...byUrl.values()].sort(
		(a, b) => Number(isReady(b)) - Number(isReady(a)) || b.checkedAt - a.checkedAt || b.number - a.number,
	);

	const workingByMission = new Map<string, number>();
	for (const session of sessions)
		if (isWorking(session) && session.missionId)
			workingByMission.set(session.missionId, (workingByMission.get(session.missionId) ?? 0) + 1);
	const missions: Array<DashboardMission & { updatedAt: number }> = activeMissions.map((mission) => {
		const tasks = input.progress.get(mission.id);
		return {
			id: mission.id,
			title: mission.title,
			tasksDone: tasks?.done ?? 0,
			tasksInReview: tasks?.inReview ?? 0,
			tasksInProgress: tasks?.inProgress ?? 0,
			tasksBlocked: tasks?.blocked ?? 0,
			tasksTotal: tasks?.total ?? 0,
			working: workingByMission.get(mission.id) ?? 0,
			needsYou: (mission.needsYouCount > 0 ? mission.needsYouCount : 0) + (needsYouByMission.get(mission.id) ?? 0),
			...(mission.coordinatorSessionId ? { coordinatorSessionId: mission.coordinatorSessionId } : {}),
			updatedAt: mission.updatedAt,
		};
	});
	missions.sort((a, b) => b.needsYou - a.needsYou || b.working - a.working || b.updatedAt - a.updatedAt);

	const recent: DashboardRecentItem[] = sessions
		.filter(
			(session) =>
				!isWorking(session) && !reviewing.has(session.id) && session.outcome && session.outcomeAt !== undefined,
		)
		.map((session) => ({
			sessionId: session.id,
			title: session.title,
			outcome: session.outcome!,
			outcomeAt: session.outcomeAt!,
			...(session.missionId ? { missionId: session.missionId } : {}),
			...(session.branch ? { branch: session.branch } : {}),
			...(session.pullRequest ? { pullRequest: ref(session.pullRequest)! } : {}),
		}))
		.sort((a, b) => b.outcomeAt - a.outcomeAt || a.sessionId.localeCompare(b.sessionId));

	const pending = scheduled.filter((item) => item.state === "pending");
	return {
		projectId,
		summary: {
			chats: sessions.length,
			working: working.length,
			needsYou: needsYou.length,
			openPullRequests: pullRequests.length,
			readyPullRequests: pullRequests.filter(isReady).length,
			activeMissions: missions.length,
		},
		needsYou: section(needsYou, limit),
		working: section(working, limit),
		pullRequests: section(pullRequests, limit),
		missions: section(
			missions.map(({ updatedAt: _updatedAt, ...mission }) => mission),
			limit,
		),
		scheduled: section(pending, limit),
		tracked: (input.tracked ?? []).map((source) => ({
			...source,
			items: source.items.slice(0, limit),
			...(source.done ? { done: { total: source.done.total, items: source.done.items.slice(0, limit) } } : {}),
		})),
		recent: section(recent, limit),
		...(input.memory ? { memory: input.memory } : {}),
	};
}

export interface DashboardServiceDeps {
	sessions: {
		list(query: { archived: "false"; projectId?: string }): SessionSummary[];
		onChange(listener: (session: SessionSummary) => void): () => void;
	};
	projects: Pick<ProjectStore, "list" | "require" | "onChange">;
	missions?: Pick<MissionStore, "list" | "taskProgress" | "onChange" | "onMembershipChange">;
	reviews: Pick<ReviewStore, "isUnread" | "onChange">;
	providers?: DashboardProviders;
}

/** Reads the stores the dashboard summarizes and reports when any of them changes. */
export class ProjectDashboardService {
	private readonly deps: DashboardServiceDeps;

	constructor(deps: DashboardServiceDeps) {
		this.deps = deps;
	}

	/** Throws NotFound for an unknown project. */
	dashboard(projectId: string, limit = DASHBOARD_SECTION_LIMIT): ProjectDashboard {
		this.deps.projects.require(projectId);
		return this.build(
			projectId,
			this.deps.sessions.list({ archived: "false", projectId }),
			this.deps.missions?.list(projectId) ?? [],
			this.deps.missions?.taskProgress(projectId) ?? new Map(),
			limit,
		);
	}

	/** Working, needs-you and Inbox tracked counts of every project that has any. One pass over the chats. */
	counts(): ProjectDashboardCounts {
		const all = this.everyProject();
		const projects: ProjectDashboardCounts["projects"] = {};
		for (const project of this.deps.projects.list()) {
			const { summary, needsYou } = all.build(project.id, Number.MAX_SAFE_INTEGER);
			const needsYouReasons: NonNullable<ProjectDashboardCounts["projects"][string]["needsYouReasons"]> = {};
			for (const item of needsYou.items) {
				const kind = item.attentionReason.kind;
				needsYouReasons[kind] = (needsYouReasons[kind] ?? 0) + 1;
			}
			const tracked = this.deps.providers?.inbox?.(project.id) ?? 0;
			if (summary.working || summary.needsYou || tracked)
				projects[project.id] = {
					working: summary.working,
					needsYou: summary.needsYou,
					...(summary.needsYou ? { needsYouReasons } : {}),
					...(tracked ? { tracked } : {}),
				};
		}
		return { projects };
	}

	/** Needs-you rows of one project or every project, most urgent first, for the Inbox. Throws NotFound. */
	needsYou(projectId: string | undefined, limit: number): DashboardSection<InboxNeedsYouItem> {
		return this.inbox(projectId, limit).needsYou;
	}

	/**
	 * The Inbox's Needs you and Ready to merge sections, for one project or every project, in one pass over the
	 * chats. A ready PR is listed only while its chat neither works nor needs the user, so each chat sits in one
	 * section, as in the sidebar. Throws NotFound.
	 */
	inbox(projectId: string | undefined, limit: number): Pick<Inbox, "needsYou" | "readyToMerge"> {
		if (projectId) this.deps.projects.require(projectId);
		const ids = projectId ? [projectId] : this.deps.projects.list().map((project) => project.id);
		const all = this.everyProject();
		const items: InboxNeedsYouItem[] = [];
		const ready: InboxReadyToMergeItem[] = [];
		for (const id of ids) {
			const dashboard = all.build(id, Number.MAX_SAFE_INTEGER);
			const busy = new Set(dashboard.working.items.map((item) => item.sessionId));
			for (const item of dashboard.needsYou.items) {
				items.push({ ...item, projectId: id });
				// A failed schedule names the chat it targets; that chat is not waiting on the user.
				if (item.sessionId && item.kind !== "scheduled_failed") busy.add(item.sessionId);
			}
			for (const pr of dashboard.pullRequests.items)
				if (pr.state === "open" && pr.readiness?.state === "ready" && !busy.has(pr.sessionId))
					ready.push({ ...pr, projectId: id });
		}
		items.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.at - a.at || a.id.localeCompare(b.id));
		ready.sort((a, b) => b.checkedAt - a.checkedAt || a.url.localeCompare(b.url));
		return { needsYou: section(items, limit), readyToMerge: section(ready, limit) };
	}

	/** Fires after any change that can alter a dashboard. Callers coalesce and compare results. */
	onChange(listener: () => void): () => void {
		const { sessions, projects, missions, reviews, providers } = this.deps;
		const disposers = [
			sessions.onChange(() => listener()),
			projects.onChange(() => listener()),
			reviews.onChange(listener),
			...(missions ? [missions.onChange(() => listener()), missions.onMembershipChange(() => listener())] : []),
			...(providers?.onChange ? [providers.onChange(listener)] : []),
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}

	/** Chats and missions grouped by project in one pass, for building several dashboards. */
	private everyProject(): { build(projectId: string, limit?: number): ProjectDashboard } {
		const byProject = new Map<string, SessionSummary[]>();
		for (const session of this.deps.sessions.list({ archived: "false" })) {
			if (!session.projectId) continue;
			const list = byProject.get(session.projectId);
			if (list) list.push(session);
			else byProject.set(session.projectId, [session]);
		}
		const missionsByProject = new Map<string, Mission[]>();
		for (const mission of this.deps.missions?.list() ?? []) {
			const list = missionsByProject.get(mission.projectId);
			if (list) list.push(mission);
			else missionsByProject.set(mission.projectId, [mission]);
		}
		const progress = this.deps.missions?.taskProgress() ?? new Map();
		return {
			build: (projectId, limit) =>
				this.build(
					projectId,
					byProject.get(projectId) ?? [],
					missionsByProject.get(projectId) ?? [],
					progress,
					limit,
				),
		};
	}

	private build(
		projectId: string,
		sessions: SessionSummary[],
		missions: Mission[],
		progress: Map<string, MissionTaskProgress>,
		limit = DASHBOARD_SECTION_LIMIT,
	): ProjectDashboard {
		const { reviews, providers } = this.deps;
		return buildProjectDashboard(
			{
				projectId,
				sessions,
				missions,
				progress,
				isUnread: (id, at) => reviews.isUnread(id, at),
				scheduled: providers?.scheduled?.(projectId),
				tracked: providers?.tracked?.(projectId),
				memory: providers?.memory?.(projectId),
			},
			limit,
		);
	}
}
