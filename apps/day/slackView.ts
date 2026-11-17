import { signal } from "nsh";
import { glide } from "./ui";
import type { ReportDetails } from "./slackControls";

export const slackOpen = signal(false);
export const slackProject = signal<string | null>(null);
export const slackOffset = signal(0);
export const selectedSlackReport = signal<string | null>(null);
export const slackEdit = signal<{
	projectId: string;
	binding: string;
	digest: string;
	offset?: number;
	itemId: string;
	details: ReportDetails;
} | null>(null);
export const slackGroupEdit = signal<{
	projectId: string;
	binding: string;
	digest: string;
	offset?: number;
	caseId: string;
	action: "rename" | "merge" | "split";
	name: string;
	targetId: string;
	itemIds: string[];
} | null>(null);
export function openSlack() {
	glide();
	slackProject.set(null);
	slackOpen.set(true);
}
export function closeSlack() {
	slackOpen.set(false);
}
export function savedSlackReports(): string {
	return JSON.stringify({
		open: slackOpen(),
		project: slackProject(),
		offset: slackOffset(),
		selected: selectedSlackReport(),
		edit: slackEdit(),
		group: slackGroupEdit(),
	});
}
export function restoreSlackReports(saved: string) {
	slackOpen.set(false);
	slackProject.set(null);
	slackOffset.set(0);
	selectedSlackReport.set(null);
	slackEdit.set(null);
	slackGroupEdit.set(null);
	try {
		const v = JSON.parse(saved);
		if (!v || typeof v !== "object") return;
		const id = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(s);
		const digest = (s: unknown) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
		const scope = (d: { projectId?: unknown; binding?: unknown; digest?: unknown }) =>
			d && id(d.projectId) && digest(d.binding) && digest(d.digest);
		if (id(v.project)) slackProject.set(v.project);
		if (Number.isInteger(v.offset) && v.offset >= 0 && v.offset <= 1_000_000) slackOffset.set(v.offset);
		if (id(v.selected)) selectedSlackReport.set(v.selected);
		// Drafts only; no action is dispatched on restore. Their original digest must still match before Save.
		if (
			scope(v.edit) &&
			id(v.edit.itemId) &&
			v.edit.details &&
			["client", "reporter", "issue"].every((k) => {
				const f = v.edit.details[k];
				return f === null || (f && typeof f.value === "string" && typeof f.evidence === "string");
			})
		)
			slackEdit.set(v.edit);
		if (
			scope(v.group) &&
			id(v.group.caseId) &&
			["rename", "merge", "split"].includes(v.group.action) &&
			typeof v.group.name === "string" &&
			typeof v.group.targetId === "string" &&
			Array.isArray(v.group.itemIds) &&
			v.group.itemIds.length <= 200 &&
			v.group.itemIds.every(id)
		)
			slackGroupEdit.set(v.group);
		slackOpen.set(v.open === true);
	} catch {
		/* An invalid draft never starts work. */
	}
}
