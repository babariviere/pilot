// Test-only mock feeds for the fixture entries (MockApp.tsx and the other
// scenarios the *.test.tsx files open). Every project, chat and ritual mark
// here is invented and saves nothing anywhere. The app's entry (App.tsx,
// which runs Connected.tsx) never imports this module. Importing it marks
// the window as mock data.
import { signal } from "nsh";
import type {
	ChangesScenario,
	ChatRow,
	IntentOutcome,
	PlanScenario,
	RitualSnapshot,
	RitualVisit,
	RitualWrite,
	Scenario,
	Today,
	UpdateScenario,
} from "pilot-day/native";
import { ChangesFeed, PlanFeed, TodayFeed, UpdateFeed } from "pilot-day/native";
import type { Changes } from "./changeFeed";
import { DEMO_PROJECTS, ScriptedChats } from "./chatDemo";
import { mirrorChats } from "./chatFeed";
import { DayScreen } from "./DayScreen";
import { type Day, mirrorDay } from "./day";
import { mirrorPlanning, type Plans } from "./planning";
import { mirrorRituals, NO_PROGRESS, RECAP_LIMIT, type Recap, type RitualSource, type Rituals } from "./ritualFeed";
import { mirrorSessionChat, type SessionChat, type SessionChatMirror, type SessionChatSource } from "./sessionChat";
import type { Update } from "./updateFeed";
import { dataSource } from "./view";

// Every window that uses these feeds says so in its header.
dataSource.set("mock");

/**
 * Any chat a mock page opens, read only: a few invented rows. A coordinator
 * chat (`c-<mission>`) works; other chats are done.
 */
class MockChat implements SessionChatSource {
	#chat: SessionChat | null = null;
	#listeners = new Set<(chat: SessionChat | null) => void>();
	chat() {
		return this.#chat;
	}
	onChange(listener: (chat: SessionChat | null) => void) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#set(chat: SessionChat | null) {
		this.#chat = chat;
		for (const l of this.#listeners) l(chat);
	}
	async open(sessionId: string) {
		const coordinator = sessionId.startsWith("c-");
		const row = (key: string, role: ChatRow["role"], text: string): ChatRow => ({
			key,
			role,
			text,
			shortened: false,
			running: false,
			failed: false,
		});
		this.#set({
			sessionId,
			title: coordinator ? "Mission coordinator" : "Mission chat",
			state: coordinator ? "working" : "done",
			stateReason: "",
			rows: [
				row("1", "you", "Keep the mission moving."),
				row("2", "pilot", coordinator ? "I am checking the open tasks." : "The task is done."),
				row("2.0", "step", "Read docs/missions.md"),
			],
			more: false,
			reading: false,
			reason: "",
		});
	}
	async earlier() {}
	async refresh() {}
	close(sessionId: string) {
		if (this.#chat?.sessionId === sessionId) this.#set(null);
	}
	dispose() {
		this.#listeners.clear();
	}
}

/** A mock chat page source: every chat opens read only with invented rows. */
export function openMockChat(): SessionChatMirror {
	return mirrorSessionChat(new MockChat());
}

/** Opens a mock Today feed from `scenario` and mirrors its read model. */
export function openDay(scenario?: Scenario): Day {
	return mirrorDay(new TodayFeed(scenario));
}

/** Opens a mock Changes feed from `scenario` and mirrors its list. */
export function openChanges(scenario?: ChangesScenario): Changes {
	const feed = new ChangesFeed(scenario);
	const list = signal(feed.snapshot());
	const stop = feed.onChange((next) => list.set(next));
	return {
		feed,
		list,
		close: () => {
			stop();
			feed.dispose();
		},
	};
}

/** Opens a mock update feed from `scenario` and mirrors its view. Nothing real registers, updates or restarts. */
export function openUpdate(scenario?: UpdateScenario): Update {
	const feed = new UpdateFeed(scenario);
	const service = signal(feed.snapshot());
	const stop = feed.onChange((next) => service.set(next));
	return {
		feed,
		service,
		close: () => {
			stop();
			feed.dispose();
		},
	};
}

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
