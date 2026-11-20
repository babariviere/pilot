// The Today and Planning interfaces for the connected adapters and native-backed fixtures.
import type { PlanFeed, PlanOutcome, PlanPage, TodayFeed } from "pilot-day/native";
import type { MigrationIntent, MigrationView } from "../updates/migration";
import type { MapSourceRead, MapSourceRequest } from "./map/mapSourceContract";

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
	| "stopReplanning"
	| "archive"
	| "reopen"
	| "rename"
	| "pulse"
	| "dispose"
> & { migration?: (intent: MigrationIntent) => Promise<MigrationView> };

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
	/** Reads the open planning page from its service now: the old-data warning's Try now. */
	readNow?: () => Promise<void>;
	/** Whether this mission has a current planning read, without the usual stale-display grace period. */
	readConfirmed?: (missionId: string) => boolean;
	/** The window came back: reads the open planning page, at most every 30 s. */
	focusRead?: () => void;
	/** Passive canonical source read. Missing support is unavailable, never an empty record. */
	readSource?: (request: MapSourceRequest) => Promise<MapSourceRead>;
	canReadInventory?: () => boolean;
	prepareNew?: () => Promise<PlanOutcome>;
	checkNew?: (operationId?: string) => Promise<PlanOutcome>;
	canCheckNew?: () => boolean;
	startWork?: (
		missionId: string,
		shown: Pick<NonNullable<PlanPage["work"]>, "revision" | "digest" | "taskId" | "context">,
	) => Promise<PlanOutcome>;
	checkWork?: (missionId: string) => Promise<PlanOutcome>;
} & Partial<
		Pick<
			PlanFeed,
			| "revisit"
			| "continuePlanning"
			| "askQuestion"
			| "dropEarlierAnswers"
			| "repairStart"
			| "repairApply"
			| "confirmRevision"
			| "pauseRevision"
			| "resumeRevision"
			| "checkRevision"
			| "chat"
			| "readChat"
			| "closeChat"
			| "leave"
		>
	>;
