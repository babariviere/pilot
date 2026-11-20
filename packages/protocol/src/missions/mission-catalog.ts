import type { MissionStatus } from "./missions.ts";
import type { OperationHost } from "../operations/operations.ts";

/** Bounded, cached Local mission discovery. No agent or coordinator authority. */
export interface LogicalMission {
	/** Stable JSON tuple [mission.home.daemonId, mission.home.lineageId, mission.missionId]. */
	id: string;
	mission: { home: OperationHost; missionId: string };
	title: string;
	status: MissionStatus;
	tasksDone: number;
	tasksTotal: number;
	coordinator?: { host: OperationHost; sessionId: string };
	provenance: { kind: "canonical"; sourceHost: OperationHost; projectId: string }[];
}
export interface MissionCatalogResponse {
	logicalMissions: LogicalMission[];
	totals: { logicalMissions: number };
	truncated: boolean;
}
