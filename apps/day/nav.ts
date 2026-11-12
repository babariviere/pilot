// Where the window's one Back goes, and Pilot's way home. The app is a
// tree: Today, then a mission's overview, then its interview and plan or a
// result; Changes, Linear, New and the rituals hang off Today. Back goes up
// one level of that tree, Escape does the same, and Pilot at the top left
// always goes to Today. Moving around only changes where the user is: it
// never drops a draft, sends, saves or starts anything.
import type { Changes } from "./changeFeed";
import { changesRoute } from "./changesView";
import type { Day } from "./day";
import { closeDelivery, deliveryRoute, hideInspection } from "./deliveryView";
import { closeLinear, linearOpen } from "./linearView";
import type { Plans } from "./planning";
import { closePlanning, planRoute } from "./planView";
import { backFromStandup, closeRitual, ritualRoute } from "./ritualView";
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
	| "delivery"
	| "linear"
	| "change"
	| "changes"
	| "new"
	| "plan"
	| "mission"
	| "today";

/** Which screen the window shows now, in the same order `DayScreen` picks it. */
export function shown(places: Places): Shown {
	if (updateEntry() && updateOpen()) return "update";
	if (ritualRoute()) return "ritual";
	if (places.day.delivery && deliveryRoute()) return "delivery";
	if (places.day.linear && linearOpen()) return "linear";
	const change = places.changes ? changesRoute() : null;
	if (change) return change.kind === "change" ? "change" : "changes";
	const plan = places.plans ? planRoute() : null;
	if (plan) return plan.kind;
	if (route()) return "mission";
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
		case "delivery": {
			const id = route();
			if (!id) return to("Today", closeDelivery);
			return to(places.day.feed.mission(id)?.row.title || "Mission overview", closeDelivery);
		}
		case "linear":
			return to("Today", closeLinear);
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
	hideInspection();
	if (deliveryRoute()) closeDelivery();
	if (linearOpen()) closeLinear();
	changesRoute.set(null);
	closePlanning();
	closeMission();
}
