// A linked mission draft from Feedback. Drafting only fills New: the user
// edits the goal there, and only Plan sends it, with the feedback and the
// exact proposal it came from. New's other draft (its words, project, mode
// and request or re-plan link) is kept aside unchanged. Going back to Feedback
// pauses the linked draft with its edits. A refused or unconfirmed Plan keeps
// both drafts; only an accepted Plan with Replace other draft chosen drops the
// other one. Edits are never dropped silently: switching to another proposal
// or discarding an edited draft asks first. Nothing here sends anything.
import { signal } from "nsh";
import type { FeedbackItem, UserFeedbackProposal } from "../../feedback/feedbackFeed";
import { type ChatStep, clip, missionDraft } from "../../feedback/feedbackSteps";
import { closeFeedback, feedbackDraft, openFeedback } from "../../feedback/feedbackView";
import { findingWork } from "../../insights/insightsWork";
import { dropChoice } from "../../sessions/chatCommands";
import { newFundingDraft } from "../../settings/models/modelSettingsDraft";
import { glide } from "../../ui";
import {
	chatPick,
	closePlanning,
	confirmingStart,
	goalDraft,
	type LinkedMissionDraft,
	linkedMission,
	newBusy,
	newMessage,
	type OtherNewDraft,
	openNew,
	replacesDraft,
	requestDraft,
} from "../planning/planView";

/**
 * A change that would drop the user's edits to the linked draft, waiting for
 * their answer: another proposal's draft, or discarding this one. View-local.
 */
export const linkedConfirm = signal<
	{ kind: "switch"; next: LinkedMissionDraft; goal: string } | { kind: "discard" } | null
>(null);

/** New's current draft, exactly, or null when it holds nothing to keep. */
function currentDraft(): OtherNewDraft | null {
	const draft: OtherNewDraft = {
		goal: goalDraft(),
		pick: chatPick(),
		replaces: replacesDraft(),
		request: requestDraft(),
		funding: newFundingDraft(),
	};
	return draft.goal.trim() || draft.pick || draft.replaces || draft.request ? draft : null;
}

/** Whether the user changed the linked draft's words since it was drafted. */
export function linkedEdited(): boolean {
	const linked = linkedMission();
	return !!linked && goalDraft() !== linked.drafted;
}

/** Puts `next` and its words in New in place of any linked draft. The other draft stays kept. */
function useLinked(next: LinkedMissionDraft, goal: string) {
	dropChoice();
	goalDraft.set(goal);
	replacesDraft.set(null);
	requestDraft.set(null);
	chatPick.set({ projectId: next.projectId, mode: "build" });
	newMessage.set("");
	linkedConfirm.set(null);
	linkedMission.set(next);
}

/**
 * Opens New with an editable mission goal from one feedback proposal, linked to
 * that feedback and proposal, in the project of the chat that proposed it. It
 * sends nothing. New's other draft stays saved. Drafting the same proposal
 * again opens the draft with the user's edits. When another proposal's linked
 * draft has edits, New opens it and asks before switching; nothing is lost.
 * False while New is sending, and nothing changes.
 *
 * `from` is the triage or prototype step whose finished proposal the user saw;
 * `proposal` is that step's proposal value and digest (feedbackSteps proposalOf).
 */
export function draftLinkedMission(
	item: FeedbackItem,
	from: ChatStep,
	proposal: { value: UserFeedbackProposal; digest: string },
): boolean {
	if (newBusy() || findingWork()) return false;
	const now = linkedMission();
	const same =
		now?.feedbackId === item.id && now.triageSessionId === from.sessionId && now.proposalDigest === proposal.digest;
	glide();
	if (!same) {
		const goal = missionDraft(item, proposal.value);
		const next: LinkedMissionDraft = {
			feedbackId: item.id,
			triageSessionId: from.sessionId,
			proposalDigest: proposal.digest,
			title: clip(item.text),
			projectId: from.projectId,
			replace: false,
			drafted: goal,
			// Another linked draft gives way, but the user's own other draft stays kept.
			other: now ? now.other : currentDraft(),
		};
		if (now && linkedEdited()) linkedConfirm.set({ kind: "switch", next, goal });
		else useLinked(next, goal);
	} else linkedConfirm.set(null);
	confirmingStart.set(false);
	closeFeedback();
	openNew();
	return true;
}

/** The user chose the waiting switch: the edited linked draft gives way. The other draft stays kept. */
export function confirmLinkedSwitch() {
	const c = linkedConfirm();
	if (c?.kind === "switch" && !newBusy()) useLinked(c.next, c.goal);
}

/** Ends the linked draft. New shows the other draft again, exactly, unless it is dropped. */
function endLinked(keepOther: boolean) {
	const linked = linkedMission();
	if (!linked) return;
	const other = keepOther ? linked.other : null;
	linkedConfirm.set(null);
	linkedMission.set(null);
	dropChoice();
	goalDraft.set(other?.goal ?? "");
	replacesDraft.set(other?.replaces ?? null);
	requestDraft.set(other?.request ?? null);
	chatPick.set(other?.pick ?? null);
	newFundingDraft.set(other?.funding ?? null);
	confirmingStart.set(false);
}

/**
 * Discard the linked draft: New shows its other draft again. An edited draft
 * asks first; `confirmed` is the user's answer. Sends nothing.
 */
export function discardLinkedMission(confirmed = false) {
	if (newBusy() || !linkedMission()) return;
	if (!confirmed && linkedEdited()) {
		linkedConfirm.set({ kind: "discard" });
		return;
	}
	endLinked(true);
	newMessage.set("");
}

/** Back to Feedback: the linked draft waits in New with its edits, and the other draft stays kept. Sends nothing. */
export function backToFeedback() {
	if (newBusy()) return;
	linkedConfirm.set(null);
	newMessage.set("");
	closePlanning();
	openFeedback(feedbackDraft().origin);
}

/** The user chose whether an accepted Plan replaces the other draft. Sends nothing. */
export function replaceOtherDraft(replace: boolean) {
	const linked = linkedMission();
	if (linked && linked.replace !== replace) linkedMission.set({ ...linked, replace });
}

/** Plan of `linked` was accepted: its link is used. The other draft comes back unless the user chose to replace it. */
export function linkedPlanned(linked: LinkedMissionDraft) {
	if (linkedMission() === linked) endLinked(!linked.replace);
}
