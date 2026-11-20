// Demo mission threads. No daemon, journal, provider or storage: each
// mission's topics and its original conversations in memory (the
// coordinator's, and a thread chat once one starts). Pages come as the
// day.threads.history shape and go through the same
// TopicReads as the connected window. `next` picks what the next write does,
// `held` makes the coordinator unable to take a message, and `reply()`
// writes an answer, which never comes on its own: a sent message is not an
// answer. `holdReads` keeps page reads waiting until `releaseReads()`.
// `writes`, `sends`, `checks` and `reads` count calls, to prove nothing is resent.
import { signal } from "nsh";
import type { Refusal } from "../sources/refusals";
import {
	acceptedWords,
	type HistoryEntry,
	type HistoryPage,
	historyKey,
	historyPageOf,
	type MissionThreads,
	type Original,
	QUEUED_WORDS,
	refusedWrite,
	type ThreadOp,
	type ThreadsSnapshot,
	type ThreadsSource,
	type ThreadsState,
	type ThreadWrite,
	type Topic,
	TopicReads,
	threadsReason,
	UNKNOWN_WRITE,
	type WaitingMessage,
	type WriteResult,
} from "./threadFeed";

export type ThreadsDemoNext = "accept" | "unknown" | "stale" | "reject";

/** Entries per page, small so "Show earlier" shows in the demo. */
const PAGE = 6;

/** One saved entry of an original conversation, with when it was written. */
/**
 * One saved entry of an original conversation, with when it was written. A send carries its operation; an older
 * planning input may carry several sends (`batch`), each for its own thread.
 */
type DemoEntry = HistoryEntry & {
	at: number;
	operationId?: string;
	batch?: { operationId: string; topicId: string; text: string }[];
};

/** A long message, to show that every word of it stays readable. */
export const LONG_MESSAGE = [
	"Before we settle this, here is everything I know about PDFs, so the decision has the whole picture.",
	...Array.from(
		{ length: 12 },
		(_, i) =>
			`Point ${i + 1}: customers upload PDFs in about one in ten exports, mostly scanned contracts and invoices, and each one needs a separate reader that we would have to test against old files as well as new ones.`,
	),
	"Last line: if we leave PDFs out now, say so in the release notes.",
].join("\n\n");

type Mission = {
	revision: number;
	topics: Topic[];
	/** Original conversations by session: the coordinator's, and thread chats. */
	sessions: Map<string, DemoEntry[]>;
	/** Each topic's thread chats, oldest first. */
	chats: Map<string, string[]>;
	ops: ThreadOp[];
	shown: boolean;
	writing: boolean;
	waiting: WaitingMessage[];
};

/** A local time today (0) or `days` before, at `h`:`m`. */
function at(days: number, h: number, m: number): number {
	const d = new Date();
	d.setHours(h, m, 0, 0);
	d.setDate(d.getDate() - days);
	return d.getTime();
}

function topicOf(id: string, title: string, disposition: Topic["disposition"], references: Topic["references"]): Topic {
	return {
		id,
		title,
		revision: 1,
		disposition,
		ownerSessionId: COORDINATOR,
		references,
		inputs: [],
		chatSessionId: null,
		handoff: null,
		resolvedTaskIds: [],
	};
}

const COORDINATOR = "s-coordinator";

function entry(
	n: number,
	when: number,
	role: HistoryEntry["role"],
	text: string,
	sentIn: string | null = null,
): DemoEntry {
	return {
		id: n,
		kind:
			role === "coordinator" || role === "chat"
				? "pi.assistant"
				: role === "activity"
					? "pi.tool-result"
					: "pilot.planning-input",
		role,
		text,
		shortened: false,
		referenced: false,
		input: false,
		sentIn,
		at: when,
	};
}

function seed(id: string): Mission {
	const scope = `${id}-scope`;
	const later = `${id}-release`;
	const link = (entryId: number) => ({ kind: "history" as const, sessionId: COORDINATOR, entryId });
	return {
		revision: 1,
		shown: false,
		writing: false,
		waiting: [],
		ops: [],
		chats: new Map(),
		topics: [
			{
				...topicOf(scope, "Which file types are in scope?", "open", [
					{ kind: "task", id: "t-1" },
					link(3),
					link(8),
					link(14),
				]),
				revision: 3,
				inputs: ["op-seed"],
			},
			{ ...topicOf(later, "What counts as released?", "later", [link(14)]), revision: 2 },
		],
		sessions: new Map([
			[
				COORDINATOR,
				[
					entry(1, at(1, 14, 0), "planning", ""),
					entry(2, at(1, 14, 2), "you", "Which file types are in scope?", scope),
					entry(
						3,
						at(1, 14, 5),
						"coordinator",
						"Markdown for now. PDFs need a separate reader; we can decide here.",
					),
					entry(4, at(1, 14, 6), "activity", 'Tool call: read\n{"path":"exporter/README.md"}'),
					entry(
						5,
						at(1, 15, 0),
						"coordinator",
						"I read the mission and its plan. I will keep to the agreed scope.",
					),
					entry(6, at(1, 15, 1), "activity", "Tool result: read\n# Exporter\nReads Markdown files."),
					entry(7, at(1, 16, 20), "you", "Do customers still upload PDFs?", scope),
					entry(
						8,
						at(1, 16, 24),
						"coordinator",
						"Yes, about one in ten exports. The exporter reads Markdown only today.",
					),
					entry(9, at(0, 8, 40), "coordinator", "I checked the native build for another task. It passes."),
					entry(10, at(0, 8, 41), "activity", 'Tool call: bash\n{"command":"cargo build"}'),
					entry(11, at(0, 9, 10), "you", "Do we need PDFs in the first version?", scope),
					entry(12, at(0, 9, 11), "you", "Does released mean merged or tagged?", later),
					entry(13, at(0, 9, 11), "activity", "Tool result: bash\nFinished in 41s"),
					entry(
						14,
						at(0, 9, 12),
						"coordinator",
						"No PDFs in the first version: the agreement names Markdown only. Released means merged and tagged.",
					),
					entry(15, at(0, 9, 18), "you", LONG_MESSAGE, scope),
					{
						...entry(16, at(0, 9, 20), "you", "Also keep the CSV header row.\n\nTag only from main."),
						batch: [
							{ operationId: "op-batch-scope", topicId: scope, text: "Also keep the CSV header row." },
							{ operationId: "op-batch-release", topicId: later, text: "Tag only from main." },
						],
					},
				],
			],
		]),
	};
}

let minted = 0;

/** Every mission's topics and coordinator conversation, in memory. */
export class ScriptedThreads implements ThreadsSource {
	readonly next = signal<ThreadsDemoNext>("accept");
	readonly held = signal(false);
	readonly unreadable = signal(false);
	/** Why an unreadable read fails. */
	readonly refusal = signal<Refusal>("offline");
	readonly writes = signal(0);
	readonly sends = signal(0);
	readonly checks = signal(0);
	/** Page reads of conversations, to prove what reads and what does not. */
	readonly reads = signal(0);
	/** Conversation and activity reads fail, while the thread list still reads. */
	readonly pagesFail = signal(false);
	/** Some earlier replies have no saved thread link, so the conversation may miss them. */
	readonly unlinked = signal(false);
	/** Whether your unanswered messages have an answer is not known. */
	readonly replyUnknown = signal(false);
	/** The service has not learned which turn answered your messages yet: every reply status is unknown. */
	readonly linksUnknown = signal(false);
	/** The turn that took your latest message ended without a reply. */
	readonly turnEnded = signal(false);
	/** Old saved words of the scope thread whose place Pilot cannot tell, as the service reports them. */
	#unplaced: { operationId: string; text: string; timestamp: number }[] = [];
	/** Page reads wait until releaseReads(). */
	readonly holdReads = signal(false);
	#held: (() => void)[] = [];
	#missions = new Map<string, Mission>();
	#refused = new Set<string>();
	#listeners = new Set<(s: ThreadsState) => void>();
	#pending = new Map<string, () => WriteResult>();
	#topics = new TopicReads(
		(missionId, topicId, before, sessionId) => this.#page(missionId, topicId, before, sessionId),
		() => this.#publish(),
		() => false,
	);

	#mission(id: string): Mission {
		let m = this.#missions.get(id);
		if (!m) {
			m = seed(id);
			this.#missions.set(id, m);
		}
		return m;
	}

	#source(m: Mission): string {
		return `demo-${m.revision}`;
	}

	#snapshot(id: string, m: Mission): ThreadsSnapshot {
		return {
			missionId: id,
			source: this.#source(m),
			discussion: this.held()
				? { available: false, reason: "Planning admission is held or busy", waits: true }
				: { available: true, reason: "", waits: false },
			waiting: [...m.waiting],
			topics: m.topics.map((t) => ({ ...t, references: [...t.references], inputs: [...t.inputs] })),
			catalog: {
				known: true,
				tasks: [
					{ id: "t-1", number: 1, title: "Read the exporter", status: "done" },
					{ id: "t-2", number: 2, title: "Write the Markdown writer", status: "inProgress" },
				],
				decisions: [{ id: "d-1", number: 1, text: "Markdown only in the first version", withdrawn: false }],
			},
		};
	}

	state(): ThreadsState {
		const missions: Record<string, MissionThreads> = {};
		for (const [id, m] of this.#missions) {
			const refused = this.#refused.has(id);
			const failed = refused ? threadsReason(this.refusal()) : "";
			missions[id] = {
				availability: m.shown ? "live" : refused ? "unavailable" : "reading",
				reason: failed && m.shown ? `${failed} What shows is from Pilot's last read.` : failed,
				failed,
				snapshot: m.shown ? this.#snapshot(id, m) : null,
				ops: m.ops.map((o) => ({ ...o })),
				writing: m.writing,
			};
		}
		return { missions, histories: this.#topics.histories(), conversations: this.#topics.conversations() };
	}

	onChange(listener: (s: ThreadsState) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#publish() {
		const s = this.state();
		for (const l of this.#listeners) l(s);
	}

	async read(missionId: string): Promise<void> {
		const m = this.#mission(missionId);
		if (this.unreadable()) {
			this.#refused.add(missionId);
		} else {
			this.#refused.delete(missionId);
			m.shown = true;
		}
		this.#publish();
	}

	/** A topic's conversations, oldest first: its coordinator's, then its thread chats. */
	#sources(m: Mission, topic: Topic): string[] {
		return [topic.ownerSessionId, ...(m.chats.get(topic.id) ?? [])];
	}

	/** Whether an entry is the topic's own: your message in it, a linked reply, or anything of its own chat. */
	#belongs(topic: Topic, session: string, e: DemoEntry): boolean {
		if (session !== topic.ownerSessionId) return e.role === "you" || e.role === "chat";
		if (e.batch) return e.batch.some((b) => b.topicId === topic.id);
		if (e.role === "you") return e.sentIn === topic.id;
		return (
			e.role === "coordinator" &&
			topic.references.some((r) => r.kind === "history" && r.sessionId === session && r.entryId === e.id)
		);
	}

	/** One page as day.threads.history gives it. */
	#raw(m: Mission, missionId: string, topic: Topic, before: number | null, sessionId: string | null): unknown {
		const sources = this.#sources(m, topic);
		const selected = sessionId ?? (sources[sources.length - 1] as string);
		const index = sources.indexOf(selected);
		if (index < 0) return null;
		const chat = selected !== topic.ownerSessionId;
		const all = m.sessions.get(selected) ?? [];
		const page = all.filter((e) => before === null || e.id < before).slice(-PAGE);
		const more = page.length > 0 && (page[0] as DemoEntry).id > (all[0] as DemoEntry).id;
		const own = all.filter((e) => this.#belongs(topic, selected, e));
		const reply = (e: DemoEntry): string => {
			// Answered: a reply of the thread's follows it before your next message. Pilot knows only from the links.
			if (this.linksUnknown()) return "unknown";
			const next = own.filter((x) => x.id > e.id);
			const stop = next.findIndex((x) => x.role === "you");
			const until = stop < 0 ? next : next.slice(0, stop);
			if (until.some((x) => x.role !== "you")) return "answered";
			if (this.replyUnknown()) return "unknown";
			if (stop >= 0) return "unknown";
			return this.turnEnded() ? "unanswered" : "awaiting";
		};
		const older = index > 0 ? (sources[index - 1] as string) : null;
		return {
			version: 1,
			missionId,
			topicId: topic.id,
			sessionId: selected,
			scope: chat ? "thread-chat" : "coordinator-history",
			entries: page.map((e) => ({
				...e,
				input: e.role === "you" && e.sentIn === topic.id,
				referenced: topic.references.some(
					(r) => r.kind === "history" && r.sessionId === selected && r.entryId === e.id,
				),
			})),
			more,
			nextBefore: page[0]?.id ?? null,
			conversation: {
				queuedMessages: [
					...m.waiting
						.filter((w) => w.topicId === topic.id)
						.map((w) => ({ operationId: w.operationId, text: w.text, timestamp: null, replyState: "pending" })),
					...(topic === m.topics[0] ? this.#unplaced.map((u) => ({ ...u, replyState: "unknown" })) : []),
				],
				entries: page
					.filter((e) => this.#belongs(topic, selected, e))
					.flatMap((e) =>
						// One entry may carry several sends: each is its own message, with the same original.
						(
							e.batch?.filter((b) => b.topicId === topic.id) ?? [{ operationId: e.operationId, text: e.text }]
						).map((b) => ({
							id: e.id,
							...(b.operationId ? { operationId: b.operationId } : {}),
							sessionId: selected,
							role: e.role,
							text: b.text,
							timestamp: e.at,
							replyState: e.role === "you" ? reply(e) : "unknown",
							shared: !chat && e.role === "coordinator",
							original: { kind: "history", sessionId: selected, entryId: e.id },
						})),
					),
				more: more || older !== null,
				nextBefore: more ? (page[0] as DemoEntry).id : null,
				nextSessionId: more ? selected : older,
				earlierContext: this.unlinked() ? "unknown" : "complete",
			},
		};
	}

	async #page(
		missionId: string,
		topicId: string,
		before: number | null,
		sessionId: string | null,
	): Promise<{ page: HistoryPage | null; refusal: Refusal }> {
		this.reads.update((n) => n + 1);
		if (this.holdReads()) await new Promise<void>((go) => this.#held.push(go));
		const m = this.#mission(missionId);
		const topic = m.topics.find((t) => t.id === topicId);
		if (!topic || this.unreadable() || this.pagesFail()) return { page: null, refusal: this.refusal() };
		return {
			page: historyPageOf(this.#raw(m, missionId, topic, before, sessionId), missionId, topicId),
			refusal: "invalid",
		};
	}

	/** Lets every waiting page read finish, in the order asked. */
	releaseReads() {
		this.holdReads.set(false);
		const held = this.#held;
		this.#held = [];
		for (const go of held) go();
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

	/** Reads the newest page again of every topic on screen, as a live change does. */
	#refresh(missionId: string) {
		for (const t of this.#mission(missionId).topics)
			if (this.#topics.shown(historyKey(missionId, t.id))) void this.history(missionId, t.id);
	}

	/** The next entry ID of a conversation. */
	#next(m: Mission, session: string): number {
		const all = m.sessions.get(session) ?? [];
		return (all[all.length - 1]?.id ?? 0) + 1;
	}

	/**
	 * The coordinator writes an answer. Only this adds one. It belongs to the threads in `topicIds` only because
	 * they link this exact entry; with none, it shows only in the activity.
	 */
	reply(missionId: string, text: string, topicIds: string[] = []) {
		const m = this.#mission(missionId);
		const id = this.#next(m, COORDINATOR);
		m.sessions.get(COORDINATOR)?.push(entry(id, Date.now(), "coordinator", text));
		for (const t of m.topics)
			if (topicIds.includes(t.id)) {
				t.references.push({ kind: "history", sessionId: COORDINATOR, entryId: id });
				t.revision += 1;
			}
		this.#refresh(missionId);
		this.#publish();
	}

	/**
	 * The coordinator works on other things for a while, then answers the scope thread: more entries than one page,
	 * so the newest page does not reach what showed before.
	 */
	busy(missionId: string, text: string) {
		const m = this.#mission(missionId);
		const log = m.sessions.get(COORDINATOR);
		for (let i = 0; i < PAGE; i++)
			log?.push(entry(this.#next(m, COORDINATOR), Date.now(), "activity", `Tool call: read\n{"step":${i + 1}}`));
		this.reply(missionId, text, [(m.topics[0] as Topic).id]);
	}

	/** Whether the service knows which turns answered your messages; a change reads the thread again. */
	learnLinks(missionId: string, known: boolean) {
		this.linksUnknown.set(!known);
		this.#refresh(missionId);
		this.#publish();
	}

	/** The service reports old saved words of the scope thread whose place it cannot tell. */
	unplace(missionId: string) {
		this.#unplaced = Array.from({ length: 6 }, (_, i) => ({
			operationId: `op-old-${i}`,
			text: `Old carried words ${i}. ${"These words were saved before Pilot kept their place. ".repeat(5)}`,
			timestamp: at(2, 10, i),
		}));
		this.#refresh(missionId);
		this.#publish();
	}

	/** Their places were learned in older history: the service stops reporting them. */
	placeOld(missionId: string) {
		this.#unplaced = [];
		this.#refresh(missionId);
		this.#publish();
	}

	/** Messages that waited for the coordinator are placed in its conversation, under their own operations. */
	placeWaiting(missionId: string) {
		const m = this.#mission(missionId);
		const log = m.sessions.get(COORDINATOR);
		for (const w of m.waiting)
			log?.push({
				...entry(this.#next(m, COORDINATOR), Date.now(), "you", w.text, w.topicId),
				operationId: w.operationId,
			});
		m.waiting = [];
		this.#refresh(missionId);
		this.#publish();
	}

	/** The scope thread's chat answers in its own chat. */
	chatReply(missionId: string, text: string) {
		const m = this.#mission(missionId);
		const t = m.topics[0] as Topic;
		const chat = m.chats.get(t.id)?.at(-1);
		if (!chat) return;
		m.sessions.get(chat)?.push(entry(this.#next(m, chat), Date.now(), "chat", text));
		this.#refresh(missionId);
		this.#publish();
	}

	/** The scope thread moved to its own chat, which handed off agreed work to the planner. */
	handOff(missionId: string) {
		const m = this.#mission(missionId);
		const t = m.topics[0] as Topic;
		t.revision += 1;
		t.chatSessionId = "s-thread-chat";
		m.chats.set(t.id, ["s-thread-chat"]);
		m.sessions.set("s-thread-chat", [
			entry(1, at(0, 10, 0), "you", "Can we export CSV and JSON first?"),
			entry(2, at(0, 10, 1), "activity", ""),
			entry(3, at(0, 10, 2), "chat", "Yes. CSV and JSON first, PDFs later. I sent that to the planner."),
		]);
		t.handoff = {
			id: "h-1",
			summary: "Export CSV and JSON first; PDFs later.",
			tasks: [{ key: "csv", title: "Export CSV and JSON" }],
			queued: true,
		};
		m.revision += 1;
		this.#refresh(missionId);
		this.#publish();
	}

	/** The planner's revision for the scope thread was confirmed: it resolved the thread with task #1. */
	resolve(missionId: string) {
		const m = this.#mission(missionId);
		const t = m.topics[0]!;
		t.revision += 1;
		t.disposition = "resolved";
		t.resolvedTaskIds = ["t-1"];
		m.revision += 1;
		this.#publish();
	}

	/** The mission changed elsewhere, so a shown source is stale. */

	changeElsewhere(missionId: string) {
		this.#mission(missionId).revision += 1;
	}

	#apply(m: Mission, write: ThreadWrite, operationId: string): string {
		m.revision += 1;
		if (write.purpose === "thread-create") {
			minted += 1;
			const id = `demo-topic-${minted}`;
			m.topics.push({
				id,
				title: write.title,
				revision: 1,
				disposition: "open",
				ownerSessionId: "s-coordinator",
				references: [],
				inputs: [],
				chatSessionId: null,
				handoff: null,
				resolvedTaskIds: [],
			});
			return id;
		}
		const t = m.topics.find((x) => x.id === write.topicId) as Topic;
		t.revision += 1;
		if (write.purpose === "thread-disposition") t.disposition = write.disposition;
		if (write.purpose === "thread-reference") t.references.push(write.reference);
		if (write.purpose === "thread-send") {
			t.inputs.push(operationId);
			// It goes to the thread's chat once it has one, else to the coordinator.
			const session = m.chats.get(t.id)?.at(-1) ?? COORDINATOR;
			m.sessions.get(session)?.push(entry(this.#next(m, session), Date.now(), "you", write.text, t.id));
		}
		return t.id;
	}

	async write(missionId: string, source: string, write: ThreadWrite): Promise<WriteResult> {
		const m = this.#mission(missionId);
		if (m.writing) return refusedWrite("busy");
		if (m.ops.some((o) => o.state === "unknown")) return refusedWrite("unknown");
		if (source !== this.#source(m)) return refusedWrite("stale");
		const topic = "topicId" in write ? m.topics.find((t) => t.id === write.topicId) : undefined;
		if ("topicId" in write && !topic) return refusedWrite("stale");
		if (write.purpose === "thread-send" && topic?.disposition === "open" && this.held()) {
			// The coordinator cannot take it now: saved to wait, as the service does.
			this.writes.update((n) => n + 1);
			minted += 1;
			const operationId = `demo-op-${minted}`;
			m.revision += 1;
			topic.revision += 1;
			topic.inputs.push(operationId);
			m.waiting.push({ operationId, topicId: topic.id, text: write.text });
			m.ops.push({
				operationId,
				purpose: write.purpose,
				topicId: topic.id,
				text: write.text,
				state: "accepted",
				reason: "",
				queued: true,
			});
			this.#publish();
			return { status: "accepted", message: QUEUED_WORDS, operationId, topicId: topic.id };
		}
		if (write.purpose === "thread-send" && topic?.disposition !== "open") {
			return {
				status: "refused",
				message:
					"The coordinator cannot take a message now: it needs an active, unheld planning coordinator. Nothing was sent.",
				operationId: null,
				topicId: null,
			};
		}
		this.writes.update((n) => n + 1);
		if (write.purpose === "thread-send") this.sends.update((n) => n + 1);
		const next = this.next();
		this.next.set("accept");
		minted += 1;
		const operationId = `demo-op-${minted}`;
		const op: ThreadOp = {
			operationId,
			purpose: write.purpose,
			topicId: "topicId" in write ? write.topicId : "",
			text: write.purpose === "thread-send" ? write.text : null,
			state: "accepted",
			reason: "",
		};
		if (next === "stale") {
			m.revision += 1;
			this.#publish();
			return refusedWrite("stale");
		}
		if (next === "reject") {
			op.state = "rejected";
			op.reason = "Topic needs an open, active unheld trusted planning owner";
			m.ops.push(op);
			this.#publish();
			return {
				status: "rejected",
				message: `Pilot's service refused it: ${op.reason}. Nothing changed; your words stay.`,
				operationId,
				topicId: op.topicId,
			};
		}
		const topicId = this.#apply(m, write, operationId);
		op.topicId = topicId;
		if (next === "unknown") {
			// The service did it, but the answer was lost.
			op.state = "unknown";
			m.ops.push(op);
			this.#pending.set(operationId, () => {
				op.state = "accepted";
				return { status: "accepted", message: acceptedWords(write.purpose, write), operationId, topicId };
			});
			this.#publish();
			return { status: "unknown", message: UNKNOWN_WRITE, operationId: null, topicId: null };
		}
		m.ops.push(op);
		this.#publish();
		return { status: "accepted", message: acceptedWords(write.purpose, write), operationId, topicId };
	}

	async check(_missionId: string, operationId: string): Promise<WriteResult> {
		this.checks.update((n) => n + 1);
		const settle = this.#pending.get(operationId);
		if (!settle) {
			return {
				status: "unknown",
				message: "Pilot's service has no result for it yet. Nothing was sent again.",
				operationId,
				topicId: null,
			};
		}
		this.#pending.delete(operationId);
		const r = settle();
		this.#publish();
		return r;
	}

	dispose(): void {
		this.#listeners.clear();
	}
}
