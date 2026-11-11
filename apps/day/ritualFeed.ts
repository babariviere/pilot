// Saved start and end of day progress. A mirror of the ritual view the
// native root last confirmed, and the only way to save a step, Done or Skip,
// or that the user saw Today. A connected window uses its root's ritual calls
// (bridge.ts): Rust samples the clock, checks the exact context and revision,
// and writes the local journal. Mock entries use an in-memory stand-in that
// saves nothing anywhere. Escape never saves. A write whose answer is lost or
// Unknown is never sent again; only Read again (a passive read) settles it.
import { type Signal, signal } from "nsh";
import type {
	DoneEntry,
	IntentOutcome,
	RitualFeed,
	RitualKind,
	RitualMark,
	RitualSnapshot,
	RitualVisit,
	RitualWrite,
	Today,
} from "pilot-day/native";
import type { Day } from "./day";

/** How many results a ritual lists. Today lists the rest. */
export const RECAP_LIMIT = 5;

/** What a ritual source must do, mock or connected: the native feed's own shape. */
export type RitualSource = Pick<
	RitualFeed,
	"snapshot" | "onChange" | "refresh" | "refreshResults" | "visit" | "save" | "dispose"
>;

/**
 * The results a recap may list. "off" when they could not be read: that is
 * never the same as none. `limited` says the read covered only the newest
 * kept changes.
 */
export type Recap = { state: "live"; entries: DoneEntry[]; more: number; limited: boolean } | { state: "off" };

/** The window's ritual progress, as the screens use it. */
export type Rituals = {
	/** A mirror of the last confirmed ritual view. Only the source's listener sets it. */
	progress: Signal<RitualSnapshot>;
	/**
	 * A write whose answer was lost or Unknown. Nothing is sent again; Today
	 * offers no ritual until a confirmed read settles it.
	 */
	uncertain: Signal<boolean>;
	/** The last refusal, in one calm sentence. Empty when there is none. */
	message: Signal<string>;
	/** Whether Done or Skip waits for its answer. */
	saving: Signal<boolean>;
	/** The results the recap lists. */
	recap(today: Today): Recap;
	/** Passive read with a fresh clock sample. It writes nothing. */
	refresh(): Promise<void>;
	/** Passive read of the results the recap lists. It writes nothing. */
	readResults(): Promise<void>;
	/** Records that the user saw Today, once for each day context. */
	visit(): Promise<void>;
	/**
	 * Saves one explicit choice for the day `context` the ritual opened on:
	 * a resume step (`unmarked`), Done or Skip. Resolves true only once saved.
	 */
	save(ritual: RitualKind, mark: RitualMark, step: number, context: string): Promise<boolean>;
	/** Stops listening and frees the source. */
	close(): void;
};

/** A view that confirms nothing: before the first read, or with no source. */
export const NO_PROGRESS: RitualSnapshot = {
	availability: "unavailable",
	context: "",
	revision: 0,
	date: "",
	timeZone: "",
	part: "unknown",
	visit: "unknown",
	lastLookedAt: "",
	start: { mark: "unmarked", step: 0 },
	end: { mark: "unmarked", step: 0 },
	resultsAvailability: "unavailable",
	results: [],
	resultsLimited: false,
};

const UNCONFIRMED = "Pilot could not confirm this was saved. It will not save it again; Read again checks.";

function words(outcome: IntentOutcome): string {
	switch (outcome.status) {
		case "accepted":
			return "";
		case "unknown":
			return UNCONFIRMED;
		case "stale":
			return "This changed since Pilot read it. Nothing was saved.";
		default:
			return outcome.message || "Pilot could not save this. Nothing was saved.";
	}
}

/**
 * Mirrors `source`. Every write waits for the one before it, so each sends
 * the last confirmed revision. `recap` says where the results come from.
 */
export function mirrorRituals(source: RitualSource, recap: (today: Today, progress: RitualSnapshot) => Recap): Rituals {
	const progress = signal(source.snapshot());
	const uncertain = signal(false);
	const message = signal("");
	const saving = signal(false);
	const stop = source.onChange((next) => progress.set(next));
	/** Day contexts whose visit was sent. A visit is never sent twice for one. */
	const visited = new Set<string>();
	let writes: Promise<unknown> = Promise.resolve();
	let closed = false;

	/** Runs `write` after every earlier write answered. Nothing runs after a lost answer. */
	const queue = <T>(write: () => Promise<T>, otherwise: T): Promise<T> => {
		const run = writes.then(() => (closed || uncertain() ? otherwise : write()));
		writes = run.catch(() => undefined);
		return run;
	};

	return {
		progress,
		uncertain,
		message,
		saving,
		recap: (today) => recap(today, progress()),
		async refresh() {
			const outcome = await source.refresh();
			progress.set(source.snapshot());
			// Only a confirmed read settles a write whose answer was lost.
			if (outcome.status === "accepted" && source.snapshot().availability === "available") {
				uncertain.set(false);
				message.set("");
			}
		},
		async readResults() {
			await source.refreshResults();
			progress.set(source.snapshot());
		},
		visit() {
			return queue(async () => {
				const now = source.snapshot();
				if (now.availability !== "available" || !now.context || visited.has(now.context)) return;
				visited.add(now.context);
				const intent: RitualVisit = { context: now.context, revision: now.revision };
				const outcome = await source.visit(intent);
				// A newer read moved the revision first: the next presentation sends
				// it once more. A lost or Unknown visit is never sent again.
				if (outcome.status === "stale") visited.delete(now.context);
			}, undefined);
		},
		save(ritual, mark, step, context) {
			if (uncertain()) {
				message.set(UNCONFIRMED);
				return Promise.resolve(false);
			}
			const final = mark !== "unmarked";
			if (final) saving.set(true);
			return queue(async () => {
				const intent: RitualWrite = { context, revision: source.snapshot().revision, ritual, mark, step };
				const outcome = await source.save(intent);
				progress.set(source.snapshot());
				if (outcome.status === "unknown") uncertain.set(true);
				// A refused resume step says nothing: the screen still shows where the user is.
				if (final || outcome.status === "unknown") message.set(words(outcome));
				return outcome.status === "accepted";
			}, false).finally(() => {
				if (final) saving.set(false);
			});
		},
		close() {
			closed = true;
			stop();
			source.dispose();
		},
	};
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

/** Results from the root's ritual read: kept-change evidence only, or "off". */
export function rootRecap(_today: Today, progress: RitualSnapshot): Recap {
	if (progress.resultsAvailability !== "available") return { state: "off" };
	return {
		state: "live",
		entries: progress.results.slice(0, RECAP_LIMIT),
		more: Math.max(0, progress.results.length - RECAP_LIMIT),
		limited: progress.resultsLimited,
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
