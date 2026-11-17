// The fixed SavedView wire composition and ordered window restore.
// Feature owners encode their own drafts, disclosure state and reset rules.
import type { PlaceKind, SavedView, Today } from "pilot-day/native";
import { closeArtifacts } from "./artifactReads";
import type { Changes } from "./changeFeed";
import { captureChangesTab, changesRoute, resetChangesView, restoreChangesView } from "./changesView";
import { closeChat } from "./chatView";
import { saveTodayForms } from "./commands";
import { restoreConnectionDraft, savedConnectionDraft } from "./connectionDraft";
import { restoreDatabaseDraft, savedDatabaseDraft } from "./databaseDraft";
import type { Day } from "./day";
import { captureDeliveryView, deliveryRoute, resetDeliveryView, restoreDeliveryView } from "./deliveryView";
import { restoreDiagnosis, savedDiagnosis } from "./diagnosisDraft";
import {
	captureFeedbackView,
	feedbackCloseRefusal,
	feedbackOpen,
	forgetFeedback,
	restoreFeedbackView,
} from "./feedbackView";
import { captureInterviewView, resetInterviewView, restoreInterviewView } from "./interviewView";
import { capturePosition, forgetPlaces, restorePosition } from "./kept";
import { restoreKnowledge, savedKnowledge } from "./knowledgeView";
import { linearOpen, resetLinearView, restoreLinearView, savedLinear } from "./linearView";
import { restoreSlackReports, savedSlackReports, slackOpen } from "./slackView";
import { restoreModelDraft, savedModelDraft } from "./modelSettingsDraft";
import { flushAll } from "./planCommands";
import type { Plans } from "./planning";
import {
	capturePlanningDraft,
	pendingAnswers,
	planRoute,
	resetPlanningView,
	restorePlanningDraft,
	restorePlanningPlace,
} from "./planView";
import {
	capturePreferencesView,
	resetPreferencesView,
	restorePreferences,
	restoreSettingsPlace,
	settingsOpen,
} from "./preferencesView";
import { restoreProjectSetup, savedProjectSetup } from "./projectSetup";
import { restoreQuestionHelp, savedQuestionHelp } from "./QuestionHelp";
import { restoreRecoveryNotes, savedRecoveryNotes } from "./recoveryDraft";
import { captureRitualView, resetRitualView, restoreRitualView, ritualRoute } from "./ritualView";
import { restoreSlackDraft, savedSlackDraft } from "./slackDraft";
import { captureThreadView, forgetThreads, restoreThreadView, threadRoute } from "./threadView";
import { restoreTodayScope, todayProject } from "./todayScope";
import { resetUpdateView, restoreUpdateView, updateOpen } from "./updateView";
import {
	captureTodayView,
	resetTodayView,
	restoreMissionPlace,
	restoreTodayPosition,
	restoreTodayView,
	route,
} from "./view";

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
	if (slackOpen()) return "slack";
	const at = place();
	const thread = threadRoute();
	if (at.place === "mission" && thread?.missionId === at.id) return `thread/${thread.missionId}/${thread.topicId}`;
	return at.id ? `${at.place}/${at.id}` : at.place;
}

/** Captures local view state only. Every feature keeps ownership of its encoding. */
export function captureView(today?: Today): SavedView {
	const refused = feedbackCloseRefusal();
	if (refused) throw new Error(refused);
	const at = place();
	const key = shownKey();
	const planning = capturePlanningDraft();
	const interview = captureInterviewView();
	const todayView = captureTodayView();
	const ritual = captureRitualView(today);
	const position = capturePosition(key);
	const delivery = captureDeliveryView();
	const preferences = capturePreferencesView();
	const thread = captureThreadView();
	const feedback = captureFeedbackView();
	return {
		...at,
		update: updateOpen(),
		...planning,
		focused: todayView.focused,
		questions: interview.questions,
		...ritual,
		help: todayView.help,
		seeAll: interview.seeAll,
		deferredQuestions: interview.deferredQuestions,
		tab: captureChangesTab(),
		todayY: todayView.todayY,
		todayRow: todayView.todayRow,
		...position,
		...delivery,
		linear: savedLinear(),
		slackReports: savedSlackReports(),
		todayProject: todayProject() === "all" ? "" : todayProject(),
		...preferences,
		projectSetup: savedProjectSetup(),
		modelSettings: savedModelDraft(),
		diagnosis: savedDiagnosis(),
		connectionSettings: savedConnectionDraft(),
		slackSettings: savedSlackDraft(),
		databaseSettings: savedDatabaseDraft(),
		knowledge: savedKnowledge(),
		...thread,
		...feedback,
		questionHelp: savedQuestionHelp(),
		recoveryNotes: savedRecoveryNotes(),
	};
}

export type FormSave = { saved: true } | { saved: false; message: string };

/** Saves drafts before close or update. A refusal leaves the form in place. */
export async function saveForms(day: Day, plans?: Plans): Promise<FormSave> {
	const imageRefusal = feedbackCloseRefusal();
	if (imageRefusal) return { saved: false, message: imageRefusal };
	const refused = saveTodayForms(day);
	if (refused) {
		return {
			saved: false,
			message: `Pilot could not save your draft on “${refused}”. Its text stays on Today; nothing was paused or updated.`,
		};
	}
	if (plans) {
		await flushAll(plans);
		if (pendingAnswers() > 0) {
			return {
				saved: false,
				message:
					"Pilot could not save an interview answer. Its text stays on screen; nothing was paused or updated.",
			};
		}
	}
	return { saved: true };
}

/** A fresh window clears only the same view-local state as before. */
export function startFresh() {
	restoreRecoveryNotes([]);
	resetTodayView();
	resetPlanningView();
	resetInterviewView();
	resetChangesView();
	resetRitualView();
	resetDeliveryView();
	closeArtifacts();
	resetLinearView();
	restoreSlackReports("");
	restoreTodayScope();
	resetPreferencesView();
	restoreModelDraft("");
	restoreKnowledge("");
	forgetFeedback();
	closeChat();
	forgetThreads();
	restoreTodayPosition({ todayY: 0, todayRow: "" });
	forgetPlaces();
	resetUpdateView();
}

/** Restores drafts and disclosures without user intent. Changes may passively read. */
export function restoreView(view: SavedView, changes?: Changes, today?: Today, linear = false, settings = false) {
	restoreRecoveryNotes(view.recoveryNotes ?? []);
	restoreMissionPlace(view);
	restorePlanningPlace(view);
	restoreChangesView(view, changes);
	restorePlanningDraft(view);
	restoreTodayView(view);
	restoreInterviewView(view);
	restoreRitualView(view, today);
	restoreDeliveryView(view);
	closeArtifacts();
	restoreLinearView(view.linear, linear);
	restoreSlackReports(view.slackReports ?? "");
	restorePreferences(view.preferences ?? []);
	restoreProjectSetup(view.projectSetup ?? []);
	restoreModelDraft(view.modelSettings ?? "");
	restoreDiagnosis(view.diagnosis ?? "");
	restoreConnectionDraft(view.connectionSettings ?? "");
	restoreSlackDraft(view.slackSettings ?? "");
	restoreDatabaseDraft(view.databaseSettings ?? "");
	restoreKnowledge(view.knowledge ?? "");
	restoreSettingsPlace(view.settings, settings);
	restoreFeedbackView(view);
	restoreQuestionHelp(view.questionHelp ?? []);
	restoreThreadView(view);
	restoreTodayScope(view.todayProject);
	const todayY = restoreTodayPosition(view);
	restorePosition(shownKey(), view, todayY);
	restoreUpdateView(view.update);
}
