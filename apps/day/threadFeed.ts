// A mission's focused threads with its coordinator, over the native root
// (docs/technical/mission-threads.md). day.threads.read reads the mission's
// topics and whether discussion is open now; day.threads.history reads one
// page of the topic's ORIGINAL coordinator conversation, never a topic-only
// copy. A write (start a thread, Later/Discard/Reopen, link, send) is one
// journaled operation Rust sends once; a lost answer stays Unknown and Check
// only looks up its receipt. Talking here never starts, approves, resumes or
// stops work. A send the service accepted is not the coordinator's answer.
import { type Signal, signal } from "nsh";
import { call, type Refusal, type Reply } from "./bridge";
import { glide } from "./motion";

/** What a topic links: a canonical task or decision, or one original coordinator entry. */
export type ThreadReference =
	| { kind: "history"; sessionId: string; entryId: number }
	| { kind: "task"; id: string }
	| { kind: "decision"; id: string };

export type Disposition = "open" | "later" | "discarded";

/** One topic, as the service saved it. */
export type Topic = {
	id: string;
	title: string;
	revision: number;
	disposition: Disposition;
	/** The coordinator conversation it started in. It never moves to another one. */
	ownerSessionId: string;
	references: ThreadReference[];
	/** Operation IDs of messages sent in it: saved intents, not proof of an answer. */
	inputs: string[];
};

/** Names for references. Not a second task list. */
export type Catalog = {
	known: boolean;
	tasks: { id: string; number: number; title: string; status: string }[];
	decisions: { id: string; number: number; text: string; withdrawn: boolean }[];
};

/** The root's read of one mission's threads. */
export type ThreadsSnapshot = {
	missionId: string;
	/** Opaque: the exact read a write names. */
	source: string;
	/** Whether the coordinator can take a message now. A preview, never a reservation. */
	discussion: { available: boolean; reason: string };
	topics: Topic[];
	catalog: Catalog;
};

export type Purpose = "thread-create" | "thread-disposition" | "thread-reference" | "thread-send";

/** One saved write. Only accepted, rejected and not-sent are settled. */
export type ThreadOp = {
	operationId: string;
	purpose: Purpose;
	topicId: string;
	/** A message's exact words, or null for other writes. */
	text: string | null;
	state: "unknown" | "checking" | "accepted" | "rejected" | "not-sent";
	reason: string;
};

/** One mission's threads as the screens show them. */
export type MissionThreads = {
	/** "unavailable" when no read could be shown: never the same as having none. */
	availability: "idle" | "reading" | "live" | "unavailable";
	/** Why nothing is shown, or why what shows is from an earlier read. */
	reason: string;
	/** Why the latest read failed, in one sentence, or "" when it worked. An earlier read may still show. */
	failed: string;
	snapshot: ThreadsSnapshot | null;
	ops: ThreadOp[];
	/** A write is on its way. */
	writing: boolean;
};

/** One original coordinator entry, for display. */
export type HistoryEntry = {
	id: number;
	kind: string;
	/** "planning" is Pilot's own planning request; "activity" is tools and notes. */
	role: "you" | "coordinator" | "planning" | "activity";
	text: string;
	/** Pilot shows only the start of a long entry. */
	shortened: boolean;
	/** The topic links this exact entry. */
	referenced: boolean;
	/** A message the user sent in this topic. */
	input: boolean;
	/** The topic a sent message was written in, when Pilot knows it. */
	sentIn: string | null;
};

/** One topic's page of the coordinator conversation, oldest first. */
export type TopicHistory = {
	availability: "reading" | "live" | "unavailable";
	reason: string;
	sessionId: string;
	entries: HistoryEntry[];
	more: boolean;
	nextBefore: number | null;
	reading: boolean;
};

export type ThreadsState = {
	missions: Record<string, MissionThreads>;
	/** By historyKey(mission, topic). */
	histories: Record<string, TopicHistory>;
};

/** One explicit user write. The root picks the operation ID and a new topic's ID. */
export type ThreadWrite =
	| { purpose: "thread-create"; title: string }
	| { purpose: "thread-disposition"; topicId: string; disposition: Disposition }
	| { purpose: "thread-reference"; topicId: string; reference: ThreadReference }
	| { purpose: "thread-send"; topicId: string; text: string };

/** What a write or a Check did, for the user. */
export type WriteResult = {
	/** "refused": the root did not send it. "rejected": the service refused it. */
	status: "accepted" | "refused" | "stale" | "rejected" | "unknown";
	message: string;
	operationId: string | null;
	topicId: string | null;
};

/** The threads' source. The connected window asks its root; the mock window has a script. */
export interface ThreadsSource {
	state(): ThreadsState;
	onChange(listener: (state: ThreadsState) => void): () => void;
	/** Reads a mission's threads again. Passive: it sends and settles nothing. */
	read(missionId: string): Promise<void>;
	/** Reads the newest page of a topic's coordinator conversation, or the page before what shows. Passive. */
	history(missionId: string, topicId: string, older?: boolean): Promise<void>;
	/** Sends one write once, against the exact source shown. Never resent. */
	write(missionId: string, source: string, write: ThreadWrite): Promise<WriteResult>;
	/** Reads one unsettled write's saved receipt. Never sends it again. */
	check(missionId: string, operationId: string): Promise<WriteResult>;
	dispose(): void;
}

export const MAX_TITLE = 200;
export const MAX_TEXT_BYTES = 32_000;

export function historyKey(missionId: string, topicId: string): string {
	return `${missionId}/${topicId}`;
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

export const UNKNOWN_WRITE =
	"Pilot sent this but heard nothing back. It will not send it again; Check only reads. Your words stay.";

/** Why a mission's threads could not be read, in one calm sentence. */
export function threadsReason(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service.";
		case "identity":
			return "The Pilot service changed. Open Pilot again to see threads.";
		case "closed":
		case "busy":
			return "Pilot is closing.";
		case "stale":
			return "Threads need this mission's current coordinator in this project, and Pilot cannot confirm that now.";
		case "denied":
		case "unavailable":
			return "This Pilot service cannot show mission threads yet.";
		case "invalid":
			return "Pilot's service answered in a way this app does not understand.";
		case "lost":
			return "Pilot asked its service for this mission's threads and heard nothing back.";
		default:
			return "Pilot could not read this mission's threads.";
	}
}

/** What a refused or lost write means. Only a lost or uncertain one may have been sent. */
export function refusedWrite(refusal: Refusal): WriteResult {
	const r = (status: WriteResult["status"], message: string): WriteResult => ({
		status,
		message,
		operationId: null,
		topicId: null,
	});
	switch (refusal) {
		case "lost":
			return r("unknown", UNKNOWN_WRITE);
		case "unknown":
			return r("unknown", "An earlier action on this mission is not confirmed. Check it first; nothing was sent.");
		case "stale":
			return r("stale", "This mission's threads changed since you read them. Nothing was sent; your words stay.");
		case "busy":
			return r("refused", "Pilot is saving this window. Nothing was sent; try again after.");
		case "closed":
			return r("refused", "Pilot is closing. Nothing was sent.");
		case "offline":
			return r("refused", "Pilot could not reach its service. Nothing was sent; your words stay.");
		case "identity":
			return r("refused", "The Pilot service changed. Open Pilot again. Nothing was sent.");
		case "denied":
		case "unavailable":
			return r("refused", "This Pilot service cannot take thread changes yet. Nothing was sent.");
		default:
			return r("refused", "Pilot could not send this. Nothing was sent; your words stay.");
	}
}

/** The words for an accepted write. A sent message is not an answer. */
export function acceptedWords(purpose: Purpose, write?: ThreadWrite): string {
	switch (purpose) {
		case "thread-create":
			return "Thread started. Nothing was sent to the coordinator yet.";
		case "thread-send":
			return "Sent. The coordinator has your message; its answer shows here when it writes one.";
		case "thread-reference":
			return "Linked to this thread.";
		case "thread-disposition": {
			const d = write?.purpose === "thread-disposition" ? write.disposition : null;
			if (d === "later") return "Moved to Later. Its history stays.";
			if (d === "discarded") return "Discarded. Its history stays, and you can reopen it.";
			return "Reopened.";
		}
	}
}

function str(x: unknown): string {
	return typeof x === "string" ? x : "";
}

function referenceOf(x: unknown): ThreadReference | null {
	const r = x as Record<string, unknown> | null;
	if (!r || typeof r !== "object") return null;
	if ((r.kind === "task" || r.kind === "decision") && typeof r.id === "string") return { kind: r.kind, id: r.id };
	if (r.kind === "history" && typeof r.sessionId === "string" && typeof r.entryId === "number")
		return { kind: "history", sessionId: r.sessionId, entryId: r.entryId };
	return null;
}

function topicOf(x: unknown): Topic | null {
	const t = x as Record<string, unknown> | null;
	if (!t || typeof t !== "object" || typeof t.id !== "string" || typeof t.title !== "string") return null;
	if (t.disposition !== "open" && t.disposition !== "later" && t.disposition !== "discarded") return null;
	if (!Array.isArray(t.references) || !Array.isArray(t.inputs)) return null;
	const references: ThreadReference[] = [];
	for (const raw of t.references) {
		const r = referenceOf(raw);
		if (!r) return null;
		references.push(r);
	}
	return {
		id: t.id,
		title: t.title,
		revision: typeof t.revision === "number" ? t.revision : 0,
		disposition: t.disposition,
		ownerSessionId: str(t.ownerSessionId),
		references,
		inputs: t.inputs.filter((i): i is string => typeof i === "string"),
	};
}

function catalogOf(x: unknown): Catalog {
	const c = x as Record<string, unknown> | null;
	const rows = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
	return {
		known: c?.known === true,
		tasks: rows(c?.tasks)
			.filter((t) => typeof t.id === "string")
			.map((t) => ({
				id: t.id as string,
				number: typeof t.number === "number" ? t.number : 0,
				title: str(t.title),
				status: str(t.status),
			})),
		decisions: rows(c?.decisions)
			.filter((d) => typeof d.id === "string")
			.map((d) => ({
				id: d.id as string,
				number: typeof d.number === "number" ? d.number : 0,
				text: str(d.text),
				withdrawn: d.withdrawn === true,
			})),
	};
}

/** A read the page can show: this mission and a whole list. Anything else is not shown. */
export function snapshotOf(x: unknown, missionId: string): ThreadsSnapshot | null {
	const s = x as Record<string, unknown> | null;
	if (!s || typeof s !== "object" || s.version !== 1 || s.missionId !== missionId) return null;
	if (typeof s.source !== "string" || !Array.isArray(s.topics)) return null;
	const d = s.discussion as { available?: unknown; reason?: unknown } | null;
	if (!d || typeof d.available !== "boolean") return null;
	const topics: Topic[] = [];
	for (const raw of s.topics) {
		const t = topicOf(raw);
		if (!t) return null;
		topics.push(t);
	}
	return {
		missionId,
		source: s.source,
		discussion: { available: d.available, reason: str(d.reason) },
		topics,
		catalog: catalogOf(s.catalog),
	};
}

const PURPOSES = new Set<string>(["thread-create", "thread-disposition", "thread-reference", "thread-send"]);

function opsOf(x: unknown): ThreadOp[] | null {
	if (!Array.isArray(x)) return null;
	const out: ThreadOp[] = [];
	for (const raw of x as Record<string, unknown>[]) {
		if (!raw || typeof raw.operationId !== "string" || !PURPOSES.has(str(raw.purpose))) continue;
		const s = str(raw.state);
		out.push({
			operationId: raw.operationId,
			purpose: raw.purpose as Purpose,
			topicId: str(raw.topicId),
			text: typeof raw.text === "string" ? raw.text : null,
			state: s === "accepted" || s === "rejected" || s === "not-sent" ? s : "unknown",
			reason: str(raw.reason),
		});
	}
	return out;
}

function entryOf(x: unknown): HistoryEntry | null {
	const e = x as Record<string, unknown> | null;
	if (!e || typeof e.id !== "number") return null;
	const role = e.role === "you" || e.role === "coordinator" || e.role === "planning" ? e.role : "activity";
	return {
		id: e.id,
		kind: str(e.kind),
		role,
		text: str(e.text),
		shortened: e.shortened === true,
		referenced: e.referenced === true,
		input: e.input === true,
		sentIn: typeof e.sentIn === "string" ? e.sentIn : null,
	};
}

/** What a receipt says. Only an accepted receipt proves the write; it never proves an answer. */
export function outcomeOf(x: unknown, write?: ThreadWrite): WriteResult {
	const o = x as Record<string, unknown> | null;
	const operationId = typeof o?.operationId === "string" ? o.operationId : null;
	const topicId = typeof o?.topicId === "string" ? o.topicId : null;
	const purpose = PURPOSES.has(str(o?.purpose)) ? (o?.purpose as Purpose) : null;
	const r = (status: WriteResult["status"], message: string): WriteResult => ({
		status,
		message,
		operationId,
		topicId,
	});
	switch (o?.state) {
		case "accepted":
			return r("accepted", purpose ? acceptedWords(purpose, write) : "Done.");
		case "refused":
			return r("refused", str(o?.reason) || "Pilot did not send this. Nothing was sent.");
		case "not-sent":
			return r("refused", "Pilot stopped before sending this. Nothing was sent; your words stay.");
		case "rejected": {
			const reason = str(o?.reason);
			return r(
				"rejected",
				reason
					? `Pilot's service refused it: ${reason}. Nothing changed; your words stay.`
					: "Pilot's service refused it. Nothing changed; your words stay.",
			);
		}
		default:
			return r("unknown", UNKNOWN_WRITE);
	}
}

const EMPTY: MissionThreads = { availability: "idle", reason: "", failed: "", snapshot: null, ops: [], writing: false };

/** The connected window's threads: its native root's own project. */
export class ConnectedThreads implements ThreadsSource {
	#window: string;
	#missions = new Map<
		string,
		{ snapshot: ThreadsSnapshot | null; refusal: Refusal | null; ops: ThreadOp[]; asked: boolean }
	>();
	#reading = new Map<string, Promise<void>>();
	#again = new Set<string>();
	#writing = new Set<string>();
	#checking = new Set<string>();
	#histories = new Map<string, TopicHistory>();
	#listeners = new Map<number, (state: ThreadsState) => void>();
	#next = 0;
	#closed = false;

	constructor(window: string) {
		this.#window = window;
	}

	#mission(id: string) {
		let m = this.#missions.get(id);
		if (!m) {
			m = { snapshot: null, refusal: null, ops: [], asked: false };
			this.#missions.set(id, m);
		}
		return m;
	}

	state(): ThreadsState {
		const missions: Record<string, MissionThreads> = {};
		for (const [id, m] of this.#missions) {
			const failed = m.refusal ? threadsReason(m.refusal) : "";
			const reason = failed && m.snapshot ? `${failed} What shows is from Pilot's last read.` : failed;
			missions[id] = {
				availability: m.snapshot ? "live" : m.refusal ? "unavailable" : m.asked ? "reading" : "idle",
				reason,
				failed,
				snapshot: m.snapshot,
				ops: m.ops.map((o): ThreadOp => (this.#checking.has(o.operationId) ? { ...o, state: "checking" } : o)),
				writing: this.#writing.has(id),
			};
		}
		return { missions, histories: Object.fromEntries(this.#histories) };
	}

	onChange(listener: (state: ThreadsState) => void): () => void {
		const id = this.#next++;
		this.#listeners.set(id, listener);
		return () => {
			this.#listeners.delete(id);
		};
	}

	#publish() {
		if (this.#closed) return;
		const s = this.state();
		for (const l of this.#listeners.values()) l(s);
	}

	/** Applies a reply's snapshot and saved writes. A read for another mission is never shown here. */
	#apply(missionId: string, r: Reply<unknown>, isRead: boolean) {
		const m = this.#mission(missionId);
		if (r.ok) {
			const snapshot = snapshotOf(r.snapshot, missionId);
			if (snapshot) {
				m.snapshot = snapshot;
				m.refusal = null;
			} else if (isRead) {
				m.refusal = "invalid";
			}
			const ops = opsOf(r.value.operations);
			if (ops) m.ops = ops;
		} else if (isRead) {
			m.refusal = r.refusal;
		}
	}

	read(missionId: string): Promise<void> {
		const running = this.#reading.get(missionId);
		if (running) {
			this.#again.add(missionId);
			return running;
		}
		this.#mission(missionId).asked = true;
		const work = (async () => {
			do {
				this.#again.delete(missionId);
				const r = await call<unknown>(this.#window, "day.threads.read", { missionId });
				if (this.#closed) return;
				this.#apply(missionId, r, true);
				this.#publish();
			} while (this.#again.has(missionId) && !this.#closed);
		})().finally(() => {
			this.#reading.delete(missionId);
			this.#publish();
		});
		this.#reading.set(missionId, work);
		this.#publish();
		return work;
	}

	async history(missionId: string, topicId: string, older = false): Promise<void> {
		const key = historyKey(missionId, topicId);
		const now = this.#histories.get(key);
		if (now?.reading) return;
		const before = older ? now?.nextBefore : null;
		if (older && !before) return;
		this.#histories.set(key, {
			availability: now?.availability === "live" ? "live" : "reading",
			reason: now?.reason ?? "",
			sessionId: now?.sessionId ?? "",
			entries: now?.entries ?? [],
			more: now?.more ?? false,
			nextBefore: now?.nextBefore ?? null,
			reading: true,
		});
		this.#publish();
		const r = await call<unknown>(this.#window, "day.threads.history", {
			missionId,
			topicId,
			before: before ?? null,
		});
		if (this.#closed) return;
		const prior = this.#histories.get(key);
		const s = r.ok ? (r.snapshot as Record<string, unknown> | null) : null;
		if (r.ok && s && s.missionId === missionId && s.topicId === topicId && Array.isArray(s.entries)) {
			const page = s.entries.map(entryOf).filter((e): e is HistoryEntry => e !== null);
			// Entries never change, so pages join by ID. A fresh newest page keeps
			// the older pages already shown, and where to read before them.
			const oldest = page[0]?.id ?? Number.MAX_SAFE_INTEGER;
			const ids = new Set(page.map((e) => e.id));
			// Without an overlap there may be a gap: start again from the newest page.
			const joins = older || (prior?.entries ?? []).some((e) => ids.has(e.id));
			const kept = joins ? (prior?.entries ?? []).filter((e) => !ids.has(e.id)) : [];
			const entries = [...kept, ...page].sort((a, b) => a.id - b.id);
			const keepsOlder = !older && kept.some((e) => e.id < oldest);
			this.#histories.set(key, {
				availability: "live",
				reason: "",
				sessionId: str(s.sessionId),
				entries,
				more: keepsOlder ? (prior?.more ?? false) : s.more === true,
				nextBefore: keepsOlder
					? (prior?.nextBefore ?? null)
					: typeof s.nextBefore === "number"
						? s.nextBefore
						: null,
				reading: false,
			});
		} else {
			const refusal: Refusal = r.ok ? "invalid" : r.refusal;
			this.#histories.set(key, {
				availability: prior?.entries.length ? "live" : "unavailable",
				reason: prior?.entries.length
					? `${historyReason(refusal)} What shows is from Pilot's last read.`
					: historyReason(refusal),
				sessionId: prior?.sessionId ?? "",
				entries: prior?.entries ?? [],
				more: prior?.more ?? false,
				nextBefore: prior?.nextBefore ?? null,
				reading: false,
			});
		}
		this.#publish();
	}

	async write(missionId: string, source: string, write: ThreadWrite): Promise<WriteResult> {
		if (this.#writing.has(missionId)) return refusedWrite("busy");
		this.#writing.add(missionId);
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await call<unknown>(this.#window, "day.threads.write", { missionId, source, ...write });
		} finally {
			this.#writing.delete(missionId);
		}
		if (this.#closed) return refusedWrite("closed");
		if (!r.ok) {
			// A lost answer may hide a saved write: the next read lists it as Unknown.
			void this.read(missionId);
			this.#publish();
			return refusedWrite(r.refusal);
		}
		this.#apply(missionId, r, false);
		if (!snapshotOf(r.snapshot, missionId)) void this.read(missionId);
		this.#publish();
		return outcomeOf(r.value.outcome, write);
	}

	async check(missionId: string, operationId: string): Promise<WriteResult> {
		if (this.#checking.has(operationId)) return refusedWrite("busy");
		this.#checking.add(operationId);
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await call<unknown>(this.#window, "day.threads.check", { operationId });
		} finally {
			this.#checking.delete(operationId);
		}
		if (this.#closed) return refusedWrite("closed");
		if (!r.ok) {
			this.#publish();
			return {
				status: "unknown",
				message: "Pilot could not check it now. Nothing was sent; it stays not confirmed.",
				operationId,
				topicId: null,
			};
		}
		this.#apply(missionId, r, false);
		this.#publish();
		const result = outcomeOf(r.value.outcome);
		if (result.status === "unknown")
			result.message = "Pilot's service has no result for it yet. Nothing was sent again.";
		return result;
	}

	dispose(): void {
		this.#closed = true;
		this.#listeners.clear();
	}
}

/** Why a coordinator conversation could not be read. Never shown as an empty one. */
export function historyReason(refusal: Refusal): string {
	switch (refusal) {
		case "stale":
			return "Pilot cannot read the coordinator's conversation now: the mission's coordinator or access changed.";
		case "offline":
			return "Pilot could not reach its service to read the conversation.";
		default:
			return "Pilot could not read the coordinator's conversation.";
	}
}

/** The threads' state, mirrored in one signal that only the source's listener sets. */
export type ThreadsMirror = {
	source: ThreadsSource;
	state: Signal<ThreadsState>;
	/** One mission's threads, or the idle state before its first read. */
	mission: (missionId: string) => MissionThreads;
	close: () => void;
};

/** Mirrors `source`. Topics that arrive or leave glide to their places. */
export function mirrorThreads(source: ThreadsSource): ThreadsMirror {
	const state = signal(source.state());
	const shape = (s: ThreadsState) =>
		Object.entries(s.missions)
			.map(([id, m]) => `${id}:${(m.snapshot?.topics ?? []).map((t) => `${t.id}=${t.disposition}`).join(",")}`)
			.join("|");
	const stop = source.onChange((next) => {
		if (shape(next) !== shape(state())) glide();
		state.set(next);
	});
	return {
		source,
		state,
		mission: (id) => state().missions[id] ?? EMPTY,
		close: () => {
			stop();
			source.dispose();
		},
	};
}
