// The update page's screen state, and the window's whole screen state as
// an update saves it. Before anything pauses, every form is saved to its
// own store (Today's drafts, interview answers); what has no store of its
// own (where the user is, New's unsent goal, the item in front, the question
// each interview shows) goes to Rust as one exact SavedView. The new window
// shows it again and sends nothing.
import { signal } from "nsh";
import type { PlaceKind, SavedView } from "pilot-day/native";
import type { Changes } from "./changeFeed";
import { changeMessages, changesRoute, changeTabs, detailsOpen, listMessage } from "./changesView";
import { saveActionDraft, saveDecisionDraft } from "./commands";
import type { Day } from "./day";
import { flushAll } from "./planCommands";
import type { Plans } from "./planning";
import {
	answerDrafts,
	answerMessages,
	answerPicks,
	atQuestion,
	confirmingStart,
	fogOpen,
	goalDraft,
	newBusy,
	newMessage,
	planMessages,
	planRoute,
	roundOpen,
	seeAll,
	submitting,
	writing,
} from "./planView";
import { ritualRoute } from "./ritualView";
import {
	asking,
	confirming,
	controlMessages,
	drafts,
	focused,
	help,
	messages,
	picks,
	replies,
	reports,
	route,
	todayPlace,
} from "./view";
import type { Update } from "./updateFeed";

/** The window's update feed, when it has one. The window sets it once; the top bar reads it. */
export const updateEntry = signal<Update | null>(null);

/** Whether the update page is open, over whatever screen was open. */
export const updateOpen = signal(false);
/** The last message an update intent returned. */
export const updateMessage = signal("");
/** Whether an update intent waits for its answer. */
export const updateBusy = signal(false);

/** Opens the update page. The screen under it stays as it is. */
export function showUpdate() {
	updateMessage.set("");
	updateOpen.set(true);
}

/** Closes the update page, back to the screen under it. */
export function closeUpdate() {
	updateOpen.set(false);
}

/** The screen under the update page, as a place. */
function place(): { place: PlaceKind; id: string } {
	const change = changesRoute();
	if (change)
		return change.kind === "change" ? { place: "change", id: change.snapshotId } : { place: "changes", id: "" };
	const plan = planRoute();
	if (plan) return plan.kind === "new" ? { place: "new", id: "" } : { place: "plan", id: plan.missionId };
	const mission = route();
	if (mission) return { place: "mission", id: mission };
	return { place: "today", id: "" };
}

/**
 * Where the user is, and what has no other store, exactly. A ritual is not
 * kept: the window comes back to Today, and the ritual is offered again.
 */
export function captureView(): SavedView {
	return {
		...place(),
		update: updateOpen(),
		goal: goalDraft(),
		focused: focused() ?? "",
		questions: Object.entries(atQuestion()).map(([interview, question]) => `${interview}/${question}`),
	};
}

/** Why a form could not be saved, or empty when every form was saved. */
export type FormSave = { saved: true } | { saved: false; message: string };

/**
 * Saves every form to its own store and waits for each: Today's picks,
 * own words, questions and reports, then every interview answer. A save
 * that was refused keeps its text on screen and stops the update before
 * anything pauses.
 */
export async function saveForms(day: Day, plans?: Plans): Promise<FormSave> {
	const today = day.today();
	const typed = new Set([...Object.keys(picks()), ...Object.keys(drafts()), ...Object.keys(replies())]);
	let refused = "";
	for (const decision of today.decisions) {
		if (!typed.has(decision.id) || decision.sentOption) continue;
		if (saveDecisionDraft(day, decision).status !== "accepted") refused ||= decision.title;
	}
	for (const action of today.actions) {
		if (!(action.id in reports())) continue;
		if (saveActionDraft(day, action).status !== "accepted") refused ||= action.title;
	}
	day.feed.flushDrafts();
	if (refused) {
		return {
			saved: false,
			message: `Pilot could not save your draft on “${refused}”. Its text stays on Today; nothing was paused or updated.`,
		};
	}
	if (plans) {
		await flushAll(plans);
		const waiting = Object.keys(answerDrafts()).length + Object.keys(answerPicks()).length;
		if (waiting > 0) {
			return {
				saved: false,
				message:
					"Pilot could not save an interview answer. Its text stays on screen; nothing was paused or updated.",
			};
		}
	}
	return { saved: true };
}

/**
 * Starts from nothing, as a new window does: no screen, no unsent text.
 * Saved drafts and answers come back from their own stores.
 */
export function startFresh() {
	picks.set({});
	help.set({});
	drafts.set({});
	replies.set({});
	reports.set({});
	messages.set({});
	asking.set({});
	controlMessages.set({});
	answerDrafts.set({});
	answerPicks.set({});
	answerMessages.set({});
	planMessages.set({});
	submitting.set({});
	fogOpen.set({});
	roundOpen.set({});
	atQuestion.set({});
	writing.set({});
	seeAll.set({});
	changeTabs.set({});
	changeMessages.set({});
	detailsOpen.set({});
	focused.set(null);
	route.set(null);
	confirming.set(null);
	planRoute.set(null);
	goalDraft.set("");
	confirmingStart.set(false);
	newMessage.set("");
	newBusy.set(false);
	changesRoute.set(null);
	listMessage.set("");
	ritualRoute.set(null);
	todayPlace.y = 0;
	todayPlace.row = null;
	updateOpen.set(false);
	updateMessage.set("");
}

/** Shows a saved view again. It only reads: nothing is sent, saved or answered. */
export function restoreView(view: SavedView, changes?: Changes) {
	route.set(view.place === "mission" ? view.id : null);
	planRoute.set(
		view.place === "new" ? { kind: "new" } : view.place === "plan" ? { kind: "plan", missionId: view.id } : null,
	);
	if (view.place === "change" && changes) {
		changesRoute.set({ kind: "change", snapshotId: view.id });
		void changes.feed.open({ snapshotId: view.id });
	} else {
		changesRoute.set(view.place === "changes" && changes ? { kind: "list" } : null);
	}
	goalDraft.set(view.goal);
	focused.set(view.focused || null);
	const shown: Record<string, string> = {};
	for (const entry of view.questions) {
		const at = entry.indexOf("/");
		if (at > 0) shown[entry.slice(0, at)] = entry.slice(at + 1);
	}
	atQuestion.set(shown);
	updateOpen.set(view.update);
}
