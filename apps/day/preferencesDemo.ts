// Demo project preferences. No daemon, journal, storage or provider: one
// project's list in memory. `mode` picks what a read returns and `next`
// what the next Save does, so a test can show a conflict, a lost answer or a
// refusal. `saves` and `checks` count calls, to prove nothing is resent.
import { signal } from "nsh";
import {
	type PreferencesSource,
	type PreferencesView,
	type ProjectPreference,
	type ProjectPreferences,
	preferencesReason,
	type SaveIntent,
	type SaveResult,
	UNKNOWN_SAVE,
} from "./preferencesFeed";

export type PreferencesDemoMode = "saved" | "empty" | "unreadable";
export type PreferencesDemoNext = "accept" | "stale" | "unknown" | "reject";

const PROJECT = "mock-project";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

function you(id: string, text: string, at: number): ProjectPreference {
	return { id, text, source: { type: "user" }, author: { type: "user" }, recordedAt: at };
}

function noted(id: string, text: string, quote: string, at: number): ProjectPreference {
	return {
		id,
		text,
		source: { type: "mission_note", missionId: "m-search", eventId: 41, quote },
		author: { type: "coordinator", sessionId: "s-coordinator", missionId: "m-search" },
		recordedAt: at,
	};
}

function saved(): ProjectPreferences {
	return {
		projectId: PROJECT,
		revision: 3,
		entries: [
			you("p-small", "Keep pull requests small: one change each.", NOW - 9 * DAY),
			noted(
				"p-tests",
				"Run only the tests a change touches; CI runs the rest.",
				"just run the tests the change touches, CI does the rest",
				NOW - 2 * DAY,
			),
			you("p-names", "Use plain names in code and docs.", NOW - DAY),
		],
		updatedAt: NOW - DAY,
		author: { type: "user" },
		source: { type: "user" },
	};
}

/** A coordinator's later change, as another writer would make it. */
function theirs(base: ProjectPreferences): ProjectPreferences {
	return {
		...base,
		revision: base.revision + 1,
		entries: [...base.entries, noted("p-friday", "No releases on Fridays.", "please never release on a friday", NOW)],
		updatedAt: NOW,
		author: { type: "coordinator", sessionId: "s-coordinator", missionId: "m-search" },
	};
}

let minted = 0;

/** One project's preferences, in memory. */
export class ScriptedPreferences implements PreferencesSource {
	readonly mode = signal<PreferencesDemoMode>("saved");
	readonly next = signal<PreferencesDemoNext>("accept");
	readonly saves = signal(0);
	readonly checks = signal(0);
	readonly reads = signal(0);
	#list: ProjectPreferences = saved();
	#shown: ProjectPreferences | null = null;
	#refused = false;
	#pending: { operationId: string; intent: SaveIntent } | null = null;
	#saving = false;
	#listeners = new Set<(v: PreferencesView) => void>();

	constructor(mode: PreferencesDemoMode = "saved") {
		this.mode.set(mode);
		if (mode === "empty") this.#list = { projectId: PROJECT, revision: 0, entries: [] };
	}

	view(): PreferencesView {
		const reason = this.#refused
			? this.#shown
				? `${preferencesReason("offline")} What shows is from Pilot's last read.`
				: preferencesReason("offline")
			: "";
		return {
			availability: this.#shown ? "live" : this.#refused ? "unavailable" : this.reads() ? "reading" : "idle",
			reason,
			projectId: this.#shown ? PROJECT : "",
			projectName: this.#shown ? "Pilot" : "",
			preferences: this.#shown,
			unsettled: this.#pending
				? [
						{
							operationId: this.#pending.operationId,
							state: "unknown",
							expectedRevision: this.#pending.intent.expectedRevision,
						},
					]
				: [],
			reading: false,
			saving: this.#saving,
		};
	}

	onChange(listener: (v: PreferencesView) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#publish() {
		const v = this.view();
		for (const l of this.#listeners) l(v);
	}

	async read(): Promise<void> {
		this.reads.set(this.reads() + 1);
		this.#refused = this.mode() === "unreadable";
		if (!this.#refused) this.#shown = this.#list;
		this.#publish();
	}

	/** Starts over with a project that has no preferences yet. */
	empty() {
		this.#list = { projectId: PROJECT, revision: 0, entries: [] };
		this.mode.set("saved");
	}

	/** The list with `intent`'s words, as the service would commit it. */
	#commit(intent: SaveIntent): ProjectPreferences {
		const before = new Map(this.#list.entries.map((e) => [e.id, e]));
		const entries = intent.entries.map((e) => {
			const was = e.id ? before.get(e.id) : undefined;
			if (was && was.text === e.text) return was;
			minted += 1;
			return you(e.id ?? `p-new-${minted}`, e.text, NOW);
		});
		return {
			projectId: PROJECT,
			revision: intent.expectedRevision + 1,
			entries,
			updatedAt: NOW,
			author: { type: "user" },
			source: { type: "user" },
		};
	}

	async save(intent: SaveIntent): Promise<SaveResult> {
		this.saves.set(this.saves() + 1);
		if (this.#pending) {
			return {
				status: "unknown",
				message: "An earlier change is not confirmed. Check it first; nothing was sent.",
				operationId: null,
				saved: null,
			};
		}
		if (intent.projectId !== PROJECT) {
			return {
				status: "rejected",
				message: "This window cannot save another project's preferences.",
				operationId: null,
				saved: null,
			};
		}
		const next = this.next();
		this.next.set("accept");
		if (next === "stale") {
			// Someone else saved first: the service's revision check refuses this one.
			this.#list = theirs(this.#list);
			this.#shown = this.#list;
			this.#publish();
			return {
				status: "stale",
				message: "These preferences changed since you read them. Nothing was saved; your text stays.",
				operationId: null,
				saved: null,
			};
		}
		if (intent.expectedRevision !== this.#list.revision) {
			return {
				status: "stale",
				message: "These preferences changed since you read them. Nothing was saved; your text stays.",
				operationId: null,
				saved: null,
			};
		}
		if (next === "reject") {
			return {
				status: "rejected",
				message: "Pilot's service refused it: a preference is too long.",
				operationId: "op-rejected",
				saved: null,
			};
		}
		const operationId = `op-${this.saves()}`;
		if (next === "unknown") {
			// The service saved it, but the answer was lost.
			this.#pending = { operationId, intent };
			this.#list = this.#commit(intent);
			this.#publish();
			return { status: "unknown", message: UNKNOWN_SAVE, operationId, saved: null };
		}
		this.#list = this.#commit(intent);
		this.#shown = this.#list;
		this.#publish();
		return { status: "accepted", message: "Saved.", operationId, saved: this.#list };
	}

	async check(operationId: string): Promise<SaveResult> {
		this.checks.set(this.checks() + 1);
		if (!this.#pending || this.#pending.operationId !== operationId) {
			return {
				status: "unknown",
				message: "Pilot's service has no result for it yet. Nothing was sent again.",
				operationId,
				saved: null,
			};
		}
		this.#pending = null;
		this.#shown = this.#list;
		this.#publish();
		return { status: "accepted", message: "Saved.", operationId, saved: this.#list };
	}

	dispose(): void {
		this.#listeners.clear();
	}
}
