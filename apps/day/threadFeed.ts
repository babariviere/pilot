// A mission's focused threads with its coordinator, over the native root
// (docs/technical/mission-threads.md). day.threads.read reads the mission's
// topics and whether discussion is open now; day.threads.history reads one
// page of one ORIGINAL conversation the topic owns (its coordinator's or a
// thread chat's) and, with it, the topic's own messages in that page: only
// entries a saved link or a dedicated chat ties to the topic, never a guess
// and never a copy. A write (start a thread, Later/Discard/Reopen, link, send) is one
// journaled operation Rust sends once; a lost answer stays Unknown and Check
// only looks up its receipt. Talking here never starts, approves, resumes or
// stops work. A send the service accepted is not the coordinator's answer.
import { type Signal, signal } from "nsh";
import { AutoCheck } from "./autoCheck";
import { call, type Refusal, type Reply } from "./bridge";
import { glide } from "./ui";

/** What a topic links: a canonical task or decision, or one original coordinator entry. */
export type ThreadReference =
	| { kind: "history"; sessionId: string; entryId: number }
	| { kind: "task"; id: string }
	| { kind: "decision"; id: string };

/** `resolved`: a confirmed revision answered the thread's handoff. Pilot sets it; the user can reopen. */
export type Disposition = "open" | "later" | "discarded" | "resolved";

/** What a thread chat sent to the planner once the user agreed. It grants nothing. */
export type Handoff = { id: string; summary: string; tasks: { key: string; title: string }[]; queued: boolean };

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
	/** The thread chat that discusses it, once started. */
	chatSessionId: string | null;
	/** The latest handoff to the planner. */
	handoff: Handoff | null;
	/** The tasks of the confirmed revision that resolved it. */
	resolvedTaskIds: string[];
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
	/**
	 * Whether the coordinator can take a message now (`available`), or a message is saved to wait for it and goes with
	 * the next answers, or as soon as it is free (`waits`). A preview, never a reservation.
	 */
	discussion: { available: boolean; reason: string; waits: boolean };
	/** Messages saved to wait for the coordinator, in the order sent. */
	waiting: WaitingMessage[];
	topics: Topic[];
	catalog: Catalog;
};

/** A thread message saved to wait for the coordinator. */
export type WaitingMessage = { operationId: string; topicId: string; text: string };

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
	/** An accepted message that waits for the coordinator instead of reaching it now. */
	queued?: boolean;
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
	/** "planning" is Pilot's own planning request; "chat" is the thread chat; "activity" is tools and notes. */
	role: "you" | "coordinator" | "chat" | "planning" | "activity";
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

/** One exact saved entry of an original conversation. */
export type Original = { sessionId: string; entryId: number };

/** One topic's page of an original conversation (its activity), oldest first. One session at a time. */
export type TopicHistory = {
	availability: "reading" | "live" | "unavailable";
	reason: string;
	sessionId: string;
	/** Whose conversation: the coordinator's, or a thread chat's. "" before the first read. */
	scope: "coordinator-history" | "thread-chat" | "";
	entries: HistoryEntry[];
	more: boolean;
	nextBefore: number | null;
	reading: boolean;
	/** The exact entry an Original message asked for, when this page holds it. */
	focus: Original | null;
	/**
	 * What the user chose to see: the newest of the thread's own conversation ("default", which live reads keep
	 * fresh), another conversation it owns ("session"), or the stretch around an Original message ("original").
	 * Live reads never move a chosen view.
	 */
	view: "default" | "session" | "original";
};

/**
 * Whether a message of yours has an answer, from the saved link between the message and the turn that took it:
 * "pending" waits to reach the agent, "awaiting" was taken and has no answer yet, "unanswered" was taken and the
 * turn ended without one. "unknown" claims nothing.
 */
export type ReplyState = "answered" | "awaiting" | "pending" | "unanswered" | "unknown";

/** One message of a topic's own conversation, from its original entry. */
export type TopicMessage = {
	/**
	 * "<session>:<entry>", with ":<operation>" when one entry carries several sends: entry IDs repeat across
	 * conversations. "queued:<operation>" for a send not placed in a conversation yet.
	 */
	key: string;
	author: "you" | "chat" | "coordinator";
	text: string;
	/** When it was written, or null when its entry has no time. */
	at: number | null;
	reply: ReplyState;
	/** A coordinator reply linked whole: its words may also be about other work or threads. */
	shared: boolean;
	/** The exact saved entry, or null for a send that waits to be placed: Pilot never invents one. */
	original: Original | null;
	/** The send's operation, when Pilot knows it. */
	operationId: string | null;
};

/** Where a read of earlier messages goes on from. */
export type Cursor = { more: boolean; nextBefore: number | null; nextSessionId: string | null };

/**
 * Messages Pilot has not read between two it shows: a newest page that did not reach what showed before. Reads
 * of earlier messages fill it first, then go on from `resume`; `under` is a gap still open below it.
 */
export type ConversationGap = {
	/** The newest message before the gap. */
	older: TopicMessage;
	/** The oldest message read after the gap, or null when none was: the gap is at the end. */
	newer: string | null;
	resume: Cursor;
	under: ConversationGap | null;
};

/** A topic's own conversation as far as Pilot read it, oldest first, across the conversations it owns. */
export type TopicConversation = Cursor & {
	availability: "reading" | "live" | "unavailable";
	reason: string;
	messages: TopicMessage[];
	/** Your accepted sends that wait to be placed in a conversation, in the order sent. */
	queued: TopicMessage[];
	/** Every earlier coordinator reply is linked. When false, some may sit only in the activity. */
	complete: boolean;
	gap: ConversationGap | null;
	reading: boolean;
};

export type ThreadsState = {
	missions: Record<string, MissionThreads>;
	/** Activity by historyKey(mission, topic). */
	histories: Record<string, TopicHistory>;
	/** The topic's own conversation by historyKey(mission, topic). */
	conversations: Record<string, TopicConversation>;
};

/** One explicit user write. The root picks the operation ID and a new topic's ID. */
export type ThreadWrite =
	| { purpose: "thread-create"; title: string }
	| { purpose: "thread-disposition"; topicId: string; disposition: Disposition }
	| { purpose: "thread-reference"; topicId: string; reference: ThreadReference }
	| { purpose: "thread-send"; topicId: string; text: string; interrupt?: true };

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
	/**
	 * Reads the newest page of a topic's conversation and activity ("newest", which leaves an activity view the user
	 * chose), the activity page before what shows ("older"), or the newest activity of the thread or of one exact
	 * conversation it owns ("latest", as the user asks). Passive.
	 */
	history(
		missionId: string,
		topicId: string,
		which?: "newest" | "older" | "latest",
		sessionId?: string,
	): Promise<void>;
	/** Reads the topic's own messages before what shows, across the conversations it owns. Passive. */
	earlierMessages(missionId: string, topicId: string): Promise<void>;
	/** Reads the activity page that ends at this exact saved entry. Passive. */
	original(missionId: string, topicId: string, original: Original): Promise<void>;
	/** Sends one write once, against the exact source shown. Never resent. */
	write(missionId: string, source: string, write: ThreadWrite): Promise<WriteResult>;
	/** Reads one unsettled write's saved receipt. Never sends it again. */
	check(missionId: string, operationId: string): Promise<WriteResult>;
	dispose(): void;
}

export const MAX_TEXT_BYTES = 32_000;

/** A title's length when Pilot makes it from a message: one line in a thread list. */
export const MESSAGE_TITLE = 80;

/**
 * A new thread's title, from its first message: the first sentence (up to . ? ! or a line break), on one line, cut
 * at a word before MESSAGE_TITLE characters with "…".
 */
export function titleOf(message: string): string {
	const text = message.trim();
	const end = text.search(/[.?!](\s|$)|\n/);
	let first = (end >= 0 ? text.slice(0, text[end] === "\n" ? end : end + 1) : text).replace(/\s+/g, " ").trim();
	const chars = [...first];
	if (chars.length > MESSAGE_TITLE) {
		const cut = chars.slice(0, MESSAGE_TITLE - 1).join("");
		const space = cut.lastIndexOf(" ");
		first = `${(space > MESSAGE_TITLE / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
	}
	return first;
}

export function historyKey(missionId: string, topicId: string): string {
	return `${missionId}/${topicId}`;
}

/** A message's time: "Today, 09:10", "Yesterday, 16:20", "12 Nov 2025, 09:10", or "Time unknown". */
export function messageTime(at: number | null, now: number): string {
	if (at === null || !Number.isFinite(at) || at <= 0) return "Time unknown";
	const d = new Date(at);
	const two = (n: number) => String(n).padStart(2, "0");
	const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
	const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
	const today = day(new Date(now));
	if (day(d) === today) return `Today, ${clock}`;
	if (day(d) === new Date(today).setDate(new Date(today).getDate() - 1)) return `Yesterday, ${clock}`;
	const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
	return `${d.getDate()} ${month} ${d.getFullYear()}, ${clock}`;
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
/** An accepted message that waits for the coordinator. */
export const QUEUED_WORDS = "Saved. It waits for the coordinator.";

export function acceptedWords(purpose: Purpose, write?: ThreadWrite): string {
	switch (purpose) {
		case "thread-create":
			return "Thread started. Nothing was sent yet.";
		case "thread-send":
			return "Sent. The thread chat has your message; its answer shows here when it writes one.";
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
	if (
		t.disposition !== "open" &&
		t.disposition !== "later" &&
		t.disposition !== "discarded" &&
		t.disposition !== "resolved"
	)
		return null;
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
		chatSessionId: typeof t.chatSessionId === "string" ? t.chatSessionId : null,
		handoff: handoffOf(t.handoff),
		resolvedTaskIds: Array.isArray((t.resolvedBy as { taskIds?: unknown } | null)?.taskIds)
			? ((t.resolvedBy as { taskIds: unknown[] }).taskIds.filter((i) => typeof i === "string") as string[])
			: [],
	};
}

function handoffOf(x: unknown): Handoff | null {
	const h = x as Record<string, unknown> | null;
	if (!h || typeof h !== "object" || typeof h.id !== "string" || !Array.isArray(h.tasks)) return null;
	return {
		id: h.id,
		summary: str(h.summary),
		tasks: (h.tasks as Record<string, unknown>[]).map((task) => ({ key: str(task?.key), title: str(task?.title) })),
		queued: typeof h.queuedAt === "number",
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
	const d = s.discussion as { available?: unknown; reason?: unknown; waits?: unknown } | null;
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
		discussion: { available: d.available, reason: str(d.reason), waits: d.waits === true },
		waiting: Array.isArray(s.waiting)
			? (s.waiting as Record<string, unknown>[]).flatMap((m) =>
					m && typeof m.operationId === "string" && typeof m.topicId === "string" && typeof m.text === "string"
						? [{ operationId: m.operationId, topicId: m.topicId, text: m.text }]
						: [],
				)
			: [],
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
			...(raw.queued === true ? { queued: true } : {}),
		});
	}
	return out;
}

function entryOf(x: unknown): HistoryEntry | null {
	const e = x as Record<string, unknown> | null;
	if (!e || typeof e.id !== "number") return null;
	const role =
		e.role === "you" || e.role === "coordinator" || e.role === "chat" || e.role === "planning" ? e.role : "activity";
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

/** The topic's own messages in one page, as day.threads.history gives them. */
export type ConversationPage = Cursor & {
	messages: TopicMessage[];
	/** Your sends that wait to be placed, as of this read; null when the service does not say. */
	queued: TopicMessage[] | null;
	complete: boolean;
};

/** One page of a topic's activity, with its own messages in it. */
export type HistoryPage = {
	sessionId: string;
	scope: "coordinator-history" | "thread-chat";
	entries: HistoryEntry[];
	more: boolean;
	nextBefore: number | null;
	/** null: this service sends no conversation, so it cannot show one. */
	conversation: ConversationPage | null;
};

const REPLY_STATES = new Set<string>(["answered", "awaiting", "pending", "unanswered", "unknown"]);
const OPERATION = /^[A-Za-z0-9_-]{1,128}$/;

/** The topic's messages of a page from session `sessionId`, or null when any is not one exact saved entry. */
export function conversationOf(x: unknown, sessionId: string): ConversationPage | null {
	const c = x as Record<string, unknown> | null;
	if (!c || typeof c !== "object" || !Array.isArray(c.entries) || typeof c.more !== "boolean") return null;
	const messages: TopicMessage[] = [];
	const keys = new Set<string>();
	for (const raw of c.entries as Record<string, unknown>[]) {
		const o = raw?.original as Record<string, unknown> | null;
		const op = raw?.operationId;
		if (
			!raw ||
			typeof raw.id !== "number" ||
			raw.sessionId !== sessionId ||
			(raw.role !== "you" && raw.role !== "chat" && raw.role !== "coordinator") ||
			typeof raw.text !== "string" ||
			(op !== undefined && op !== null && (typeof op !== "string" || !OPERATION.test(op))) ||
			!o ||
			o.kind !== "history" ||
			o.sessionId !== sessionId ||
			o.entryId !== raw.id
		)
			return null;
		const operationId = typeof op === "string" ? op : null;
		// One original entry may carry several sends: each is its own message, with the same original.
		const key = operationId ? `${sessionId}:${raw.id}:${operationId}` : `${sessionId}:${raw.id}`;
		if (keys.has(key)) return null;
		keys.add(key);
		messages.push({
			key,
			author: raw.role,
			text: raw.text,
			at: typeof raw.timestamp === "number" ? raw.timestamp : null,
			reply:
				raw.role === "you" && REPLY_STATES.has(str(raw.replyState)) ? (raw.replyState as ReplyState) : "unknown",
			shared: raw.shared === true,
			original: { sessionId, entryId: raw.id },
			operationId,
		});
	}
	let queued: TopicMessage[] | null = null;
	if (Array.isArray(c.queuedMessages)) {
		queued = [];
		for (const q of c.queuedMessages as Record<string, unknown>[]) {
			if (
				!q ||
				typeof q.operationId !== "string" ||
				!OPERATION.test(q.operationId) ||
				typeof q.text !== "string" ||
				(q.replyState !== "pending" && q.replyState !== "unknown")
			)
				return null;
			queued.push({
				key: `queued:${q.operationId}`,
				author: "you",
				text: q.text,
				at: typeof q.timestamp === "number" ? q.timestamp : null,
				// "pending": it waits to be placed. "unknown": your exact saved words, placed where Pilot cannot tell.
				reply: q.replyState,
				shared: false,
				original: null,
				operationId: q.operationId,
			});
		}
	}
	return {
		messages,
		queued,
		more: c.more,
		nextBefore: typeof c.nextBefore === "number" ? c.nextBefore : null,
		nextSessionId: typeof c.nextSessionId === "string" ? c.nextSessionId : null,
		complete: c.earlierContext === "complete",
	};
}

/** A history page for exactly this mission and topic, or null. */
export function historyPageOf(x: unknown, missionId: string, topicId: string): HistoryPage | null {
	const s = x as Record<string, unknown> | null;
	if (!s || s.missionId !== missionId || s.topicId !== topicId || !Array.isArray(s.entries)) return null;
	const sessionId = str(s.sessionId);
	return {
		sessionId,
		scope: s.scope === "thread-chat" ? "thread-chat" : "coordinator-history",
		entries: s.entries.map(entryOf).filter((e): e is HistoryEntry => e !== null),
		more: s.more === true,
		nextBefore: typeof s.nextBefore === "number" ? s.nextBefore : null,
		conversation: s.conversation === undefined ? null : (conversationOf(s.conversation, sessionId) ?? null),
	};
}

/**
 * Oldest first: by time, an entry without one at the place of the one before it, and pages in the order read.
 * Only the order changes.
 */
function chronological(messages: TopicMessage[]): TopicMessage[] {
	let last = 0;
	const timed = messages.map((m, i) => {
		if (m.at !== null) last = m.at;
		return { m, t: m.at ?? last, i };
	});
	return timed.sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.m);
}

/** Whether a page's read reaches back to message `m`: it holds it, or it read past it in its conversation. */
function reaches(page: ConversationPage, m: TopicMessage): boolean {
	if (page.messages.some((x) => x.key === m.key)) return true;
	if (!page.more) return true;
	const o = m.original;
	return o !== null && page.nextSessionId === o.sessionId && page.nextBefore !== null && page.nextBefore <= o.entryId;
}

const cursorOf = (c: Cursor): Cursor => ({ more: c.more, nextBefore: c.nextBefore, nextSessionId: c.nextSessionId });

/**
 * Adds a page to the conversation shown, never dropping a message already shown: pages join by message. A newest
 * page that reaches what showed keeps the read point of the earliest messages. One that does not leaves a gap
 * between them, which the next reads of earlier messages fill before going on. An earlier page fills the gap
 * first, and closes it once it reaches the messages before it.
 */
export function joinConversation(
	prior: TopicConversation | undefined,
	page: ConversationPage,
	earlier: boolean,
): TopicConversation {
	const before = prior?.messages ?? [];
	const fresh = new Map(page.messages.map((m) => [m.key, m]));
	const known = new Set(before.map((m) => m.key));
	const added = page.messages.filter((m) => !known.has(m.key));
	const joined = earlier
		? [...added, ...before.map((m) => fresh.get(m.key) ?? m)]
		: [...before.map((m) => fresh.get(m.key) ?? m), ...added];
	const messages = chronological(joined);
	let cursor: Cursor = cursorOf(page);
	let gap = prior?.gap ?? null;
	if (!earlier && before.length > 0 && prior) {
		const newest = chronological(before)[before.length - 1] as TopicMessage;
		if (reaches(page, newest)) cursor = cursorOf(prior);
		else
			gap = {
				older: newest,
				newer: chronological(added)[0]?.key ?? null,
				resume: cursorOf(prior),
				under: prior.gap,
			};
	} else if (earlier && gap) {
		if (reaches(page, gap.older)) {
			cursor = gap.resume;
			gap = gap.under;
		} else {
			const oldest = chronological(added)[0];
			if (oldest) gap = { ...gap, newer: oldest.key };
		}
	}
	// A placed send shows as its message; a send still waiting shows once, at the end.
	const placed = new Set(messages.flatMap((m) => (m.operationId ? [m.operationId] : [])));
	const queued = (earlier ? (prior?.queued ?? []) : (page.queued ?? prior?.queued ?? [])).filter(
		(q) => !placed.has(q.operationId ?? ""),
	);
	return {
		availability: "live",
		reason: "",
		messages,
		queued,
		...cursor,
		complete: earlier ? (prior?.complete ?? page.complete) : page.complete,
		gap,
		reading: false,
	};
}

/** Adds a page to the activity shown: entries never change, so pages of one session join by ID. */
export function joinActivity(
	prior: TopicHistory | undefined,
	page: HistoryPage,
	which: "newest" | "older" | "original" | "latest",
	focus: Original | null,
	view: TopicHistory["view"],
): TopicHistory {
	const same = prior?.sessionId === page.sessionId ? prior : undefined;
	const ids = new Set(page.entries.map((e) => e.id));
	const oldest = page.entries[0]?.id ?? Number.MAX_SAFE_INTEGER;
	const joins = which === "older" || (which === "newest" && (same?.entries ?? []).some((e) => ids.has(e.id)));
	const kept = joins ? (same?.entries ?? []).filter((e) => !ids.has(e.id)) : [];
	const keepsOlder = which === "newest" && kept.some((e) => e.id < oldest);
	const entries = [...kept, ...page.entries].sort((a, b) => a.id - b.id);
	const keptFocus = which === "older" || which === "newest" ? (same?.focus ?? null) : null;
	const wanted = focus ?? keptFocus;
	return {
		availability: "live",
		reason: "",
		sessionId: page.sessionId,
		scope: page.scope,
		entries,
		more: keepsOlder ? (same?.more ?? false) : page.more,
		nextBefore: keepsOlder ? (same?.nextBefore ?? null) : page.nextBefore,
		reading: false,
		focus: wanted && entries.some((e) => e.id === wanted.entryId) ? wanted : null,
		view,
	};
}

/** A conversation the service does not send yet: never shown as an empty one. */
export const NO_CONVERSATION =
	"This Pilot service cannot show a thread's own conversation yet. Show activity has the original conversation.";

/** Why a topic's conversation could not be read. Never shown as an empty one. */
export function conversationReason(refusal: Refusal): string {
	switch (refusal) {
		case "stale":
			return "Pilot cannot read this thread's conversation now: the thread, its chat or access changed.";
		case "offline":
			return "Pilot could not reach its service to read this thread's conversation.";
		default:
			return "Pilot could not read this thread's conversation.";
	}
}

/** A read that failed: what showed stays, said to be from the last read. */
export function failedConversation(prior: TopicConversation | undefined, reason: string): TopicConversation {
	const shown = (prior?.messages.length ?? 0) + (prior?.queued.length ?? 0) > 0;
	return {
		availability: shown ? "live" : "unavailable",
		reason: shown ? `${reason} What shows is from Pilot's last read.` : reason,
		messages: prior?.messages ?? [],
		queued: prior?.queued ?? [],
		more: prior?.more ?? false,
		nextBefore: prior?.nextBefore ?? null,
		nextSessionId: prior?.nextSessionId ?? null,
		complete: prior?.complete ?? false,
		gap: prior?.gap ?? null,
		reading: false,
	};
}

/** An activity read that failed: what showed stays, said to be from the last read. */
export function failedActivity(prior: TopicHistory | undefined, reason: string): TopicHistory {
	const shown = (prior?.entries.length ?? 0) > 0;
	return {
		availability: shown ? "live" : "unavailable",
		reason: shown ? `${reason} What shows is from Pilot's last read.` : reason,
		sessionId: prior?.sessionId ?? "",
		scope: prior?.scope ?? "",
		entries: prior?.entries ?? [],
		more: prior?.more ?? false,
		nextBefore: prior?.nextBefore ?? null,
		reading: false,
		focus: prior?.focus ?? null,
		view: prior?.view ?? "default",
	};
}

/** How many pages one read of earlier messages reads at most to find one: pages may hold none of the topic's. */
export const EARLIER_PAGES = 8;

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
			if (o?.queued === true) return r("accepted", QUEUED_WORDS);
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

/** Reads one page of a topic's original conversation: its activity and the topic's own messages in it. */
export type PageReader = (
	missionId: string,
	topicId: string,
	before: number | null,
	sessionId: string | null,
) => Promise<{ page: HistoryPage | null; refusal: Refusal }>;

/**
 * Every topic's conversation and activity shown, kept by historyKey, so a page read for one topic never shows in
 * another. Reads of one topic run one at a time, in the order asked, so a late answer never overwrites a newer
 * one; a read asked again while it waits its turn runs once. The connected window reads pages from its root; the
 * mock window from its script.
 */
export class TopicReads {
	#histories = new Map<string, TopicHistory>();
	#conversations = new Map<string, TopicConversation>();
	#turns = new Map<string, Promise<void>>();
	#waiting = new Map<string, Set<string>>();
	#read: PageReader;
	#publish: () => void;
	#closed: () => boolean;

	constructor(read: PageReader, publish: () => void, closed: () => boolean) {
		this.#read = read;
		this.#publish = publish;
		this.#closed = closed;
	}

	histories(): Record<string, TopicHistory> {
		return Object.fromEntries(this.#histories);
	}

	conversations(): Record<string, TopicConversation> {
		return Object.fromEntries(this.#conversations);
	}

	/** Whether this topic's newest page was read, so a live change reads it again. */
	shown(key: string): boolean {
		return this.#conversations.has(key) || this.#histories.has(key);
	}

	/** Runs `work` after the topic's other reads. The same read waiting its turn runs once. */
	#turn(key: string, what: string, work: () => Promise<void>): Promise<void> {
		let waiting = this.#waiting.get(key);
		if (!waiting) {
			waiting = new Set();
			this.#waiting.set(key, waiting);
		}
		const last = this.#turns.get(key) ?? Promise.resolve();
		if (waiting.has(what)) return last;
		waiting.add(what);
		const next = last.then(() => {
			waiting.delete(what);
			return this.#closed() ? undefined : work();
		});
		const settled = next.catch(() => undefined);
		this.#turns.set(key, settled);
		return settled;
	}

	#set(key: string, history?: TopicHistory, conversation?: TopicConversation) {
		if (history) this.#histories.set(key, history);
		if (conversation) this.#conversations.set(key, conversation);
		this.#publish();
	}

	history(
		missionId: string,
		topicId: string,
		which: "newest" | "older" | "latest" = "newest",
		sessionId?: string,
	): Promise<void> {
		const key = historyKey(missionId, topicId);
		return this.#turn(key, `history:${which}:${sessionId ?? ""}`, async () => {
			const now = this.#histories.get(key);
			if (which === "older" && !now?.nextBefore) return;
			// A newest read leaves an activity the user moved; Show latest activity moves it back.
			const activity = which !== "newest" || !now || now.view === "default";
			const conversation = which === "newest" || (which === "latest" && !sessionId);
			this.#set(
				key,
				activity
					? { ...(now ?? failedActivity(undefined, "")), reading: true, reason: now?.reason ?? "" }
					: undefined,
				conversation ? readingConversationOf(this.#conversations.get(key)) : undefined,
			);
			const { page, refusal } = await this.#read(
				missionId,
				topicId,
				which === "older" ? (now?.nextBefore ?? null) : null,
				which === "older" ? (now?.sessionId ?? null) : (sessionId ?? null),
			);
			if (this.#closed()) return;
			const priorActivity = this.#histories.get(key);
			const priorConversation = this.#conversations.get(key);
			this.#set(
				key,
				activity
					? page
						? joinActivity(
								priorActivity,
								page,
								which,
								null,
								which === "older" ? (priorActivity?.view ?? "default") : sessionId ? "session" : "default",
							)
						: failedActivity(priorActivity, historyReason(refusal))
					: undefined,
				conversation
					? !page
						? failedConversation(priorConversation, conversationReason(refusal))
						: page.conversation
							? joinConversation(priorConversation, page.conversation, false)
							: failedConversation(undefined, NO_CONVERSATION)
					: undefined,
			);
		});
	}

	earlierMessages(missionId: string, topicId: string): Promise<void> {
		const key = historyKey(missionId, topicId);
		return this.#turn(key, "earlier", async () => {
			let now = this.#conversations.get(key);
			if (!now?.more) return;
			this.#set(key, undefined, readingConversationOf(now));
			// A page of an original conversation may hold none of this topic's messages: read on, a few pages at most.
			for (let n = 0; n < EARLIER_PAGES && now.more; n++) {
				const shown = now.messages.length;
				const gap = now.gap;
				const { page, refusal } = await this.#read(missionId, topicId, now.nextBefore, now.nextSessionId);
				if (this.#closed()) return;
				const prior = this.#conversations.get(key);
				if (!page?.conversation) {
					now = failedConversation(prior, page ? NO_CONVERSATION : conversationReason(refusal));
					break;
				}
				now = joinConversation(prior, page.conversation, true);
				if (now.messages.length > shown || now.gap !== gap) break;
				this.#set(key, undefined, { ...now, reading: true });
			}
			this.#set(key, undefined, { ...now, reading: false });
		});
	}

	original(missionId: string, topicId: string, original: Original): Promise<void> {
		const key = historyKey(missionId, topicId);
		return this.#turn(key, `original:${original.sessionId}:${original.entryId}`, async () => {
			const now = this.#histories.get(key);
			if (now?.sessionId === original.sessionId && now.entries.some((e) => e.id === original.entryId)) {
				this.#set(key, { ...now, focus: original });
				return;
			}
			this.#set(key, { ...(now ?? failedActivity(undefined, "")), reading: true, reason: now?.reason ?? "" });
			// The page that ends at this exact entry: before is the next ID.
			const { page, refusal } = await this.#read(missionId, topicId, original.entryId + 1, original.sessionId);
			if (this.#closed()) return;
			const prior = this.#histories.get(key);
			this.#set(
				key,
				page?.sessionId === original.sessionId && page.entries.some((e) => e.id === original.entryId)
					? joinActivity(prior, page, "original", original, "original")
					: failedActivity(prior, page ? ORIGINAL_MISSING : historyReason(refusal)),
			);
		});
	}
}

/** Marks a read on its way, keeping what shows. */
function readingConversationOf(prior: TopicConversation | undefined): TopicConversation {
	return {
		...(prior ?? failedConversation(undefined, "")),
		availability: prior?.availability === "live" ? "live" : "reading",
		reason: prior?.reason ?? "",
		reading: true,
	};
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
	// Writes whose reply was lost, by mission and operation: Pilot checks them by itself.
	#auto = new AutoCheck(
		(key) => this.#lookUp(key),
		() => this.#publish(),
	);
	#topics = new TopicReads(
		(missionId, topicId, before, sessionId) => this.#page(missionId, topicId, before, sessionId),
		() => this.#publish(),
		() => this.#closed,
	);
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
				ops: m.ops.map(
					(o): ThreadOp =>
						this.#checking.has(o.operationId) ||
						(o.state === "unknown" && this.#auto.checking(opKey(id, o.operationId)))
							? { ...o, state: "checking" }
							: o,
				),
				writing: this.#writing.has(id),
			};
		}
		return {
			missions,
			histories: this.#topics.histories(),
			conversations: this.#topics.conversations(),
		};
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
			// The first answer after the service could not be reached: look the lost writes up again.
			if (isRead && (m.refusal === "offline" || m.refusal === "lost")) this.#auto.restart();
			const snapshot = snapshotOf(r.snapshot, missionId);
			if (snapshot) {
				m.snapshot = snapshot;
				m.refusal = null;
			} else if (isRead) {
				m.refusal = "invalid";
			}
			const ops = opsOf(r.value.operations);
			if (ops) {
				m.ops = ops;
				this.#followUnknown();
			}
		} else if (isRead) {
			m.refusal = r.refusal;
		}
	}

	/** Follows every write, in every mission read here, whose result is Unknown. */
	#followUnknown() {
		const keys: string[] = [];
		for (const [id, m] of this.#missions)
			for (const o of m.ops) if (o.state === "unknown") keys.push(opKey(id, o.operationId));
		this.#auto.watch(keys);
	}

	/** One automatic Check: a receipt read only. It never sends the write again. */
	async #lookUp(key: string): Promise<void> {
		const [missionId, operationId] = key.split("\n") as [string, string];
		const r = await call<unknown>(this.#window, "day.threads.check", { operationId });
		if (this.#closed || !r.ok) return;
		this.#apply(missionId, r, false);
		this.#publish();
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

	/** One day.threads.history page. `sessionId` only names an exact conversation a cursor or a message gave. */
	async #page(
		missionId: string,
		topicId: string,
		before: number | null,
		sessionId: string | null,
	): Promise<{ page: HistoryPage | null; refusal: Refusal }> {
		const r = await call<unknown>(this.#window, "day.threads.history", {
			missionId,
			topicId,
			before,
			...(sessionId ? { sessionId } : {}),
		});
		if (!r.ok) return { page: null, refusal: r.refusal };
		return { page: historyPageOf(r.snapshot, missionId, topicId), refusal: "invalid" };
	}

	history(
		missionId: string,
		topicId: string,
		which: "newest" | "older" | "latest" = "newest",
		sessionId?: string,
	): Promise<void> {
		return this.#topics.history(missionId, topicId, which, sessionId);
	}

	earlierMessages(missionId: string, topicId: string): Promise<void> {
		return this.#topics.earlierMessages(missionId, topicId);
	}

	original(missionId: string, topicId: string, original: Original): Promise<void> {
		return this.#topics.original(missionId, topicId, original);
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
		this.#auto.close();
		this.#listeners.clear();
	}
}

/** One write's key for the automatic checks. IDs never hold a line break. */
function opKey(missionId: string, operationId: string): string {
	return `${missionId}\n${operationId}`;
}

/** The exact entry an Original message names is not in what the service read. */
export const ORIGINAL_MISSING = "Pilot could not find that exact message in its original conversation.";

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
