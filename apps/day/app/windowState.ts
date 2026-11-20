// The fixed SavedView wire composition and ordered window restore.
// Feature owners encode their own drafts, disclosure state and reset rules.
import type { PlaceKind, SavedView, Today } from "pilot-day/native";
import { closeArtifacts } from "../artifacts/artifactReads";
import type { Changes } from "../changes/changeFeed";
import { captureChangesTab, changesRoute, resetChangesView, restoreChangesView } from "../changes/changesView";
import {
	captureFeedbackView,
	feedbackCloseRefusal,
	feedbackOpen,
	forgetFeedback,
	restoreFeedbackView,
} from "../feedback/feedbackView";
import {
	captureDeliveryView,
	deliveryRoute,
	resetDeliveryView,
	restoreDeliveryView,
} from "../missions/delivery/deliveryView";
import { captureInterviewView, resetInterviewView, restoreInterviewView } from "../missions/interviews/interviewView";
import { restoreQuestionHelp, savedQuestionHelp } from "../missions/interviews/QuestionHelp";
import { flushAll } from "../missions/planning/planCommands";
import type { Plans } from "../missions/planning/planning";
import {
	capturePlanningDraft,
	pendingAnswers,
	planRoute,
	resetPlanningView,
	restorePlanningDraft,
	restorePlanningPlace,
} from "../missions/planning/planView";
import { closeChat } from "../sessions/chatView";
import { restoreRecoveryNotes, savedRecoveryNotes } from "../sessions/recovery/recoveryDraft";
import { captureThreadView, forgetThreads, restoreThreadView, threadRoute } from "../sessions/threadView";
import { restoreConnectionDraft, savedConnectionDraft } from "../settings/connections/connectionDraft";
import { restoreSlackDraft, savedSlackDraft } from "../settings/connections/slackDraft";
import { restoreDiagnosis, savedDiagnosis } from "../settings/diagnostics/diagnosisDraft";
import { restoreModelDraft, savedModelDraft } from "../settings/models/modelSettingsDraft";
import {
	capturePreferencesView,
	resetPreferencesView,
	restorePreferences,
	restoreSettingsPlace,
	settingsOpen,
} from "../settings/preferencesView";
import { restoreKnowledge, savedKnowledge } from "../settings/projects/knowledgeView";
import { restoreProjectSetup, savedProjectSetup } from "../settings/projects/projectSetup";
import { restoreSchedules, savedSchedules } from "../settings/schedules/scheduleDraft";
import { linearOpen, resetLinearView, restoreLinearView, savedLinear } from "../sources/linear/linearView";
import { restoreSlackReports, savedSlackReports, slackOpen } from "../sources/slack/slackView";
import { saveTodayForms } from "../today/commands";
import { captureRitualView, resetRitualView, restoreRitualView, ritualRoute } from "../today/rituals/ritualView";
import { restoreTodayScope, todayProject } from "../today/todayScope";
import { resetUpdateView, restoreUpdateView, updateOpen } from "../updates/updateView";
import type { Day } from "./day";
import { capturePosition, forgetPlaces, restorePosition } from "./kept";
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
		scheduleSettings: savedSchedules(),
		connectionSettings: savedConnectionDraft(),
		slackSettings: savedSlackDraft(),
		insightsDraft: savedInsightsDraft(),
		insightsWork: savedFindingWork(),
		knowledge: savedKnowledge(),
		...thread,
		...feedback,
		questionHelp: savedQuestionHelp(),
		recoveryNotes: savedRecoveryNotes(),
		scopedDrafts: captureScopedDrafts(),
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
	restoreInsightsDraft();
	restoreFindingWork();
	restoreScopedDrafts();
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
	restoreScopedDrafts(view.scopedDrafts);
	restoreRecoveryNotes(view.recoveryNotes ?? []);
	restoreMissionPlace(view);
	restorePlanningPlace(view);
	restoreChangesView(view, changes);
	restorePlanningDraft(view);
	restoreFindingWork(view.insightsWork);
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
	restoreSchedules(view.scheduleSettings ?? "");
	restoreConnectionDraft(view.connectionSettings ?? "");
	restoreSlackDraft(view.slackSettings ?? "");
	restoreInsightsDraft(view.insightsDraft);
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

import { restoreInsightsDraft, savedInsightsDraft } from "../insights/insightsView";
import { restoreFindingWork, savedFindingWork } from "../insights/insightsWork";
import { captureScopedDrafts, restoreScopedDrafts } from "../missions/interviews/ScopedQuestion";
