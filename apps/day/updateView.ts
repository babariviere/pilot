// The update page's screen state, and the window's whole screen state as
// an update saves it. Before anything pauses, every form is saved to its
// own store (Today's drafts, interview answers); what has no store of its
// own (where the user is, New's unsent goal, the item in front, open help,
// the question each interview shows, the ritual and its step, scroll
// offsets and the focused field's selection) goes to Rust as one exact
// SavedView. The new window shows it again and sends nothing.
import { signal } from "nsh";
import type { PlaceKind, SavedView, Today } from "pilot-day/native";
import type { Changes } from "./changeFeed";
import { changeMessages, changesRoute, changeTabs, detailsOpen, listMessage } from "./changesView";
import { saveActionDraft, saveDecisionDraft } from "./commands";
import type { Day } from "./day";
import { subjectOf } from "./deliveryFeed";
import {
	backNotes,
	backOpen,
	deliveryMessages,
	deliveryRoute,
	deliveryTitles,
	doneAsk,
	hideInspection,
	outputMessages,
	reminders,
	remindersOf,
	savedReminders,
} from "./deliveryView";
import { feedbackOpen, forgetFeedback, restoreFeedback, savedFeedback } from "./feedbackView";
import { forgetPlaces, lastField, restoreField, restoreScroll, scrollOf, todayScrollTo } from "./kept";
import { focusIssue, linearOpen, linearProject, openIssue, restoreLinear, savedLinear } from "./linearView";
import { flushAll } from "./planCommands";
import type { Plans } from "./planning";
import {
	answerDrafts,
	answerMessages,
	answerPicks,
	atQuestion,
	chatChoice,
	chatNote,
	chatPick,
	chatSelecting,
	confirmingStart,
	fogOpen,
	goalDraft,
	newBusy,
	newMessage,
	planMessages,
	planRoute,
	projectsOpen,
	restoredDraft,
	roundOpen,
	seeAll,
	submitting,
	writing,
} from "./planView";
import {
	preferencesDraft,
	preferencesMessage,
	restorePreferences,
	savedPreferences,
	settingsOpen,
} from "./preferencesView";
import { type RitualRoute, ritualRoute, startStep } from "./ritualView";
import { forgetThreads, restoreThreads, savedThread, savedThreadDrafts, threadRoute } from "./threadView";
import { todayProject } from "./todayScope";
import type { Update } from "./updateFeed";
import {
	asking,
	confirming,
	controlMessages,
	drafts,
	focused,
	type Help,
	help,
	messages,
	picks,
	replies,
	reports,
	route,
	todayPlace,
} from "./view";

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

/** The key of the screen shown under the update page, for its scroll and fields. */
export function shownKey(): string {
	if (ritualRoute()) return "ritual";
	if (settingsOpen()) return "settings";
	if (feedbackOpen()) return "feedback";
	const delivery = deliveryRoute();
	if (delivery) return `delivery/${delivery.key}`;
	if (linearOpen()) return "linear";
	const at = place();
	const thread = threadRoute();
	if (at.place === "mission" && thread?.missionId === at.id) return `thread/${thread.missionId}/${thread.topicId}`;
	return at.id ? `${at.place}/${at.id}` : at.place;
}

function ritualWords(at: RitualRoute): string {
	if (!at) return "";
	if (at.kind === "standup") return at.from ? `standup/${at.from}` : "standup";
	return at.kind;
}

function ritualOf(words: string): RitualRoute {
	switch (words) {
		case "start":
		case "end":
			return { kind: words };
		case "standup":
			return { kind: "standup", from: null };
		case "standup/start":
			return { kind: "standup", from: "start" };
		case "standup/end":
			return { kind: "standup", from: "end" };
		default:
			return null;
	}
}

const HELP: readonly Help[] = ["simpler", "more", "visual", "ask", "details"];

/**
 * Where the user is, and what has no other store, exactly. `today` names
 * the date a ritual on screen is for. A ritual's marks (done, skipped) are
 * not kept here: they belong to the ritual's own progress.
 */
export function captureView(today?: Today): SavedView {
	const at = place();
	const key = shownKey();
	const ritual = ritualWords(ritualRoute());
	const field = lastField(key);
	const change = changesRoute();
	return {
		...at,
		update: updateOpen(),
		goal: goalDraft(),
		// The project and access New shows, as Pilot last selected them. Never a sent chat.
		chat: chatChoice(),
		// New never picks a project, so a selection is the user's own choice.
		chatChosen: chatChoice() !== null && chatPick() !== null,
		focused: focused() ?? "",
		questions: Object.entries(atQuestion()).map(([interview, question]) => `${interview}/${question}`),
		ritual,
		date: ritual ? (today?.date ?? "") : "",
		step: ritual === "start" ? startStep() : 0,
		help: Object.entries(help()).flatMap(([item, kinds]) => kinds.map((kind) => `${item}/${kind}`)),
		seeAll: Object.entries(seeAll())
			.filter(([, all]) => all)
			.map(([interview]) => interview),
		tab: change?.kind === "change" ? (changeTabs()[change.snapshotId] ?? "") : "",
		todayY: Math.max(0, todayPlace.y),
		todayRow: todayPlace.row ?? "",
		y: key === "today" ? 0 : scrollOf(key),
		input: field?.key ?? "",
		start: field?.start ?? 0,
		end: field?.end ?? 0,
		delivery: deliveryRoute()?.key ?? "",
		// Unsent Send back notes, exactly as typed. Restoring one sends nothing.
		notes: Object.entries(backNotes())
			.filter(([, note]) => note !== "")
			.map(([key, note]) => `${key}\n${note}`),
		// Ticked reminders on delivered results. They send nothing and are never a check.
		reminders: savedReminders(),
		// The Linear page, its project and open issue. Showing it again only reads.
		linear: savedLinear(),
		// The project Today shows, or "" for All projects. Showing it again only reads.
		todayProject: todayProject() === "all" ? "" : todayProject(),
		// Settings, and unsaved project preferences exactly as typed, with their
		// project and revision. Restoring them sends and saves nothing.
		settings: settingsOpen(),
		preferences: savedPreferences(),
		// The thread on screen and unsent thread words, by mission and thread.
		// Restoring them sends nothing and never moves words to another thread.
		thread: savedThread(),
		threads: savedThreadDrafts(),
		// The feedback page and unsent feedback with its own origin. Restoring sends nothing.
		feedbackOpen: feedbackOpen(),
		feedback: savedFeedback(),
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
	chatPick.set(null);
	chatChoice.set(null);
	chatSelecting.set(false);
	chatNote.set("");
	projectsOpen.set(false);
	restoredDraft.set(null);
	changesRoute.set(null);
	listMessage.set("");
	ritualRoute.set(null);
	startStep.set(0);
	deliveryRoute.set(null);
	deliveryTitles.set({});
	backNotes.set({});
	backOpen.set({});
	doneAsk.set(null);
	reminders.set({});
	deliveryMessages.set({});
	outputMessages.set({});
	// A shown source is never saved or read again by a restored window.
	hideInspection();
	linearOpen.set(false);
	openIssue.set(null);
	linearProject.set(null);
	focusIssue.set(null);
	todayProject.set("all");
	settingsOpen.set(false);
	preferencesDraft.set(null);
	preferencesMessage.set("");
	forgetFeedback();
	forgetThreads();
	todayPlace.y = 0;
	todayPlace.row = null;
	forgetPlaces();
	updateOpen.set(false);
	updateMessage.set("");
}

/**
 * Shows a saved view again. It only reads: nothing is sent, saved, answered
 * or started. A ritual comes back only on the date it was for (`today`).
 * The Linear page comes back only in a window that has it (`linear`), on
 * the project it showed: a read for another project shows nothing.
 * Settings comes back only in a window that has it (`settings`); unsaved
 * preferences always come back as unsaved text, for their own project.
 */
export function restoreView(view: SavedView, changes?: Changes, today?: Today, linear = false, settings = false) {
	route.set(view.place === "mission" ? view.id : null);
	planRoute.set(
		view.place === "new" ? { kind: "new" } : view.place === "plan" ? { kind: "plan", missionId: view.id } : null,
	);
	if (view.place === "change" && changes) {
		changesRoute.set({ kind: "change", snapshotId: view.id });
		if (view.tab === "diff" || view.tab === "history") changeTabs.set({ [view.id]: view.tab });
		void changes.feed.open({ snapshotId: view.id });
	} else {
		changesRoute.set(view.place === "changes" && changes ? { kind: "list" } : null);
	}
	goalDraft.set(view.goal);
	// The project and access the user chose come back as a choice to select
	// again, never as a selection: New reads them again and sends nothing. A
	// view saved without chatChosen may hold New's old default project, never
	// the user's choice: it comes back with no project. Its draft identity stays.
	const chat = view.chat;
	chatPick.set(
		chat && view.chatChosen === true
			? { projectId: chat.projectId, mode: chat.mode === "ask" ? "ask" : "build" }
			: null,
	);
	chatChoice.set(null);
	restoredDraft.set(chat?.draftId ?? null);
	focused.set(view.focused || null);
	const shown: Record<string, string> = {};
	for (const entry of view.questions) {
		const at = entry.indexOf("/");
		if (at > 0) shown[entry.slice(0, at)] = entry.slice(at + 1);
	}
	atQuestion.set(shown);
	const open: Record<string, Help[]> = {};
	for (const entry of view.help ?? []) {
		const at = entry.lastIndexOf("/");
		const kind = entry.slice(at + 1) as Help;
		if (at > 0 && HELP.includes(kind)) open[entry.slice(0, at)] = [...(open[entry.slice(0, at)] ?? []), kind];
	}
	help.set(open);
	seeAll.set(Object.fromEntries((view.seeAll ?? []).map((interview) => [interview, true])));
	const ritual = view.date && today && view.date === today.date ? ritualOf(view.ritual ?? "") : null;
	ritualRoute.set(ritual);
	startStep.set(ritual?.kind === "start" ? Math.min(view.step ?? 0, 2) : 0);
	// A delivered result's page comes back as a read; its notes as unsent words.
	const delivery = view.delivery ? subjectOf(view.delivery) : null;
	hideInspection();
	deliveryRoute.set(delivery ? { key: view.delivery ?? "", subject: delivery, title: "" } : null);
	const notes: Record<string, string> = {};
	for (const entry of view.notes ?? []) {
		const at = entry.indexOf("\n");
		if (at > 0 && subjectOf(entry.slice(0, at))) notes[entry.slice(0, at)] = entry.slice(at + 1);
	}
	backNotes.set(notes);
	backOpen.set(Object.fromEntries(Object.keys(notes).map((key) => [key, true])));
	reminders.set(remindersOf(view.reminders ?? []));
	linearOpen.set(false);
	openIssue.set(null);
	linearProject.set(null);
	focusIssue.set(null);
	if (linear && view.linear) restoreLinear(view.linear);
	restorePreferences(view.preferences ?? []);
	settingsOpen.set(settings && view.settings === true);
	// Unsent feedback always comes back as unsent words with their own origin.
	// The page shows again only in a window that has it.
	restoreFeedback(view.feedback ?? "");
	feedbackOpen.set(view.feedbackOpen === true);
	// A thread comes back over its own mission only; its words always come back unsent.
	const thread = view.thread ?? "";
	restoreThreads(view.place === "mission" && thread.startsWith(`${view.id}/`) ? thread : "", view.threads ?? []);
	// Today's project scope comes back as a read; a view saved before it existed shows All projects.
	todayProject.set(view.todayProject || "all");
	todayPlace.y = Math.max(0, view.todayY ?? 0);
	todayPlace.row = view.todayRow || null;
	const key = shownKey();
	if (key === "today") todayScrollTo.set(todayPlace.y);
	else restoreScroll(key, view.y ?? 0);
	restoreField(view.input ? { key: view.input, place: key, start: view.start ?? 0, end: view.end ?? 0 } : null);
	updateOpen.set(view.update);
}
