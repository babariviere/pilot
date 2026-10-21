import type {
	CatalogReplicaMission,
	CatalogSharedTask,
	LogicalMission,
	Mission,
	MissionCatalogResponse,
	MissionProvenance,
	OperationHost,
} from "@pilot/protocol";
export interface SharedMissionGroup {
	projectId: string;
	missionId: string;
	replica?: CatalogReplicaMission;
	tasks: CatalogSharedTask[];
	tasksTotal: number;
}
const short = (text: string | undefined, n = 160) => text?.replace(/[\r\n]/g, " ").slice(0, n);
const sameHost = (a: OperationHost, b: OperationHost) => a.daemonId === b.daemonId && a.lineageId === b.lineageId;
/** Fold all authorized, cached observations before any resource filter, row cap or byte clipping. */
function logicalMissions(host: OperationHost, missions: Mission[], groups: SharedMissionGroup[], now: number) {
	const rows = new Map<string, LogicalMission>();
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
	const evidence = (value: LogicalMission, source: MissionProvenance) => {
		// Different grants/tasks from the same observation are not additional mission evidence.
		const key = JSON.stringify(source);
		if (value.provenance.some((item) => JSON.stringify(item) === key)) return;
		if (value.provenance.length < 16) value.provenance.push(source);
		else {
			truncated = true;
			// Keep authoritative/highest-complete evidence even when it arrived after the provenance cap.
			const rank = (p: MissionProvenance) => (p.kind === "canonical" ? (p.bindingId ? 2 : 3) : p.complete ? 1 : 0);
			const compare = (a: MissionProvenance, b: MissionProvenance) =>
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

export function buildMissionCatalog(
	host: OperationHost,
	missions: Mission[],
	groups: SharedMissionGroup[],
	now = Date.now(),
): MissionCatalogResponse {
	const folded = logicalMissions(host, missions, groups, now);
	const result: MissionCatalogResponse = {
		logicalMissions: folded.rows,
		missions: [],
		sharedTasks: [],
		replicaMissions: [],
		totals: { logicalMissions: folded.total },
		truncated: folded.truncated,
	};
	for (const group of groups)
		for (const task of group.tasks) {
			if (task.consistency !== "provisional") continue;
			result.sharedTasks.push(task);
			if (result.sharedTasks.length > 100 || Buffer.byteLength(JSON.stringify(result)) > 24_000) {
				result.sharedTasks.pop();
				result.truncated = true;
				break;
			}
		}
	while (Buffer.byteLength(JSON.stringify(result)) > 24_000 && result.logicalMissions.length) {
		result.logicalMissions.pop();
		result.truncated = true;
	}
	return result;
}

export interface MissionCatalogSources {
	host: OperationHost;
	missions(): Mission[];
	sharedContext(): SharedMissionGroup[];
}
