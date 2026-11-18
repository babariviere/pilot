import type { DayWaitingChat, DayWorkingChat, Mission, MissionTask, SessionSummary } from "@pilot/protocol";

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
			// Saved input that waits for a coding slot is not running: it shows under Waiting instead.
			(s.codingQueueReason && s.state !== "working") ||
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

/** Chats of the project whose saved input waits for a coding slot, first in line first. Reads summaries only. */
export function dayWaiting(projectId: string, sessions: SessionSummary[], missions: Mission[]): DayWaitingChat[] {
	const titles = new Map(missions.map((m) => [m.id, m.title]));
	return sessions
		.flatMap((s) =>
			s.projectId === projectId && s.codingQueue && s.archivedAt === undefined
				? [
						{
							sessionId: s.id,
							title: s.title,
							missionId: s.missionId ?? null,
							missionTitle: s.missionId ? (titles.get(s.missionId) ?? null) : null,
							queue: s.codingQueue,
						},
					]
				: [],
		)
		.sort((a, b) => a.queue.position - b.queue.position || a.sessionId.localeCompare(b.sessionId));
}
