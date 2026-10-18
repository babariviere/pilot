/** Shared by the local dashboard and pilot status. Providers are cached, never worker/history reads. */
import type {
	ControlAuthorizationNeeded,
	ControlDashboardBlocker,
	ControlDashboardChat,
	ControlDashboardDecision,
	ControlDashboardReplicaMission,
	ControlDashboardResponse,
	ControlDashboardSharedTask,
	ControlFollowUp,
	ControlLogicalMission,
	ControlMissionProvenance,
	DashboardTrackedItem,
	Mission,
	OperationHost,
	Project,
	SessionSummary,
	Watch,
} from "@pilot/protocol";
import { controlSpend } from "./control-spend.ts";
import type { SessionManager } from "./sessions.ts";

export interface ControlMissionAttention {
	blockedTasks: ControlDashboardBlocker[];
	pendingDecisions: ControlDashboardDecision[];
	blockedTotal: number;
	decisionsTotal: number;
}
/** Each enrolled mission retains at most 100 thin task rows; totals are before clipping. */
export interface ControlSharedMissionGroup {
	projectId: string;
	missionId: string;
	replica?: ControlDashboardReplicaMission;
	tasks: ControlDashboardSharedTask[];
	tasksTotal: number;
}
export interface ControlDashboardSources {
	/** Verified capture producer. Without it, legacy callers cannot claim canonical mission identity. */
	host?: OperationHost;
	sessions: Pick<SessionManager, "list">;
	projects: () => Project[];
	missions: () => Mission[];
	linear: (projectId: string) => DashboardTrackedItem[];
	missionAttention?: (missionId: string) => ControlMissionAttention | undefined;
	/** Change-driven thin projection of grants and local replicas. No SQL or remote reads here. */
	sharedContext?: () => ControlSharedMissionGroup[];
	/** Only failures verified against the current PR head. Legacy readiness is not exact-head evidence. */
	failingChecks?: () => Array<ControlDashboardBlocker & { kind: "failing_checks"; headSha: string }>;
	/** Optional cache invalidations, e.g. exact-head checks fetched by a separate diagnostic action. */
	onDashboardChange?: (listener: () => void) => () => void;
	/** Bounded change-driven cache. Next is global even when the resource lists are scoped. */
	nextWatches?: () => {
		watches: Watch[];
		total: number;
		followUps?: ControlFollowUp[];
		followUpsTotal?: number;
		authorizationNeeded?: ControlAuthorizationNeeded[];
		authorizationNeededTotal?: number;
	};
}
const short = (text: string | undefined, n = 160) => text?.replace(/[\r\n]/g, " ").slice(0, n);
const working = (chat: SessionSummary) =>
	chat.working ?? (chat.state === "working" || chat.state === "starting" || !!chat.runningJobs?.length);

const sameHost = (a: OperationHost, b: OperationHost) => a.daemonId === b.daemonId && a.lineageId === b.lineageId;

/** Fold all authorized, cached observations before any resource filter, row cap or byte clipping. */
function logicalMissions(host: OperationHost, missions: Mission[], groups: ControlSharedMissionGroup[], now: number) {
	const rows = new Map<string, ControlLogicalMission>();
	const replicas = new Map<
		string,
		{ sequence: number; title?: string; status?: Mission["status"]; conflict: boolean }
	>();
	let truncated = false;
	const row = (home: OperationHost, missionId: string) => {
		const id = JSON.stringify([home.daemonId, home.lineageId, missionId]);
		let value = rows.get(id);
		if (!value) {
			value = { id, mission: { home, missionId }, provenance: [] };
			rows.set(id, value);
		}
		return value;
	};
	const evidence = (value: ControlLogicalMission, source: ControlMissionProvenance) => {
		// Different grants/tasks from the same observation are not additional mission evidence.
		const key = JSON.stringify(source);
		if (value.provenance.some((item) => JSON.stringify(item) === key)) return;
		if (value.provenance.length < 16) value.provenance.push(source);
		else {
			truncated = true;
			// Keep authoritative/highest-complete evidence even when it arrived after the provenance cap.
			const rank = (p: ControlMissionProvenance) =>
				p.kind === "canonical" ? (p.bindingId ? 2 : 3) : p.complete ? 1 : 0;
			const compare = (a: ControlMissionProvenance, b: ControlMissionProvenance) =>
				rank(a) - rank(b) || (a.sequence ?? -1) - (b.sequence ?? -1);
			let lowest = 0;
			for (let i = 1; i < value.provenance.length; i++)
				if (compare(value.provenance[i]!, value.provenance[lowest]!) < 0) lowest = i;
			if (compare(source, value.provenance[lowest]!) > 0) value.provenance[lowest] = source;
		}
	};
	for (const m of missions) {
		const value = row(host, m.id);
		Object.assign(value, {
			title: short(m.title),
			status: m.status,
			tasksDone: m.tasksDone,
			tasksTotal: m.tasksTotal,
			...(m.coordinatorSessionId ? { coordinator: { host, sessionId: m.coordinatorSessionId } } : {}),
		});
		evidence(value, { kind: "canonical", sourceHost: host, projectId: m.projectId });
	}
	for (const group of groups) {
		const replica = group.replica;
		if (replica) {
			const value = row(replica.missionHome, replica.missionId);
			evidence(value, {
				kind: "replica",
				sourceHost: host,
				projectId: replica.projectId,
				bindingId: replica.bindingId,
				sequence: replica.sequence,
				complete: replica.complete,
				...(replica.replicaSyncedAt === undefined
					? {}
					: {
							replicaSyncedAt: replica.replicaSyncedAt,
							replicaAgeMs: Math.max(0, now - replica.replicaSyncedAt),
						}),
			});
			// Local authority (including a removed definition) can never be replaced by its own stale replica.
			if (replica.complete && !sameHost(replica.missionHome, host)) {
				const previous = replicas.get(value.id);
				if (!previous || replica.sequence > previous.sequence)
					replicas.set(value.id, {
						sequence: replica.sequence,
						title: replica.title,
						status: replica.status,
						conflict: false,
					});
				else if (
					replica.sequence === previous.sequence &&
					(replica.title !== previous.title || replica.status !== previous.status)
				)
					previous.conflict = true;
			}
		}
		for (const task of group.tasks) {
			if (task.source === "mission-home") {
				if (!sameHost(task.missionHome, host)) continue;
				const value = row(task.missionHome, task.missionId);
				evidence(value, {
					kind: "canonical",
					sourceHost: host,
					projectId: task.projectId,
					bindingId: task.bindingId,
				});
			} else {
				// Replica tasks inherit the already-authorized binding observation, never execution placement.
				if (
					replica &&
					(task.bindingId !== replica.bindingId ||
						task.missionId !== replica.missionId ||
						!sameHost(task.missionHome, replica.missionHome))
				)
					continue;
				const value = row(task.missionHome, task.missionId);
				if (!replica)
					evidence(value, {
						kind: "replica",
						sourceHost: host,
						projectId: task.projectId,
						bindingId: task.bindingId,
						...(task.replicaSyncedAt === undefined
							? {}
							: {
									replicaSyncedAt: task.replicaSyncedAt,
									replicaAgeMs: Math.max(0, now - task.replicaSyncedAt),
								}),
					});
			}
		}
	}
	for (const [id, definition] of replicas) {
		if (definition.conflict) continue;
		const value = rows.get(id)!;
		if (definition.title !== undefined) value.title = short(definition.title);
		if (definition.status !== undefined) value.status = definition.status;
	}
	return { rows: [...rows.values()].slice(0, 50), total: rows.size, truncated: truncated || rows.size > 50 };
}

export function buildControlDashboard(
	sources: ControlDashboardSources,
	args: Record<string, unknown> = {},
	now = Date.now(),
): ControlDashboardResponse {
	for (const key of Object.keys(args))
		if (key !== "projectId" && key !== "missionId") throw new Error(`Unknown parameter: ${key}`);
	const id = (key: string) => {
		const value = args[key];
		if (value === undefined) return undefined;
		if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\x00-\x1f]/.test(value))
			throw new Error(`${key} must be a nonempty ID`);
		return value;
	};
	const projectId = id("projectId"),
		missionId = id("missionId");
	const projects = sources.projects(),
		missions = sources.missions(),
		shared = sources.sharedContext?.() ?? [];
	if (projectId && !projects.some((p) => p.id === projectId)) throw new Error("Unknown project");
	const mission = missionId ? missions.find((m) => m.id === missionId) : undefined;
	const remote = shared.filter((group) => group.missionId === missionId);
	if (missionId && !mission && !remote.length) throw new Error("Unknown mission");
	if (projectId && missionId && mission?.projectId !== projectId && !remote.some((g) => g.projectId === projectId))
		throw new Error("Mission belongs to another project");
	const scopeProjects = new Set([...(mission ? [mission.projectId] : []), ...remote.map((g) => g.projectId)]);
	const selected = projectId ?? (scopeProjects.size === 1 ? [...scopeProjects][0] : undefined);
	const chats = sources.sessions.list({
		archived: "false",
		...(selected ? { projectId: selected } : {}),
		...(missionId ? { missionId } : {}),
	});
	const ms = missions.filter((m) => (!selected || m.projectId === selected) && (!missionId || m.id === missionId));
	const ps = projects.filter((p) => !selected || p.id === selected);
	const data: ControlDashboardResponse = {
		untrusted: true,
		source: "daemon-memory",
		projects: [],
		chats: [],
		missions: [],
		pullRequests: [],
		linear: [],
		runningAgents: [],
		activeMissions: [],
		blockers: [],
		pendingDecisions: [],
		sharedTasks: [],
		replicaMissions: [],
		next: { watches: [], total: 0, followUps: [], followUpsTotal: 0 },
		authorizationNeeded: [],
		authorizationNeededTotal: 0,
		totals: {
			projects: ps.length,
			chats: chats.length,
			missions: ms.length,
			pullRequests: 0,
			linear: 0,
			runningAgents: 0,
			activeMissions: 0,
			blockers: 0,
			pendingDecisions: 0,
			sharedTasks: 0,
			replicaMissions: 0,
		},
		truncated: false,
	};
	const append = <T>(list: T[], item: () => T, limit = 100) => {
		if (list.length < limit) list.push(item());
		else data.truncated = true;
	};
	if (sources.host) {
		const logical = logicalMissions(sources.host, missions, shared, now);
		data.logicalMissions = logical.rows;
		data.totals.logicalMissions = logical.total;
		data.truncated ||= logical.truncated;
	}
	for (const p of ps.slice(0, 200)) append(data.projects, () => ({ id: p.id, name: short(p.name, 100)! }), 200);
	data.truncated ||= ps.length > 200;
	for (const chat of chats) {
		let cachedRow: ControlDashboardChat | undefined;
		const row = () =>
			(cachedRow ??= {
				id: chat.id,
				chatUrl: `pilot://chat/${chat.id}`,
				title: short(chat.title)!,
				projectId: chat.projectId,
				missionId: chat.missionId,
				state: chat.state,
				working: chat.working,
				outcome: chat.outcome,
				model: short(chat.model, 256),
				...(chat.controlStart ? { controlStart: chat.controlStart, spend: controlSpend([chat.usage?.ai]) } : {}),
			});
		append(data.chats, row);
		if (working(chat)) {
			data.totals.runningAgents++;
			const startedAt = chat.lastUserMessageAt ?? chat.createdAt;
			append(data.runningAgents, () => ({ ...row(), startedAt, elapsedMs: Math.max(0, now - startedAt) }));
		} else if (chat.outcome === "question" || chat.outcome === "failed" || chat.state === "failed") {
			data.totals.blockers++;
			append(
				data.blockers,
				(): ControlDashboardBlocker => ({
					id: `chat:${chat.id}`,
					kind: chat.outcome === "question" ? "question" : "failed_chat",
					sessionId: chat.id,
					projectId: chat.projectId,
					missionId: chat.missionId,
					title: row().title,
					detail: short(chat.outcomeReason ?? chat.error, 512),
					at: chat.outcomeAt ?? chat.updatedAt,
				}),
			);
		}
		for (const pr of chat.pullRequests ?? (chat.pullRequest ? [chat.pullRequest] : [])) {
			if (pr.state !== "open" && pr.state !== "draft") continue;
			data.totals.pullRequests++;
			append(data.pullRequests, () => ({
				sessionId: chat.id,
				url: pr.url.slice(0, 2048),
				title: short(pr.title)!,
				number: pr.number,
				state: pr.state as "open" | "draft",
			}));
		}
	}
	for (const m of ms) {
		const row = {
			id: m.id,
			projectId: m.projectId,
			title: short(m.title)!,
			status: m.status,
			tasksDone: m.tasksDone,
			tasksTotal: m.tasksTotal,
			coordinatorSessionId: m.coordinatorSessionId,
		};
		append(data.missions, () => row, 50);
		if (m.status !== "active") continue;
		data.totals.activeMissions++;
		append(data.activeMissions, () => row, 50);
		const attention = sources.missionAttention?.(m.id);
		if (!attention) continue;
		data.totals.blockers += attention.blockedTotal;
		data.totals.pendingDecisions += attention.decisionsTotal;
		for (const task of attention.blockedTasks) append(data.blockers, () => task);
		for (const proposal of attention.pendingDecisions) append(data.pendingDecisions, () => proposal);
		data.truncated ||=
			attention.blockedTotal > attention.blockedTasks.length ||
			attention.decisionsTotal > attention.pendingDecisions.length;
	}
	for (const check of sources.failingChecks?.() ?? []) {
		if ((selected && check.projectId !== selected) || (missionId && check.missionId !== missionId)) continue;
		data.totals.blockers++;
		append(data.blockers, () => ({
			...check,
			title: short(check.title)!,
			detail: short(check.detail, 512),
			url: check.url?.slice(0, 2048),
		}));
	}
	for (const group of shared) {
		if ((selected && group.projectId !== selected) || (missionId && group.missionId !== missionId)) continue;
		const age = (at: number | undefined) => (at === undefined ? null : Math.max(0, now - at));
		const replica = group.replica;
		if (replica) {
			data.totals.replicaMissions++;
			append(
				data.replicaMissions,
				() => ({ ...replica, title: short(replica.title), replicaAgeMs: age(replica.replicaSyncedAt) }),
				50,
			);
		}
		data.totals.sharedTasks += group.tasksTotal;
		for (const task of group.tasks)
			append(data.sharedTasks, () => ({
				...task,
				title: short(task.title),
				...(task.source === "replica" ? { replicaAgeMs: age(task.replicaSyncedAt) } : {}),
			}));
		data.truncated ||= group.tasksTotal > group.tasks.length;
	}
	for (const project of ps.slice(0, 200))
		for (const item of sources.linear(project.id)) {
			if (missionId && item.missionId !== missionId && !item.missionIds?.includes(missionId)) continue;
			data.totals.linear++;
			append(data.linear, () => ({
				projectId: project.id,
				id: item.id,
				identifier: item.externalId,
				title: short(item.title)!,
				status: short(item.status, 60),
				url: item.url?.slice(0, 2048),
			}));
		}
	const next = sources.nextWatches?.() ?? { watches: [], total: 0 };
	data.next.total = next.total;
	data.next.followUpsTotal = next.followUpsTotal ?? 0;
	data.authorizationNeededTotal = next.authorizationNeededTotal ?? 0;
	for (const item of next.followUps ?? []) append(data.next.followUps, () => item);
	for (const item of next.authorizationNeeded ?? []) append(data.authorizationNeeded, () => item);
	for (const watch of next.watches) append(data.next.watches, () => watch);
	data.truncated ||= next.total > data.next.watches.length;
	data.truncated ||=
		data.next.followUpsTotal > data.next.followUps.length ||
		data.authorizationNeededTotal > data.authorizationNeeded.length;
	// One linear byte-budget pass, not repeated serialization/shrinking of the entire response.
	const lists: unknown[][] = [
		...(data.logicalMissions ? [data.logicalMissions] : []),
		data.runningAgents,
		data.activeMissions,
		data.blockers,
		data.pendingDecisions,
		data.sharedTasks,
		data.replicaMissions,
		data.authorizationNeeded,
		data.next.followUps,
		data.next.watches,
		data.projects,
		data.chats,
		data.missions,
		data.pullRequests,
		data.linear,
	];
	const pending = lists.map((list) => list.splice(0));
	let bytes = Buffer.byteLength(JSON.stringify(data)) + 1;
	for (let i = 0; pending.some((list) => i < list.length); i++)
		for (let j = 0; j < lists.length; j++) {
			if (i >= pending[j]!.length) continue;
			const item = pending[j]![i],
				size = Buffer.byteLength(JSON.stringify(item)) + (lists[j]!.length ? 1 : 0);
			if (bytes + size > 24_000) {
				data.truncated = true;
				continue;
			}
			lists[j]!.push(item);
			bytes += size;
		}
	return data;
}
