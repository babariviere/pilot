import type { DayMissionAgent, SessionSummary } from "@pilot/protocol";

/** Pure, project-scoped projection of existing owners. Reading it never wakes a worker. */
export function dayMissionAgents(
	projectId: string,
	missionIds: ReadonlySet<string>,
	sessions: SessionSummary[],
): DayMissionAgent[] {
	return sessions.flatMap((s) => {
		if (s.projectId !== projectId || !s.missionId || !missionIds.has(s.missionId)) return [];
		const holds = [...(s.workHolds ?? [])];
		const working = s.working ?? (s.state === "working" || s.state === "starting" || !!s.runningJobs?.length);
		if (s.archivedAt !== undefined) holds.push("Owner chat archived");
		if (s.continuedTo) holds.push("Owner chat continued elsewhere");
		if (s.sleepPaused) holds.push("Sleep hold");
		if (s.offlinePaused) holds.push("Offline hold");
		if (s.subscriptionPause && !s.subscriptionPause.forced && s.subscriptionPause.windows.length > 0)
			holds.push("Usage limit hold");
		if (!working && (s.state === "failed" || s.outcome === "failed"))
			holds.push("Owner failed. Open its chat for the saved failure.");
		return [
			{
				sessionId: s.id,
				missionId: s.missionId,
				title: s.title,
				working,
				waitingForUser:
					s.archivedAt === undefined &&
					!s.questionSettled &&
					(s.attentionReason?.kind === "asks" || (s.outcome === "question" && !s.scheduledMessage)),
				holds,
			},
		];
	});
}
