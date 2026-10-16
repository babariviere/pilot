/** Local ticket planning. No Linear writes or sub-issue creation. */
import type { MissionTaskWrite } from "@pilot/protocol";
import { Conflict } from "./errors.ts";
import type { MissionActor, MissionStore } from "./missions.ts";

export function splitTicket(
	store: MissionStore,
	missionId: string,
	resourceId: unknown,
	drafts: unknown,
	actor: MissionActor,
) {
	if (typeof resourceId !== "string") throw new Error("split requires resourceId of a managed ticket");
	if (!Array.isArray(drafts) || !drafts.length || drafts.length > 20)
		throw new Error("split requires 1–20 tasks with title and optional body");
	return store.batchChanges(() => {
		const detail = store.detail(missionId, false);
		const ticket = detail.resources.find((ref) => ref.id === resourceId && ref.linearRole === "managed");
		if (!ticket) throw new Conflict("Manage the Linear ticket before splitting work");
		const seen = new Set<string>();
		return {
			tasks: drafts.map((draft) => {
				if (
					!draft ||
					typeof draft !== "object" ||
					Array.isArray(draft) ||
					Object.keys(draft).some((key) => key !== "title" && key !== "body") ||
					typeof draft.title !== "string" ||
					!draft.title.trim()
				)
					throw new Error("Each split task needs a title and optional body only");
				const title = draft.title.trim();
				const key = title.toLowerCase().replace(/\s+/g, " ");
				if (seen.has(key)) throw new Conflict("Duplicate split titles; clarify distinct deliverables");
				seen.add(key);
				const matches = detail.tasks.filter((task) => task.title.toLowerCase().replace(/\s+/g, " ") === key);
				const existing = matches.length === 1 ? matches[0] : undefined;
				const linked =
					existing &&
					detail.resources.some(
						(ref) =>
							ref.taskId === existing.id &&
							ref.linearKey === ticket.linearKey &&
							ref.linearRole === "contribution",
					);
				// Exact retries are safe. Similar existing work requires an explicit association, never a guess.
				if (
					matches.length &&
					(!linked || existing?.title !== title || (existing.body ?? "") !== (draft.body ?? ""))
				)
					throw new Conflict(
						`Possible existing work (${matches.map((task) => `#${task.number}`).join(", ")}); clarify or link existing tasks explicitly`,
					);
				const task = existing ?? store.addTask(missionId, { title, body: draft.body } as MissionTaskWrite, actor);
				store.addResource(missionId, { url: ticket.url, taskId: task.id, linearRole: "contribution" }, actor);
				return { id: task.id, number: task.number, title: task.title, reused: !!existing };
			}),
		};
	});
}
