import type { DayWorkingChat, Mission, MissionTask, SessionSummary } from "@pilot/protocol";

/** Reads live session facts and saved task titles only. Never opens or wakes a worker. */
export function dayWorking(
	projectId: string,
	sessions: SessionSummary[],
	missions: Mission[],
	tasks: MissionTask[],
	held: ReadonlySet<string>,
): DayWorkingChat[] {
	const active = new Map(missions.filter((m) => m.status === "active").map((m) => [m.id, m]));
	const purposes = new Map<string, string[]>();
	for (const task of tasks) {
		if (!task.sessionId || (task.status !== "in_progress" && task.status !== "in_review")) continue;
		const titles = purposes.get(task.sessionId) ?? [];
		titles.push(task.title);
		purposes.set(task.sessionId, titles);
	}
	const rows = new Map<string, DayWorkingChat>();
	for (const s of sessions) {
		// Only the host's explicit working fact proves activity. Older/unknown facts are not live work.
		if (
			s.projectId !== projectId ||
			s.working !== true ||
			s.state === "starting" ||
			s.archivedAt !== undefined ||
			s.continuedTo ||
			s.sleepPaused ||
			s.offlinePaused ||
			s.workHolds?.length ||
			(s.subscriptionPause && !s.subscriptionPause.forced && s.subscriptionPause.windows.length > 0) ||
			s.attentionReason?.kind === "asks" ||
			(s.missionId && (!active.has(s.missionId) || held.has(s.missionId)))
		)
			continue;
		rows.set(s.id, {
			sessionId: s.id,
			title: s.title,
			missionId: s.missionId ?? null,
			missionTitle: s.missionId ? (active.get(s.missionId)?.title ?? null) : null,
			purpose: purposes.get(s.id)?.join("; ") || null,
			status: "working",
		});
	}
	return [...rows.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
