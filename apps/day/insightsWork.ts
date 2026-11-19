import { signal } from "nsh";
import { dropChoice } from "./chatCommands";
import type { InsightsDetail } from "./insightsView";
import { newFundingDraft } from "./modelSettingsDraft";
import {
	chatPick,
	confirmingStart,
	goalDraft,
	linkedMission,
	newBusy,
	newMessage,
	type OtherNewDraft,
	openNew,
	replacesDraft,
	requestDraft,
} from "./planView";

type FindingWork = {
	kind: "fix" | "plan";
	key: string;
	revision: number;
	title: string;
	projectId: string;
	sourceIds: string[];
	other: OtherNewDraft | null;
};
export const findingWork = signal<FindingWork | null>(null);

export function canDraftInsight() {
	return !newBusy() && !linkedMission();
}

function currentDraft(): OtherNewDraft | null {
	const draft = {
		goal: goalDraft(),
		pick: chatPick(),
		replaces: replacesDraft(),
		request: requestDraft(),
		funding: newFundingDraft(),
	};
	return draft.goal || draft.pick || draft.replaces || draft.request || draft.funding ? draft : null;
}

export function hasOtherDraft() {
	return !!findingWork() || !!currentDraft();
}

/** Opening work only fills the usual New draft. It never sends or marks a finding shipped. */
export function openFindingDraft(kind: "fix" | "plan", item: InsightsDetail, confirmed = false) {
	if (!canDraftInsight() || (!confirmed && hasOtherDraft()) || !item.projectId || !item.proposal || item.legacy)
		return;
	const same = findingWork();
	if (same?.key === item.key && same.revision === item.revision && same.kind === kind) {
		openNew();
		if (kind === "fix") confirmingStart.set(true);
		return;
	}
	const other = same ? same.other : currentDraft();
	findingWork.set({
		kind,
		key: item.key,
		revision: item.revision,
		title: item.title,
		projectId: item.projectId,
		sourceIds: [...new Set((item.evidence ?? []).map((e) => e.sessionId).filter(Boolean))].slice(0, 20),
		other,
	});
	dropChoice();
	chatPick.set({ projectId: item.projectId, mode: "build" });
	replacesDraft.set(null);
	requestDraft.set(null);
	goalDraft.set(item.proposal);
	newMessage.set("");
	openNew();
	if (kind === "fix") confirmingStart.set(true);
}

/** Append saved references to the work request independently of the editable goal. */
export function findingGoal(goal: string, kind: FindingWork["kind"]): string {
	const link = findingWork();
	if (!link || link.kind !== kind) return goal;
	return [
		goal,
		`Insights finding: ${link.key} (revision ${link.revision}).`,
		...link.sourceIds.map((id) => `Source chat: pilot://chat/${encodeURIComponent(id)}`),
	].join("\n\n");
}

/** Complete or discard only the exact linked draft, then restore the previous New draft. */
export function restoreOtherDraft(pinned = findingWork()) {
	if (!pinned || findingWork() !== pinned) return false;
	findingWork.set(null);
	const other = pinned.other;
	dropChoice();
	goalDraft.set(other?.goal ?? "");
	chatPick.set(other?.pick ?? null);
	replacesDraft.set(other?.replaces ?? null);
	requestDraft.set(other?.request ?? null);
	newFundingDraft.set(other?.funding ?? null);
	confirmingStart.set(false);
	return true;
}

export function savedFindingWork() {
	const work = findingWork();
	return work ? JSON.stringify(work) : "";
}

export function restoreFindingWork(raw = "") {
	findingWork.set(null);
	if (!raw || raw.length > 28_672) return;
	try {
		const draft = JSON.parse(raw) as FindingWork;
		if (
			!["fix", "plan"].includes(draft.kind) ||
			!draft.key ||
			!draft.title ||
			!draft.projectId ||
			!Number.isSafeInteger(draft.revision) ||
			draft.revision < 1 ||
			!Array.isArray(draft.sourceIds) ||
			!draft.sourceIds.every((id) => typeof id === "string")
		)
			return;
		findingWork.set(draft);
		chatPick.set({ projectId: draft.projectId, mode: "build" });
		// Restoring the form must not restore a confirmation.
		confirmingStart.set(false);
	} catch {
		// Invalid local view text is not an intent.
	}
}
