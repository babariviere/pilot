// What the screens need from a feed, and nothing more. The mock feeds
// (TodayFeed, PlanFeed) and the connected adapters (bridge.ts) both fit
// these shapes, so the screens never know which one they talk to.
import type { PlanFeed, TodayFeed } from "pilot-day/native";

/** Today's reads and intents, as the screens use them. */
export type DayFeed = Pick<
	TodayFeed,
	| "snapshot"
	| "onChange"
	| "mission"
	| "openMission"
	| "decide"
	| "reply"
	| "saveDraft"
	| "flushDrafts"
	| "openLink"
	| "later"
	| "check"
	| "ask"
	| "checkAnswer"
	| "saveProgress"
	| "actionLater"
	| "complete"
	| "checkAction"
	| "pause"
	| "resume"
	| "checkControl"
	| "pulse"
	| "dispose"
>;

/** Planning's reads and intents, as the screens use them. */
export type PlanningFeed = Pick<
	PlanFeed,
	"snapshot" | "onChange" | "page" | "open" | "plan" | "start" | "saveAnswer" | "submit" | "checkSubmit" | "dispose"
>;
