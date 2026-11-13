// Test-only mock feeds for the fixture entries (MockApp.tsx and the other
// scenarios the *.test.tsx files open). Every project, chat and ritual mark
// here is invented and saves nothing anywhere. The app's entry (App.tsx,
// which runs Connected.tsx) never imports this module.
import type { IntentOutcome, PlanScenario, RitualSnapshot, RitualVisit, RitualWrite, Today } from "pilot-day/native";
import { PlanFeed } from "pilot-day/native";
import type { Changes } from "./changeFeed";
import { DEMO_PROJECTS, ScriptedChats } from "./chatDemo";
import { mirrorChats } from "./chatFeed";
import { DayScreen } from "./DayScreen";
import type { Day } from "./day";
import { mirrorPlanning, type Plans } from "./planning";
import { mirrorRituals, NO_PROGRESS, RECAP_LIMIT, type Recap, type RitualSource, type Rituals } from "./ritualFeed";
import type { Update } from "./updateFeed";

/**
 * Opens a mock planning feed from `scenario` and mirrors its read model.
 * Its New offers invented demo projects; a demo chat is only a counter.
 */
export function openPlanning(scenario?: PlanScenario): Plans {
	const feed = new PlanFeed(scenario);
	const off = () => {
		const now = feed.snapshot();
		return now.canStart ? "" : now.startReason || "Starting a chat is not available here.";
	};
	return mirrorPlanning(feed, mirrorChats(new ScriptedChats(DEMO_PROJECTS, DEMO_PROJECTS[0].projectId, off)));
}

/** Results from Today's mock read, as the mock entries show them. */
function todayRecap(today: Today): Recap {
	return {
		state: "live",
		entries: today.done.slice(0, RECAP_LIMIT),
		more: Math.max(0, today.done.length - RECAP_LIMIT) + today.doneHidden,
		limited: false,
	};
}

/**
 * The mock entries' stand-in: marks in memory for this run, keyed by the
 * mock Today's date. It has the root's rules (exact context and revision,
 * final marks stay) but saves nothing anywhere. Mock data, never proof.
 */
class MockRituals implements RitualSource {
	#day: Day;
	#revision = 0;
	#marks = new Map<string, { start: RitualSnapshot["start"]; end: RitualSnapshot["end"] }>();
	#listeners = new Map<number, (view: RitualSnapshot) => void>();
	#next = 0;

	constructor(day: Day) {
		this.#day = day;
	}

	snapshot(): RitualSnapshot {
		const today = this.#day.feed.snapshot();
		const marks = this.#marks.get(today.date);
		return {
			...NO_PROGRESS,
			availability: "available",
			context: `mock/${today.date}`,
			revision: this.#revision,
			date: today.date,
			part: today.part,
			visit: today.visit,
			start: marks?.start ?? NO_PROGRESS.start,
			end: marks?.end ?? NO_PROGRESS.end,
			resultsAvailability: "available",
		};
	}

	onChange(listener: (view: RitualSnapshot) => void): () => void {
		const id = this.#next++;
		this.#listeners.set(id, listener);
		return () => {
			this.#listeners.delete(id);
		};
	}

	#accepted(): IntentOutcome {
		const view = this.snapshot();
		for (const listener of this.#listeners.values()) listener(view);
		return { status: "accepted", revision: this.#revision, message: "" };
	}

	refresh(): Promise<IntentOutcome> {
		return Promise.resolve(this.#accepted());
	}

	refreshResults(): Promise<IntentOutcome> {
		return Promise.resolve(this.#accepted());
	}

	visit(intent: RitualVisit): Promise<IntentOutcome> {
		const now = this.snapshot();
		if (intent.context !== now.context || intent.revision !== now.revision) return this.#stale();
		this.#revision += 1;
		return Promise.resolve(this.#accepted());
	}

	save(intent: RitualWrite): Promise<IntentOutcome> {
		const now = this.snapshot();
		const before = now[intent.ritual];
		if (intent.context !== now.context || intent.revision !== now.revision || before.mark !== "unmarked") {
			return this.#stale();
		}
		const marks = { start: now.start, end: now.end };
		marks[intent.ritual] = { mark: intent.mark, step: intent.step };
		this.#marks.set(now.date, marks);
		this.#revision += 1;
		return Promise.resolve(this.#accepted());
	}

	#stale(): Promise<IntentOutcome> {
		return Promise.resolve({ status: "stale", revision: this.#revision, message: "" });
	}

	dispose(): void {
		this.#listeners.clear();
	}
}

/** The mock entries' ritual progress, from `day`'s mock Today. */
export function mockRituals(day: Day): Rituals {
	return mirrorRituals(new MockRituals(day), (today) => todayRecap(today));
}

/** The app's one window over mock feeds, with in-memory ritual progress. */
export function MockDayScreen(props: { day: Day; plans?: Plans; changes?: Changes; update?: Update }) {
	return (
		<DayScreen
			day={props.day}
			plans={props.plans}
			changes={props.changes}
			update={props.update}
			rituals={mockRituals(props.day)}
		/>
	);
}
