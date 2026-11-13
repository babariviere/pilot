// What the screens need from a feed, and nothing more. The mock feeds
// (TodayFeed, PlanFeed) and the connected adapters (bridge.ts) both fit
// these shapes, so the screens never know which one they talk to.
import type { PlanFeed, PlanOutcome, PlanPage, TodayFeed } from "pilot-day/native";
import type { MapSourceRead, MapSourceRequest } from "./mapSourceContract";

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

/**
 * Planning's reads and intents, as the screens use them. A connected feed
 * can also read the missions in planning again (Read again), which is
 * passive, and says whether reading again could help.
 */
export type PlanningFeed = Pick<
	PlanFeed,
	"snapshot" | "onChange" | "page" | "open" | "plan" | "start" | "saveAnswer" | "submit" | "checkSubmit" | "dispose"
> & {
	readInventory?: () => Promise<void>;
	/** Passive canonical source read. Missing support is unavailable, never an empty record. */
	readSource?: (request: MapSourceRequest) => Promise<MapSourceRead>;
	canReadInventory?: () => boolean;
	prepareNew?: () => Promise<PlanOutcome>;
	checkNew?: () => Promise<PlanOutcome>;
	canCheckNew?: () => boolean;
	startWork?: (
		missionId: string,
		shown: Pick<NonNullable<PlanPage["work"]>, "revision" | "digest" | "taskId" | "context">,
	) => Promise<PlanOutcome>;
	checkWork?: (missionId: string) => Promise<PlanOutcome>;
} & Partial<Pick<PlanFeed, "revisit" | "confirmRevision" | "checkRevision">>;
