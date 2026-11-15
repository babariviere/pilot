/** Read-only view of the old mission a mission re-plans. Same project only; nothing is written. */
import { Conflict } from "./errors.ts";
import type { MissionStore } from "./missions.ts";

/** Brief, decisions and task list, or one task (by number) with its latest report. */
export function replacedMissionView(store: MissionStore, missionId: string, task?: number) {
	const link = store.replaced(missionId);
	if (!link) throw new Conflict("This mission does not re-plan another mission");
	const mission = store.require(link.missionId);
	if (mission.projectId !== store.require(missionId).projectId) throw new Conflict("Replaced mission project changed");
	if (task !== undefined) {
		const found = store.tasks(mission.id).find((t) => t.number === task);
		if (!found) throw new Conflict(`Unknown task #${task} in the replaced mission`);
		const report = store.controls.latestReport(mission.id, found.id);
		return { missionId: mission.id, task: found, latestReport: report?.write ?? null };
	}
	const detail = store.detail(mission.id);
	return {
		missionId: mission.id,
		title: mission.title,
		goal: mission.goal,
		status: mission.status,
		link: link.state,
		brief: detail.brief?.markdown ?? null,
		decisions: detail.decisions.map((d) => ({
			number: d.number,
			text: d.text,
			...(d.replacement ? { replacedBy: d.replacement.number } : {}),
			...(d.withdrawn ? { withdrawn: d.withdrawn.reason } : {}),
		})),
		tasks: detail.tasks.map((t) => ({ number: t.number, title: t.title, status: t.status })),
	};
}
