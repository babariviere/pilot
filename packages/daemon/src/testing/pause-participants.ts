import type { MissionPauseParticipants } from "../mission-controls.ts";

/**
 * Pause participants for fixtures without mission work: no chats run mission work, each chat owns its own work, and
 * checkpoint and resume succeed unless overridden.
 */
export function pauseParticipants(overrides: Partial<MissionPauseParticipants> = {}): MissionPauseParticipants {
	return {
		get: () => undefined,
		missionWorkOwner: (sessionId) => sessionId,
		missionWorkMission: () => undefined,
		missionWorkSessions: () => [],
		missionWorkBelongs: () => false,
		checkpointMission: async () => "paused",
		resumeMission: async () => "resumed",
		...overrides,
	};
}
