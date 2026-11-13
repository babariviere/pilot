// Demo mission threads. No daemon, journal, provider or storage: each
// mission's topics and one coordinator conversation in memory. `next` picks
// what the next write does, `held` makes the coordinator unable to take a
// message, and `reply()` writes the coordinator's answer, which never comes on
// its own: a sent message is not an answer. `writes`, `sends` and `checks`
// count calls, to prove nothing is resent.
import { signal } from "nsh";
import type { Refusal } from "./bridge";
import {
	acceptedWords,
	type HistoryEntry,
	historyKey,
	type MissionThreads,
	refusedWrite,
	type ThreadOp,
	type ThreadsSnapshot,
	type ThreadsSource,
	type ThreadsState,
	type ThreadWrite,
	type Topic,
	type TopicHistory,
	threadsReason,
	UNKNOWN_WRITE,
	type WriteResult,
} from "./threadFeed";

export type ThreadsDemoNext = "accept" | "unknown" | "stale" | "reject";

/** Entries per page, small so "Show earlier" shows in the demo. */
const PAGE = 6;

type Mission = {
	revision: number;
	topics: Topic[];
	entries: HistoryEntry[];
	ops: ThreadOp[];
	shown: boolean;
	writing: boolean;
};

function seed(id: string): Mission {
	const scope = `${id}-scope`;
	const later = `${id}-release`;
	const e = (
		n: number,
		role: HistoryEntry["role"],
		text: string,
		extra: Partial<HistoryEntry> = {},
	): HistoryEntry => ({
		id: n,
		kind: role === "coordinator" ? "pi.assistant" : role === "activity" ? "pi.tool-result" : "pilot.planning-input",
		role,
		text,
		shortened: false,
		referenced: false,
		input: false,
		sentIn: null,
		...extra,
	});
	return {
		revision: 1,
		shown: false,
		writing: false,
		ops: [],
		topics: [
			{
				id: scope,
				title: "Which file types are in scope?",
				revision: 3,
				disposition: "open",
				ownerSessionId: "s-coordinator",
				references: [{ kind: "task", id: "t-1" }],
				inputs: ["op-seed"],
			},
			{
				id: later,
				title: "What counts as released?",
				revision: 2,
				disposition: "later",
				ownerSessionId: "s-coordinator",
				references: [],
				inputs: [],
			},
		],
		entries: [
			e(1, "planning", ""),
			e(2, "coordinator", "I read the mission and its plan. I will keep to the agreed scope."),
			e(3, "activity", ""),
			e(4, "activity", ""),
			e(5, "coordinator", "The exporter reads Markdown today. PDFs need a separate reader."),
			e(6, "you", "Do we need PDFs in the first version?", { input: true, sentIn: scope }),
			e(7, "coordinator", "No. The agreement names Markdown only. I can ask about PDFs in a later round."),
			e(8, "activity", ""),
		],
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
	#missions = new Map<string, Mission>();
	#refused = new Set<string>();
	#histories = new Map<string, TopicHistory>();
	#listeners = new Set<(s: ThreadsState) => void>();
	#pending = new Map<string, () => WriteResult>();

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
				? { available: false, reason: "Planning admission is held or busy" }
				: { available: true, reason: "" },
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
		return { missions, histories: Object.fromEntries(this.#histories) };
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

	#marked(m: Mission, topic: Topic): HistoryEntry[] {
		return m.entries.map((e) => ({
			...e,
			input: e.sentIn === topic.id && e.role === "you",
			referenced: topic.references.some((r) => r.kind === "history" && r.entryId === e.id),
		}));
	}

	async history(missionId: string, topicId: string, older = false): Promise<void> {
		const m = this.#mission(missionId);
		const topic = m.topics.find((t) => t.id === topicId);
		const key = historyKey(missionId, topicId);
		const prior = this.#histories.get(key);
		if (!topic || this.unreadable()) {
			this.#histories.set(key, {
				availability: prior?.entries.length ? "live" : "unavailable",
				reason: "Pilot could not read the coordinator's conversation.",
				sessionId: "",
				entries: prior?.entries ?? [],
				more: prior?.more ?? false,
				nextBefore: prior?.nextBefore ?? null,
				reading: false,
			});
			this.#publish();
			return;
		}
		const all = this.#marked(m, topic);
		// Older pages join what shows; a fresh newest page keeps the older ones shown.
		const from = prior?.entries[0]?.id;
		const entries =
			from === undefined
				? all.slice(-PAGE)
				: older
					? [...all.filter((e) => e.id < from).slice(-PAGE), ...all.filter((e) => e.id >= from)]
					: all.filter((e) => e.id >= Math.min(from, all[Math.max(0, all.length - PAGE)]?.id ?? from));
		const first = entries[0]?.id ?? null;
		this.#histories.set(key, {
			availability: "live",
			reason: "",
			sessionId: topic.ownerSessionId,
			entries,
			more: first !== null && all[0]?.id !== first,
			nextBefore: first,
			reading: false,
		});
		this.#publish();
	}

	/** The coordinator writes an answer. Only this adds one. */
	reply(missionId: string, text: string) {
		const m = this.#mission(missionId);
		const id = (m.entries[m.entries.length - 1]?.id ?? 0) + 1;
		m.entries.push({
			id,
			kind: "pi.assistant",
			role: "coordinator",
			text,
			shortened: false,
			referenced: false,
			input: false,
			sentIn: null,
		});
		for (const t of m.topics)
			if (this.#histories.has(historyKey(missionId, t.id))) void this.history(missionId, t.id);
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
			});
			return id;
		}
		const t = m.topics.find((x) => x.id === write.topicId) as Topic;
		t.revision += 1;
		if (write.purpose === "thread-disposition") t.disposition = write.disposition;
		if (write.purpose === "thread-reference") t.references.push(write.reference);
		if (write.purpose === "thread-send") {
			t.inputs.push(operationId);
			const id = (m.entries[m.entries.length - 1]?.id ?? 0) + 1;
			m.entries.push({
				id,
				kind: "pilot.planning-input",
				role: "you",
				text: write.text,
				shortened: false,
				referenced: false,
				input: true,
				sentIn: t.id,
			});
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
		if (write.purpose === "thread-send" && (this.held() || topic?.disposition !== "open")) {
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
