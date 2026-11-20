// Reported screens as Before/After pairs for artifact galleries. Read-only: it changes no report, link or artifact.
import type { MissionArtifactLink, ScreenCapture, ScreenPairSummary } from "@pilot/protocol";
import type { MissionStore } from "../missions/missions.ts";

/** The newest image link of `artifactId` that the reporting chat pinned on this task. */
function capture(
	store: MissionStore,
	missionId: string,
	taskId: string,
	sessionId: string,
	artifactId: string,
): ScreenCapture | undefined {
	let best: MissionArtifactLink | undefined;
	for (const link of store.artifactReferences(missionId, artifactId))
		if (
			link.taskId === taskId &&
			link.sessionId === sessionId &&
			link.kind === "image" &&
			link.revision !== undefined &&
			(!best || link.linkedAt > best.linkedAt)
		)
			best = link;
	return best ? { artifactId, revision: best.revision!, title: best.title } : undefined;
}

/**
 * The project's reported screens: for each task, its current worker's latest report that names screens, as the
 * result page shows them. A pair with a capture that is not pinned on the task is left out, so the gallery shows its
 * images on their own rather than a half pair.
 */
export function projectScreenPairs(store: MissionStore, projectId: string): ScreenPairSummary[] {
	const out: ScreenPairSummary[] = [];
	for (const report of store.controls.projectScreensReports(projectId)) {
		const screens = report.write.delivery?.screens;
		if (!screens || !("pairs" in screens)) continue;
		let task: { id: string; sessionId?: string };
		try {
			task = store.resolveTask(report.missionId, report.write.taskId);
		} catch {
			continue;
		}
		if (task.sessionId !== report.sessionId) continue;
		const taskId = task.id;
		for (const pair of screens.pairs) {
			const after = capture(store, report.missionId, taskId, report.sessionId, pair.after);
			const before = pair.before
				? capture(store, report.missionId, taskId, report.sessionId, pair.before)
				: undefined;
			if (!after || (pair.before && !before)) continue;
			out.push({
				missionId: report.missionId,
				taskId,
				sessionId: report.sessionId,
				reportedAt: report.reportedAt,
				...(before ? { before } : {}),
				after,
			});
		}
	}
	return out;
}
