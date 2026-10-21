/** Bounded, cached mission discovery. No agent or coordinator authority. */
export interface LogicalMission {
	/** Stable JSON tuple [mission.home.daemonId, mission.home.lineageId, mission.missionId]. */
	id: string;
	mission: import("./shared-context.ts").SharedMissionRef;
	title?: string;
	status?: import("./index.ts").MissionStatus;
	/** Unknown counts are omitted, never reconstructed from a clipped/provisional task list. */
	tasksDone?: number;
	tasksTotal?: number;
	coordinator?: import("./shared-context.ts").SharedSessionRef;
	/** Bounded source evidence, not host sections, execution placement or new authority. */
	provenance: MissionProvenance[];
}
export interface MissionProvenance {
	kind: "canonical" | "replica";
	sourceHost: import("./operations.ts").OperationHost;
	/** Source-local project metadata, not logical mission identity. */
	projectId: string;
	bindingId?: string;
	sequence?: number;
	complete?: boolean;
	replicaSyncedAt?: number;
	/** Missing means unknown; no wall-clock ordering or connectivity-derived mission status. */
	replicaAgeMs?: number;
}
export interface CatalogMission {
	id: string;
	projectId: string;
	title: string;
	status: import("./index.ts").MissionStatus;
	tasksDone: number;
	tasksTotal: number;
	coordinatorSessionId?: string;
}
export interface CatalogReplicaMission {
	id: string;
	bindingId: string;
	projectId: string;
	missionId: string;
	missionHome: import("./operations.ts").OperationHost;
	title?: string;
	status?: import("./index.ts").MissionStatus;
	complete: boolean;
	sequence: number;
	consistency: "committed";
	replicaSyncedAt?: number;
	/** null means unknown (including replicas imported before timestamp recording). */
	replicaAgeMs: number | null;
}
export interface CatalogSharedTask {
	id: string;
	bindingId: string;
	/** Local execution project for replicas, canonical project for mission-home grants. */
	projectId: string;
	missionId: string;
	missionHome: import("./operations.ts").OperationHost;
	source: "mission-home" | "replica";
	consistency: "committed" | "provisional";
	taskId?: string;
	taskNumber?: number;
	title?: string;
	status?: import("./index.ts").MissionTaskStatus;
	proposalId?: string;
	proposalState?: "pending" | "conflict" | "rejected";
	delegationId?: string;
	executionHost?: import("./operations.ts").OperationHost;
	executionEpoch?: number;
	grantState?: import("./shared-context.ts").DelegationGrant["state"];
	/** Last imported working fact, not a liveness probe. Sealed grants are never running. */
	running?: boolean;
	replicaSyncedAt?: number;
	replicaAgeMs?: number | null;
}
export interface MissionCatalogResponse {
	logicalMissions: LogicalMission[];
	missions: CatalogMission[];
	sharedTasks: CatalogSharedTask[];
	replicaMissions: CatalogReplicaMission[];
	totals: { logicalMissions: number };
	truncated: boolean;
}
