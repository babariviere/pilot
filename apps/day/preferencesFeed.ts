// A project's preferences over the native root: `day.preferences.read` reads
// the window's own project's small list of explicit choices, Save sends one
// full list once with the exact revision shown, and Check only looks up a
// saved write's receipt. The native root picks the project; a Save that
// names another project is refused there. Preferences are what the user
// chose, never permission: nothing here starts work or grants an action.
import { type Signal, signal } from "nsh";
import { call, type Refusal, type Reply } from "./bridge";
import { glide } from "./motion";
import type { ProjectPreference, ProjectPreferences } from "./preferencesContract";

export type { ProjectPreference, ProjectPreferences };

/** At most this many preferences per project. */
export const MAX_ENTRIES = 16;
/** At most this many UTF-8 bytes per preference. */
export const MAX_TEXT_BYTES = 512;

/** One saved write whose result Pilot does not know. Only Check settles it. */
export type PreferencesOp = {
	operationId: string;
	/** "checking" while Check reads its receipt. */
	state: "unknown" | "checking";
	/** The revision it was written against. */
	expectedRevision: number;
};

/** What the preferences section shows. */
export type PreferencesView = {
	/** "idle" before the page asked; "unavailable" when no read could be shown. */
	availability: "idle" | "reading" | "live" | "unavailable";
	/** Why nothing is shown, or why what is shown is from an earlier read. */
	reason: string;
	/** The project the read is for, or "" before a read. */
	projectId: string;
	/** Its name, or "" when Pilot did not name it. */
	projectName: string;
	/** The newest read, or null. */
	preferences: ProjectPreferences | null;
	/** Writes whose result is not known. */
	unsettled: PreferencesOp[];
	/** A read is on its way. */
	reading: boolean;
	/** A Save is on its way. */
	saving: boolean;
};

/** One full list, written against the exact revision shown. A null ID is a new preference. */
export type SaveIntent = {
	projectId: string;
	expectedRevision: number;
	entries: { id: string | null; text: string }[];
};

/** What a Save or a Check did, for the user. */
export type SaveResult = {
	status: "accepted" | "stale" | "rejected" | "unknown";
	message: string;
	operationId: string | null;
	/** The committed list, when a receipt carried it. */
	saved: ProjectPreferences | null;
};

/** One page of saved revisions, newest first. `before` asks for the next older page; null when none is left. */
export type HistoryPage = { revisions: ProjectPreferences[]; more: boolean; before: number | null };

/** A history page, or why none could be read. A failed read is never an empty history. */
export type HistoryRead = { ok: true; page: HistoryPage } | { ok: false; reason: string };

/** The preferences' source. The connected window asks its root; the mock window has a script. */
export interface PreferencesSource {
	view(): PreferencesView;
	onChange(listener: (view: PreferencesView) => void): () => void;
	/** Reads again. Passive: it sends and settles nothing. */
	read(): Promise<void>;
	/** Sends one full list once. Never resent. */
	save(intent: SaveIntent): Promise<SaveResult>;
	/** Reads one unsettled write's saved receipt. Never sends it again. */
	check(operationId: string): Promise<SaveResult>;
	/** Reads saved revisions older than `before` (from the newest, without it). Passive. */
	history(before?: number): Promise<HistoryRead>;
	dispose(): void;
}

/** The UTF-8 length of `text`, as the service counts its limit. */
export function utf8Bytes(text: string): number {
	let n = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
	}
	return n;
}

/** Why the preferences could not be read, in one calm sentence. */
export function preferencesReason(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service.";
		case "identity":
			return "The Pilot service changed. Open Pilot again to see them.";
		case "closed":
		case "busy":
			return "Pilot is closing.";
		case "denied":
		case "unavailable":
			return "This Pilot service cannot show project preferences here yet.";
		case "invalid":
			return "Pilot's service answered in a way this app does not understand.";
		default:
			return "Pilot could not read this project's preferences.";
	}
}

/** Why the history could not be read. It is never the same as having none. */
export function historyReason(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service.";
		case "denied":
		case "unavailable":
			return "This Pilot service cannot show preference history here yet.";
		case "invalid":
			return "Pilot's service answered in a way this app does not understand.";
		default:
			return "Pilot could not read this project's preference history.";
	}
}

export const UNKNOWN_SAVE =
	"Pilot sent your change but heard nothing back. It will not send it again; Check only reads.";

/** What a refused or lost Save means. Only a lost or uncertain one may have been saved. */
export function refusedSave(refusal: Refusal): SaveResult {
	const r = (status: SaveResult["status"], message: string): SaveResult => ({
		status,
		message,
		operationId: null,
		saved: null,
	});
	switch (refusal) {
		case "lost":
		case "unknown":
			return r("unknown", UNKNOWN_SAVE);
		case "stale":
			return r("stale", "These preferences changed since you read them. Nothing was saved; your text stays.");
		case "busy":
			return r("rejected", "Pilot is busy saving. Nothing was sent; try again after.");
		case "closed":
			return r("rejected", "Pilot is closing. Nothing was saved.");
		case "offline":
			return r("rejected", "Pilot could not reach its service. Nothing was saved; your text stays.");
		case "identity":
			return r("rejected", "The Pilot service changed. Open Pilot again. Nothing was saved.");
		case "capacity":
		case "invalid":
			return r("rejected", "Pilot cannot save this list. Keep it to 16 short preferences. Nothing was saved.");
		case "denied":
		case "unavailable":
			return r("rejected", "This Pilot service cannot save project preferences yet. Nothing was saved.");
		default:
			return r("rejected", "Pilot could not save this. Nothing was saved; your text stays.");
	}
}

function preferenceOf(x: unknown): ProjectPreference | null {
	const e = x as ProjectPreference | null;
	if (!e || typeof e !== "object" || typeof e.id !== "string" || typeof e.text !== "string") return null;
	if (!e.source || typeof e.source !== "object" || !e.author || typeof e.author !== "object") return null;
	if (typeof e.recordedAt !== "number") return null;
	return e;
}

/** A list the page can show: the exact project and a whole, ordered list. Anything else is not shown. */
export function preferencesOf(x: unknown, project: string): ProjectPreferences | null {
	const p = x as ProjectPreferences | null;
	if (!p || typeof p !== "object" || p.projectId !== project) return null;
	if (typeof p.revision !== "number" || !Number.isSafeInteger(p.revision) || p.revision < 0) return null;
	if (!Array.isArray(p.entries) || p.entries.length > MAX_ENTRIES) return null;
	const entries: ProjectPreference[] = [];
	for (const raw of p.entries) {
		const e = preferenceOf(raw);
		if (!e) return null;
		entries.push(e);
	}
	return { ...p, entries };
}

/** The root's read: the project it chose, its name and the list. */
type Snapshot = { version: 1; projectId: string; projectName: string; preferences: ProjectPreferences };

/** A history page for `project`, checked again: older than `before`, newest first. Else null. */
export function historyOf(x: unknown, project: string, before?: number): HistoryPage | null {
	const h = x as { projectId?: unknown; revisions?: unknown; more?: unknown; before?: unknown } | null;
	if (!h || typeof h !== "object" || h.projectId !== project || !Array.isArray(h.revisions)) return null;
	if (typeof h.more !== "boolean" || h.revisions.length > 20) return null;
	const revisions: ProjectPreferences[] = [];
	let previous = before ?? Number.MAX_SAFE_INTEGER;
	for (const raw of h.revisions) {
		const r = preferencesOf(raw, project);
		if (!r || r.revision <= 0 || r.revision >= previous) return null;
		previous = r.revision;
		revisions.push(r);
	}
	const next = h.more && typeof h.before === "number" ? h.before : null;
	if (h.more && next !== previous) return null;
	return { revisions, more: h.more, before: next };
}

function snapshotOf(x: unknown): Snapshot | null {
	const s = x as Snapshot | null;
	if (!s || typeof s !== "object" || s.version !== 1 || typeof s.projectId !== "string" || s.projectId === "")
		return null;
	const preferences = preferencesOf(s.preferences, s.projectId);
	if (!preferences) return null;
	return {
		version: 1,
		projectId: s.projectId,
		projectName: typeof s.projectName === "string" ? s.projectName : "",
		preferences,
	};
}

type Summary = { operationId: string; state: string; expectedRevision: number };

function summariesOf(x: unknown): Summary[] | null {
	if (!Array.isArray(x)) return null;
	const out: Summary[] = [];
	for (const raw of x as Record<string, unknown>[]) {
		if (!raw || typeof raw.operationId !== "string" || typeof raw.state !== "string") continue;
		out.push({
			operationId: raw.operationId,
			state: raw.state,
			expectedRevision: typeof raw.expectedRevision === "number" ? raw.expectedRevision : 0,
		});
	}
	return out;
}

/** A receipt's outcome. Only an accepted receipt naming the committed list proves a Save. */
function outcomeOf(x: unknown, project: string, operationId: string | null): SaveResult {
	const o = x as { state?: unknown; receipt?: { reason?: unknown; result?: unknown } | null } | null;
	if (o?.state === "accepted") {
		const saved = preferencesOf(o.receipt?.result, project);
		if (saved) return { status: "accepted", message: "Saved.", operationId, saved };
	}
	if (o?.state === "rejected") {
		const reason = typeof o.receipt?.reason === "string" ? o.receipt.reason : "";
		// The service's revision check: another list was saved first.
		if (reason.startsWith("Project preferences changed")) {
			return {
				status: "stale",
				message: "These preferences changed since you read them. Nothing was saved; your text stays.",
				operationId,
				saved: null,
			};
		}
		return {
			status: "rejected",
			message: reason ? `Pilot's service refused it: ${reason}` : "Pilot's service refused it. Nothing was saved.",
			operationId,
			saved: null,
		};
	}
	return { status: "unknown", message: UNKNOWN_SAVE, operationId, saved: null };
}

/** The connected window's preferences: its native root's own project. */
export class ConnectedPreferences implements PreferencesSource {
	#window: string;
	#snapshot: Snapshot | null = null;
	#refusal: Refusal | null = null;
	#ops: Summary[] = [];
	#checking = new Set<string>();
	#reading: Promise<void> | null = null;
	#again = false;
	#asked = false;
	#saving = false;
	#sent = 0;
	#applied = 0;
	#listeners = new Map<number, (view: PreferencesView) => void>();
	#next = 0;
	#closed = false;

	constructor(window: string) {
		this.#window = window;
	}

	view(): PreferencesView {
		const s = this.#snapshot;
		const reason = this.#refusal
			? s
				? `${preferencesReason(this.#refusal)} What shows is from Pilot's last read.`
				: preferencesReason(this.#refusal)
			: "";
		return {
			availability: s ? "live" : this.#refusal ? "unavailable" : this.#asked ? "reading" : "idle",
			reason,
			projectId: s?.projectId ?? "",
			projectName: s?.projectName ?? "",
			preferences: s?.preferences ?? null,
			unsettled: this.#ops
				.filter((o) => o.state === "unknown" || o.state === "pending")
				.map((o) => ({
					operationId: o.operationId,
					state: this.#checking.has(o.operationId) ? "checking" : "unknown",
					expectedRevision: o.expectedRevision,
				})),
			reading: this.#reading !== null,
			saving: this.#saving,
		};
	}

	onChange(listener: (view: PreferencesView) => void): () => void {
		const id = this.#next++;
		this.#listeners.set(id, listener);
		return () => {
			this.#listeners.delete(id);
		};
	}

	#publish() {
		if (this.#closed) return;
		const view = this.view();
		for (const listener of this.#listeners.values()) listener(view);
	}

	/** One exact call. Only the newest call's answer replaces what is shown. */
	async #call(name: string, args: unknown): Promise<Reply<unknown>> {
		const order = ++this.#sent;
		const r = await call<unknown>(this.#window, name, args);
		if (this.#closed) return r;
		if (r.ok && order > this.#applied) {
			const snapshot = snapshotOf(r.snapshot);
			// A read for another project than the one shown never replaces it.
			if (snapshot && (!this.#snapshot || snapshot.projectId === this.#snapshot.projectId)) {
				this.#snapshot = snapshot;
				this.#refusal = null;
			} else if (name === "day.preferences.read") {
				this.#refusal = "invalid";
			}
			const ops = summariesOf(r.value.operations);
			if (ops) this.#ops = ops;
			this.#applied = order;
		} else if (!r.ok && name === "day.preferences.read" && order > this.#applied) {
			this.#refusal = r.refusal;
			this.#applied = order;
		}
		return r;
	}

	read(): Promise<void> {
		if (this.#reading) {
			this.#again = true;
			return this.#reading;
		}
		this.#asked = true;
		this.#reading = (async () => {
			do {
				this.#again = false;
				await this.#call("day.preferences.read", {});
				this.#publish();
			} while (this.#again && !this.#closed);
		})().finally(() => {
			this.#reading = null;
			this.#publish();
		});
		this.#publish();
		return this.#reading;
	}

	async save(intent: SaveIntent): Promise<SaveResult> {
		if (this.#saving) return refusedSave("busy");
		if (this.view().unsettled.length > 0) {
			return {
				status: "unknown",
				message: "An earlier change is not confirmed. Check it first; nothing was sent.",
				operationId: null,
				saved: null,
			};
		}
		this.#saving = true;
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await this.#call("day.preferences.save", {
				projectId: intent.projectId,
				expectedRevision: intent.expectedRevision,
				entries: intent.entries.map((e) => ({ id: e.id, text: e.text })),
			});
		} finally {
			this.#saving = false;
		}
		if (!r.ok) {
			// A lost answer may hide a saved operation: the read lists it as Unknown.
			void this.read();
			this.#publish();
			return refusedSave(r.refusal);
		}
		const outcome = r.value.outcome as { operationId?: unknown } | null;
		const id = typeof outcome?.operationId === "string" ? outcome.operationId : null;
		if (!snapshotOf(r.snapshot)) void this.read();
		this.#publish();
		return outcomeOf(outcome, intent.projectId, id);
	}

	async check(operationId: string): Promise<SaveResult> {
		if (this.#checking.has(operationId)) return refusedSave("busy");
		const project = this.#snapshot?.projectId ?? "";
		this.#checking.add(operationId);
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await this.#call("day.preferences.check", { operationId });
		} finally {
			this.#checking.delete(operationId);
		}
		this.#publish();
		if (!r.ok) {
			return {
				status: "unknown",
				message: "Pilot could not check it now. Nothing was sent; it stays not confirmed.",
				operationId,
				saved: null,
			};
		}
		const result = outcomeOf(r.value.outcome, project, operationId);
		if (result.status === "unknown") {
			result.message = "Pilot's service has no result for it yet. Nothing was sent again.";
		}
		return result;
	}

	async history(before?: number): Promise<HistoryRead> {
		const project = this.#snapshot?.projectId ?? "";
		if (!project) return { ok: false, reason: "Pilot has not read this project's preferences yet." };
		const r = await call<unknown>(this.#window, "day.preferences.history", before === undefined ? {} : { before });
		if (!r.ok) return { ok: false, reason: historyReason(r.refusal) };
		const page = historyOf(r.snapshot, project, before);
		return page ? { ok: true, page } : { ok: false, reason: historyReason("invalid") };
	}

	dispose(): void {
		this.#closed = true;
		this.#listeners.clear();
	}
}

/** The preferences' view, mirrored in one signal that only the source's listener sets. */
export type PreferencesMirror = {
	source: PreferencesSource;
	view: Signal<PreferencesView>;
	close: () => void;
};

/** Mirrors `source`'s view. Rows that arrive or leave glide to their places. */
export function mirrorPreferences(source: PreferencesSource): PreferencesMirror {
	const view = signal(source.view());
	const shape = (v: PreferencesView) => (v.preferences?.entries ?? []).map((e) => e.id).join(",");
	const stop = source.onChange((next) => {
		if (shape(next) !== shape(view())) glide();
		view.set(next);
	});
	return {
		source,
		view,
		close: () => {
			stop();
			source.dispose();
		},
	};
}
