import type { LogicalMission, Mission, MissionCatalogResponse, OperationHost } from "@pilot/protocol";

export function buildMissionCatalog(host: OperationHost, missions: Mission[]): MissionCatalogResponse {
	const logicalMissions: LogicalMission[] = missions.slice(0, 50).map((mission) => ({
		id: JSON.stringify([host.daemonId, host.lineageId, mission.id]),
		mission: { home: host, missionId: mission.id },
		title: mission.title.replace(/[\r\n]/g, " ").slice(0, 160),
		status: mission.status,
		tasksDone: mission.tasksDone,
		tasksTotal: mission.tasksTotal,
		...(mission.coordinatorSessionId ? { coordinator: { host, sessionId: mission.coordinatorSessionId } } : {}),
		provenance: [{ kind: "canonical", sourceHost: host, projectId: mission.projectId }],
	}));
	const result: MissionCatalogResponse = {
		logicalMissions,
		totals: { logicalMissions: missions.length },
		truncated: missions.length > logicalMissions.length,
	};
	while (Buffer.byteLength(JSON.stringify(result)) > 24_000 && logicalMissions.length) {
		logicalMissions.pop();
		result.truncated = true;
	}
	return result;
}

export interface MissionCatalogSources {
	host: OperationHost;
	missions(): Mission[];
}
