// Drafts are data only. Restoring never saves or starts scheduled work.
import { signal } from "nsh";
export type ScheduleDraft = {
	draftId: string;
	binding: string;
	id: string;
	revision: number;
	project: string;
	target: string;
	title: string;
	message: string;
	repeat: string;
	at: string;
	expires: string;
	zone: string;
	time: string;
	weekday: string;
	day: string;
};
export const schedulesOpen = signal(false);
export const scheduleDraft = signal<ScheduleDraft | null>(null);
export function savedSchedules(): string {
	return JSON.stringify({ open: schedulesOpen(), draft: scheduleDraft() });
}
export function restoreSchedules(text: string) {
	schedulesOpen.set(false);
	scheduleDraft.set(null);
	try {
		const s = JSON.parse(text);
		if (typeof s.open === "boolean") schedulesOpen.set(s.open);
		const d = s.draft;
		if (
			d &&
			[
				"binding",
				"id",
				"project",
				"target",
				"title",
				"message",
				"repeat",
				"at",
				"expires",
				"zone",
				"time",
				"weekday",
				"day",
			].every((k) => typeof d[k] === "string") &&
			Number.isSafeInteger(d.revision)
		)
			scheduleDraft.set({ ...d, draftId: typeof d.draftId === "string" ? d.draftId : "", binding: "" });
	} catch {
		/* Old/invalid saved drafts never become an intent. */
	}
}
