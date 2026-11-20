// Where the window's one Back goes, and Pilot's way home. The app is a
// tree: Today, then a mission's overview, then its interview and plan, a
// thread or a result; Changes, Linear, Artifacts, Settings, Feedback, New and the rituals hang off Today.
// Feedback opened from a mission lies over that mission, and a chat Pilot
// started lies over the screen it was opened from. Back goes up
// one level of that tree, Escape does the same, and Pilot at the top left
// always goes to Today. Moving around only changes where the user is: it
// never drops a draft, sends, saves or starts anything.
import { signal } from "nsh";
import { artifactsOpen, closeArtifacts, openArtifacts } from "../artifacts/artifactReads";
import type { Changes } from "../changes/changeFeed";
import { changesRoute, showChanges } from "../changes/changesView";
import { closeFeedback, feedbackOpen, openFeedback } from "../feedback/feedbackView";
import { closeInsights, insightsOpen } from "../insights/insightsView";
import {
	closeCodeReview,
	closeDelivery,
	codeReviewRoute,
	deliveryRoute,
	deliveryTitles,
	focusReviewCode,
	hideInspection,
} from "../missions/delivery/deliveryView";
import { scopedQuestion } from "../missions/interviews/ScopedQuestion";
import { type Plans, planningListShape } from "../missions/planning/planning";
import { closePlanning, openNew, openPlan, planRoute } from "../missions/planning/planView";
import { destinationProject, searchDetail } from "../search/workSearch";
import { chatRoute, closeChat } from "../sessions/chatView";
import { closeThread, threadRoute } from "../sessions/threadView";
import { closeSettings, openSettings, settingsOpen } from "../settings/preferencesView";
import { schedulesOpen } from "../settings/schedules/scheduleDraft";
import { closeLinear, linearOpen, openLinear } from "../sources/linear/linearView";
import { closeSlack, openSlack, slackOpen } from "../sources/slack/slackView";
import { backFromStandup, closeRitual, ritualRoute } from "../today/rituals/ritualView";
import { glide } from "../ui";
import { closeUpdate, updateEntry, updateOpen } from "../updates/updateView";
import type { Day } from "./day";
import { closeMission, openMission, route } from "./view";

/** What the window has: the screens that can show. */
export type Places = { day: Day; plans?: Plans; changes?: Changes };

/** One level up: what the button says, what screen readers hear, and where it goes. */
export type Back = { label: string; accessibilityLabel: string; go: () => void };

function to(label: string, go: () => void): Back {
	return { label, accessibilityLabel: `Back to ${label}`, go };
}

/** Whether Today's latest read lists mission `id`, so its overview has something to show. */
export function onToday(day: Day | undefined, id: string): boolean {
	const t = day?.today();
	return !!t && [...t.moving, ...t.notMoving, ...t.unreported].some((m) => m.id === id);
}

/**
 * One level up from mission `missionId`'s interview and plan: its overview
 * when Today's read has the mission, else Today.
 */
export function planBack(day: Day | undefined, missionId: string): Back {
	const route = planRoute();
	if (route?.kind === "plan" && route.missionId === missionId && route.fromInterviewProject)
		return to("Today", closePlanning);
	if (!onToday(day, missionId)) return to("Today", closePlanning);
	return to("Mission overview", () => {
		closePlanning();
		openMission(missionId);
	});
}

/** The kind of screen shown. */
export type Shown =
	| "update"
	| "search-detail"
	| "scoped-question"
	| "ritual"
	| "chat"
	| "settings"
	| "feedback"
	| "code-review"
	| "delivery"
	| "linear"
	| "slack"
	| "insights"
	| "artifacts"
	| "change"
	| "changes"
	| "new"
	| "plan"
	| "thread"
	| "mission"
	| "today";

/** Animates published planning-list changes only on the resolved Today screen. */
export function animatePlanningList(plans: Plans, at: () => Shown): () => void {
	let previous = planningListShape(plans.planning());
	return plans.feed.onChange((next) => {
		const shape = planningListShape(next);
		if (at() === "today" && shape !== previous) glide();
		previous = shape;
	});
}

/** Which screen the window shows now, in the same order `DayScreen` picks it. */
export function shown(places: Places): Shown {
	if (updateEntry() && updateOpen()) return "update";
	if (places.day.search && searchDetail()) return "search-detail";
	if (places.day.search && scopedQuestion()) return "scoped-question";
	if (ritualRoute()) return "ritual";
	if (places.day.chat && chatRoute()) return "chat";
	if (places.day.preferences && settingsOpen()) return "settings";
	if (places.day.feedback && feedbackOpen()) return "feedback";
	const delivery = places.day.delivery ? deliveryRoute() : null;
	if (delivery) return codeReviewRoute() === delivery.key ? "code-review" : "delivery";
	if (places.day.linear && linearOpen()) return "linear";
	if (places.day.slack && slackOpen()) return "slack";
	if (places.day.artifacts && artifactsOpen()) return "artifacts";
	const change = places.changes ? changesRoute() : null;
	if (change) return change.kind === "change" ? "change" : "changes";
	const plan = places.plans ? planRoute() : null;
	if (plan) return plan.kind;
	if (places.day.insights && insightsOpen()) return "insights";
	const mission = route();
	if (mission && places.day.threads && threadRoute()?.missionId === mission) return "thread";
	if (mission) return "mission";
	return "today";
}

/** Where Back goes from the screen shown, or null on Today. */
export function backTarget(places: Places): Back | null {
	const jump = jumpBack(places);
	if (jump) return jump;
	switch (shown(places)) {
		case "update":
			// The update page lies over whichever screen was open.
			return { label: "Back", accessibilityLabel: "Back", go: closeUpdate };
		case "search-detail":
			return to("Today", () => searchDetail.set(null));
		case "scoped-question":
			return to("Today", () => scopedQuestion.set(null));
		case "ritual": {
			const at = ritualRoute();
			if (at?.kind === "standup" && at.from) {
				return to(at.from === "start" ? "Start of day" : "End of day", backFromStandup);
			}
			return to("Today", closeRitual);
		}
		case "chat":
			// A chat lies over the screen it was opened from.
			return to(chatRoute()?.from || "Today", closeChat);
		case "settings":
			if (schedulesOpen()) return to("Settings", () => schedulesOpen.set(false));
			return to("Today", closeSettings);
		case "feedback": {
			// Feedback lies over the mission it was opened from, or over Today.
			const id = route();
			return id
				? to(places.day.feed.mission(id)?.row.title || "Mission overview", closeFeedback)
				: to("Today", closeFeedback);
		}
		case "code-review": {
			// Review code lies over its result's page.
			const place = deliveryRoute();
			return to(place?.title || (place ? deliveryTitles()[place.key] : "") || "Result", closeCodeReview);
		}
		case "delivery": {
			const id = route();
			if (!id) return to("Today", closeDelivery);
			return to(places.day.feed.mission(id)?.row.title || "Mission overview", closeDelivery);
		}
		case "linear":
			return to("Today", closeLinear);
		case "slack":
			return to("Today", closeSlack);
		case "insights":
			return to("Today", closeInsights);
		case "artifacts":
			return to("Today", closeArtifacts);
		case "change":
			return to("Changes", () => changesRoute.set({ kind: "list" }));
		case "changes":
			return to("Today", () => changesRoute.set(null));
		case "new":
			return to(insightsOpen() ? "Insights" : "Today", closePlanning);
		case "plan": {
			const plan = planRoute();
			return plan?.kind === "plan" ? planBack(places.day, plan.missionId) : to("Today", closePlanning);
		}
		case "thread": {
			const id = route() ?? "";
			return to(places.day.feed.mission(id)?.row.title || "Mission overview", closeThread);
		}
		case "mission":
			return to("Today", closeMission);
		case "today":
			return null;
	}
}

/**
 * Today, from anywhere: every other screen closes. Drafts, answers, notes
 * and Today's place stay; an open confirmation is put away, not answered.
 */
function closePlaces() {
	searchDetail.set(null);
	scopedQuestion.set(null);
	destinationProject.set("");
	closeSlack();
	closeInsights();
	schedulesOpen.set(false);
	closeUpdate();
	closeRitual();
	closeChat();
	closeSettings();
	closeFeedback();
	hideInspection();
	if (deliveryRoute()) closeDelivery();
	if (linearOpen()) closeLinear();
	closeArtifacts();
	changesRoute.set(null);
	closePlanning();
	closeMission();
}

export function goHome() {
	if (navigationRestoring()) return;
	navigationError.set("");
	returns.set([]);
	closePlaces();
}

const returns = signal<{ destination: string; back: Back }[]>([]);
export const navigationError = signal("");
export const navigationRestoring = signal(false);

function location(places: Places): string {
	return JSON.stringify([
		shown(places),
		route(),
		planRoute(),
		chatRoute()?.sessionId,
		deliveryRoute()?.key,
		codeReviewRoute(),
		threadRoute()?.topicId,
		changesRoute(),
		ritualRoute(),
		schedulesOpen(),
		searchDetail()?.key,
		scopedQuestion()?.decisionId,
	]);
}

export function jumpBack(places: Places): Back | null {
	const last = returns().at(-1);
	return last?.destination === location(places) ? last.back : null;
}

/** A palette jump keeps the previous locations, but never snapshots or rewinds drafts. */
export function jump(places: Places, open: () => void) {
	if (navigationRestoring()) return;
	const from = location(places);
	const source = places.day.search;
	// Enqueue before the new page can enqueue its own reads or change focus.
	const priorProject = source?.project?.();
	const history = returns();
	const screen = shown(places);
	const mission = route();
	const plan = planRoute();
	const chat = chatRoute();
	const delivery = deliveryRoute();
	const codeReview = codeReviewRoute();
	const thread = threadRoute();
	const change = changesRoute();
	const ritual = ritualRoute();
	const settings = settingsOpen();
	const schedules = schedulesOpen();
	const feedback = feedbackOpen();
	const linear = linearOpen();
	const slack = slackOpen();
	const insights = insightsOpen();
	const artifacts = artifactsOpen();
	const update = updateOpen();
	const detail = searchDetail();
	const question = scopedQuestion();
	const project = destinationProject();
	open();
	const destination = location(places);
	if (destination === from) {
		returns.set(history);
		return;
	}
	const label = {
		today: "Today",
		new: "New",
		mission: "Mission overview",
		plan: "Plan",
		chat: "Chat",
		delivery: "Result",
		"code-review": "Review code",
		thread: "Discussion",
		settings: "Settings",
		feedback: "Feedback",
		linear: "Linear issues",
		slack: "Slack reports",
		insights: "Insights",
		artifacts: "Artifacts",
		update: "Update",
		changes: "Changes",
		change: "Change",
		ritual: "Daily notes",
		"search-detail": "Saved item",
		"scoped-question": "Agent question",
	}[screen];
	returns.set([
		...history,
		{
			destination,
			back: to(label, async () => {
				if (navigationRestoring()) return;
				if (priorProject && source?.restoreProject) {
					navigationRestoring.set(true);
					const selected = await priorProject;
					const ok = selected !== undefined && (await source.restoreProject(selected));
					navigationRestoring.set(false);
					if (returns().at(-1)?.destination !== destination || location(places) !== destination) return;
					if (!ok) {
						navigationError.set("Pilot could not restore the previous project. Your draft is kept.");
						return;
					}
				}
				navigationError.set("");
				// Leaving Review code for its own result page gives Review code the focus, as Back does.
				const leaving = codeReviewRoute();
				closePlaces();
				route.set(mission);
				planRoute.set(plan);
				chatRoute.set(chat);
				deliveryRoute.set(delivery);
				codeReviewRoute.set(codeReview);
				if (leaving && leaving === delivery?.key && codeReview !== leaving) focusReviewCode.set(leaving);
				threadRoute.set(thread);
				changesRoute.set(change);
				ritualRoute.set(ritual);
				settingsOpen.set(settings);
				schedulesOpen.set(schedules);
				feedbackOpen.set(feedback);
				linearOpen.set(linear);
				slackOpen.set(slack);
				insightsOpen.set(insights);
				artifactsOpen.set(artifacts);
				updateOpen.set(update);
				searchDetail.set(detail);
				scopedQuestion.set(question);
				destinationProject.set(project);
				returns.set(history);
			}),
		},
	]);
}

// The places every screen can reach. Each goes home first, so its Back
// goes to Today. Drafts stay where they are; opening a place only reads.

/** Opens New from wherever the user is. It never picks a project. */
export function goNew() {
	goHome();
	openNew();
}

/** Opens Changes from wherever the user is. */
export function goChanges() {
	goHome();
	showChanges();
}

/** Opens Settings from wherever the user is, at `target` when given. */
export function goSettings(target?: import("../settings/preferencesView").SettingsTarget) {
	goHome();
	openSettings(target);
}

/** Opens Feedback about Pilot in general from wherever the user is. Opening it sends nothing. */
export function goFeedback() {
	goHome();
	openFeedback(null);
}

/** Opens the project's Artifacts from wherever the user is. */
export function goArtifacts() {
	goHome();
	openArtifacts();
}

/** Opens the read-only Linear page from wherever the user is. */
export function goLinear() {
	goHome();
	openLinear();
}

/** Opens the Slack reports page from wherever the user is. Opening it only reads. */
export function goSlack() {
	goHome();
	openSlack();
}

/** Opens mission `id`'s overview from wherever the user is. */
export function goMission(id: string) {
	goHome();
	openMission(id);
}

/** Opens mission `id`'s interview and plan from wherever the user is. Answering and approving stay there. */
export function goPlan(id: string) {
	goHome();
	openPlan(id);
}

/** Opens scheduled work without starting it. */
export function goSchedules() {
	goHome();
	openSettings();
	schedulesOpen.set(true);
}

/** Opens Insights without reading source chats or starting a report. */
export function goInsights() {
	goHome();
	insightsOpen.set(true);
}
