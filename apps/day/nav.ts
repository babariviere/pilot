// Where the window's one Back goes, and Pilot's way home. The app is a
// tree: Today, then a mission's overview, then its interview and plan, a
// thread or a result; Changes, Linear, Artifacts, Settings, Feedback, New and the rituals hang off Today.
// Feedback opened from a mission lies over that mission. Back goes up
// one level of that tree, Escape does the same, and Pilot at the top left
// always goes to Today. Moving around only changes where the user is: it
// never drops a draft, sends, saves or starts anything.
import { artifactsOpen, closeArtifacts, openArtifacts } from "./artifactReads";
import type { Changes } from "./changeFeed";
import { changesRoute, showChanges } from "./changesView";
import type { Day } from "./day";
import { closeDelivery, deliveryRoute, hideInspection } from "./deliveryView";
import { closeFeedback, feedbackOpen, openFeedback } from "./feedbackView";
import { closeLinear, linearOpen, openLinear } from "./linearView";
import type { Plans } from "./planning";
import { closePlanning, openNew, openPlan, planRoute } from "./planView";
import { closeSettings, openSettings, settingsOpen } from "./preferencesView";
import { backFromStandup, closeRitual, ritualRoute } from "./ritualView";
import { closeThread, threadRoute } from "./threadView";
import { closeUpdate, updateEntry, updateOpen } from "./updateView";
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
	if (!onToday(day, missionId)) return to("Today", closePlanning);
	return to("Mission overview", () => {
		closePlanning();
		openMission(missionId);
	});
}

/** The kind of screen shown. */
export type Shown =
	| "update"
	| "ritual"
	| "settings"
	| "feedback"
	| "delivery"
	| "linear"
	| "artifacts"
	| "change"
	| "changes"
	| "new"
	| "plan"
	| "thread"
	| "mission"
	| "today";

/** Which screen the window shows now, in the same order `DayScreen` picks it. */
export function shown(places: Places): Shown {
	if (updateEntry() && updateOpen()) return "update";
	if (ritualRoute()) return "ritual";
	if (places.day.preferences && settingsOpen()) return "settings";
	if (places.day.feedback && feedbackOpen()) return "feedback";
	if (places.day.delivery && deliveryRoute()) return "delivery";
	if (places.day.linear && linearOpen()) return "linear";
	if (places.day.artifacts && artifactsOpen()) return "artifacts";
	const change = places.changes ? changesRoute() : null;
	if (change) return change.kind === "change" ? "change" : "changes";
	const plan = places.plans ? planRoute() : null;
	if (plan) return plan.kind;
	const mission = route();
	if (mission && places.day.threads && threadRoute()?.missionId === mission) return "thread";
	if (mission) return "mission";
	return "today";
}

/** Where Back goes from the screen shown, or null on Today. */
export function backTarget(places: Places): Back | null {
	switch (shown(places)) {
		case "update":
			// The update page lies over whichever screen was open.
			return { label: "Back", accessibilityLabel: "Back", go: closeUpdate };
		case "ritual": {
			const at = ritualRoute();
			if (at?.kind === "standup" && at.from) {
				return to(at.from === "start" ? "Start of day" : "End of day", backFromStandup);
			}
			return to("Today", closeRitual);
		}
		case "settings":
			return to("Today", closeSettings);
		case "feedback": {
			// Feedback lies over the mission it was opened from, or over Today.
			const id = route();
			return id
				? to(places.day.feed.mission(id)?.row.title || "Mission overview", closeFeedback)
				: to("Today", closeFeedback);
		}
		case "delivery": {
			const id = route();
			if (!id) return to("Today", closeDelivery);
			return to(places.day.feed.mission(id)?.row.title || "Mission overview", closeDelivery);
		}
		case "linear":
			return to("Today", closeLinear);
		case "artifacts":
			return to("Today", closeArtifacts);
		case "change":
			return to("Changes", () => changesRoute.set({ kind: "list" }));
		case "changes":
			return to("Today", () => changesRoute.set(null));
		case "new":
			return to("Today", closePlanning);
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
export function goHome() {
	closeUpdate();
	closeRitual();
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

/** Opens Settings from wherever the user is. */
export function goSettings() {
	goHome();
	openSettings();
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
