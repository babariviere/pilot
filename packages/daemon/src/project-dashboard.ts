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
	type Mission,
	type ProjectDashboard,
	type ProjectDashboardCounts,
	type ProjectMemorySummary,
	type SessionPullRequest,
	type SessionSummary,
} from "@pilot/protocol";
import type { MissionStore } from "./missions.ts";
import type { ProjectStore } from "./projects.ts";
import type { ReviewStore } from "./reviews.ts";
import { NotFound } from "./errors.ts";

/** Optional data providers. Until registered, their sections are empty or absent. */
export interface DashboardProviders {
	/** Pending and failed scheduled items of a project. Failed ones are listed under Needs you. */
	scheduled?: (projectId: string) => DashboardScheduledItem[];
	/** One group per configured tracking source of a project. */
	tracked?: (projectId: string) => DashboardTrackedSource[];
	/** Cached count, recent notes and background compaction health. No disk I/O while building a dashboard. */
	memory?: (projectId: string) => ProjectMemorySummary;
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
	progress: Map<string, { done: number; total: number }>;
	isUnread: (sessionId: string, outcomeAt: number) => boolean;
	scheduled?: DashboardScheduledItem[];
	tracked?: DashboardTrackedSource[];
	memory?: ProjectMemorySummary;
}

const KIND_RANK = { failed: 0, question: 1, scheduled_failed: 2, unread: 3 } as const;
const isTerminal = (pr: SessionPullRequest) => pr.state === "merged" || pr.state === "closed";
const isWorking = (session: SessionSummary) => session.state === "working" || session.state === "starting";

/** Mirrors the app: a chat whose PRs have all settled, with nothing left unpublished, no longer asks for review. */
function hasTerminalPullRequest(session: SessionSummary): boolean {
	if (session.activeMissionCoordinator || session.unpublishedWork || !session.pullRequest) return false;
	return isTerminal(session.pullRequest) && (session.pullRequests ?? []).every(isTerminal);
}

function section<T>(items: T[], limit = DASHBOARD_SECTION_LIMIT): DashboardSection<T> {
	return { total: items.length, items: items.slice(0, limit) };
}

function oneLine(text: string | undefined): string | undefined {
	const line = text
		?.split("\n")
		.find((candidate) => candidate.trim())
		?.trim();
	if (!line) return undefined;
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function ref(pr: SessionPullRequest | undefined): DashboardPullRequestRef | undefined {
	return pr ? { number: pr.number, url: pr.url, state: pr.state } : undefined;
}

/** Extension point for merge readiness; the daemon has none yet, so rows carry none. */
function readinessOf(_pr: SessionPullRequest): DashboardPullRequestReadiness | undefined {
	return undefined;
}

/** A finished chat that has not been reviewed: its result or failure still waits on the user. */
function needsReview(session: SessionSummary, isUnread: DashboardInput["isUnread"]): boolean {
	if (isWorking(session) || hasTerminalPullRequest(session)) return false;
	if (session.outcomeAt !== undefined && Number.isFinite(session.outcomeAt))
		return session.outcome !== undefined && isUnread(session.id, session.outcomeAt);
	// A failure without a completion version cannot be reviewed away.
	return session.state === "failed";
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
		const isFailure = failed(session);
		const reason = oneLine(session.outcomeReason ?? (isFailure ? session.error : undefined));
		needsYou.push({
			kind: isFailure ? "failed" : "unread",
			id: `session:${session.id}`,
			title: session.title,
			sessionId: session.id,
			...(session.missionId ? { missionId: session.missionId } : {}),
			outcome: session.outcome ?? "failed",
			...(reason ? { reason } : {}),
			at: session.outcomeAt ?? session.updatedAt,
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
				...(oneLine(item.error) ? { reason: oneLine(item.error) } : {}),
				at: item.at ?? 0,
			});
	needsYou.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.at - a.at || a.id.localeCompare(b.id));

	const working: DashboardWorkingItem[] = sessions
		.filter(isWorking)
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
		missions: section(missions.map(({ updatedAt: _updatedAt, ...mission }) => mission), limit),
		scheduled: section(pending, limit),
		tracked: (input.tracked ?? []).map((source) => ({
			...source,
			items: source.items.slice(0, limit),
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

	/** Working and needs-you counts of every project that has either. One pass over the chats. */
	counts(): ProjectDashboardCounts {
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
		const projects: ProjectDashboardCounts["projects"] = {};
		for (const project of this.deps.projects.list()) {
			const { summary } = this.build(
				project.id,
				byProject.get(project.id) ?? [],
				missionsByProject.get(project.id) ?? [],
				progress,
			);
			if (summary.working || summary.needsYou)
				projects[project.id] = { working: summary.working, needsYou: summary.needsYou };
		}
		return { projects };
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

	private build(
		projectId: string,
		sessions: SessionSummary[],
		missions: Mission[],
		progress: Map<string, { done: number; total: number }>,
		limit = DASHBOARD_SECTION_LIMIT,
	): ProjectDashboard {
		const { reviews, providers } = this.deps;
		return buildProjectDashboard({
			projectId,
			sessions,
			missions,
			progress,
			isUnread: (id, at) => reviews.isUnread(id, at),
			scheduled: providers?.scheduled?.(projectId),
			tracked: providers?.tracked?.(projectId),
			memory: providers?.memory?.(projectId),
		}, limit);
	}
}
