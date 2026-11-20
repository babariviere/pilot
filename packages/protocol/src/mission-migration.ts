import type { MissionPlan } from "./mission-plan.ts";
import type { Mission, MissionBrief, MissionResource, MissionTask } from "./missions.ts";

/** Native-only read. No transfer, archive, Start or grant occurs on preview. */
export interface MissionSuccessorPreview {
	version: 1;
	oldMissionId: string;
	newMissionId: string;
	projectId: string;
	oldSource: string;
	newSource: string;
	publication: NonNullable<MissionPlan["publication"]>;
	oldMission: Mission;
	newMission: Mission;
	oldBrief: MissionBrief | null;
	newBrief: MissionBrief;
	oldTasks: MissionTask[];
	newTasks: MissionTask[];
	keptChats: MissionMigrationChat[];
	members: string[];
	managedLinear: MissionResource[];
	/** Optional transfer is unavailable. Existing management stays with the old mission. */
	transferLinear: false;
}

/** Cached workspace fact, not a disk scan or proof a workspace is clean. */
export interface MissionMigrationChat {
	id: string;
	title: string;
	archivedAt: number | null;
	unpublishedWork: true | null;
}

/** /api/operations, targetId=old mission, bindingId=oldSource, bindingGeneration=1. */
export interface MissionReplanFinishIntent {
	purpose: "mission-replan-finish";
	newMissionId: string;
	projectId: string;
	oldSource: string;
	newSource: string;
	transferLinear: false;
}
