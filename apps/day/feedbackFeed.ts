// The user's feedback about Pilot over the native root: `day.feedback.read`
// reads saved feedback newest first, Send sends the words once with the
// exact mission or chat the user kept, and Check only looks up a lost Send's
// receipt. Rust names the record; the service reads the origin's project and
// title. Feedback is the user's own words: saving it starts no work, routes
// nothing and approves nothing. A step (`day.feedback.step`) is one explicit
// act of the user's on saved feedback: start an agent triage or a small fix
// in a project the user chose, link a mission, or mark it resolved. Each is
// sent once; a lost one stays Unknown until Check reads its receipt.
// An answer is the user's reply to a triage's pending question, sent to that
// triage chat once. It clarifies the feedback; it starts and approves nothing.
import { type Signal, signal } from "nsh";
import { call, type Refusal, type Reply } from "./bridge";
import type {
	UserFeedback,
	UserFeedbackOrigin,
	UserFeedbackOriginRef,
	UserFeedbackProposal,
	UserFeedbackQuestion,
	UserFeedbackWorkView,
} from "./feedbackContract";
import { glide } from "./motion";

export type {
	UserFeedback,
	UserFeedbackOrigin,
	UserFeedbackOriginRef,
	UserFeedbackProposal,
	UserFeedbackQuestion,
	UserFeedbackWorkView,
};

/** At most this many UTF-8 bytes of feedback, as the service counts them. */
export const MAX_FEEDBACK_BYTES = 8192;

/** At most this many characters (UTF-16 units) in an answer, as the service counts them. */
export const MAX_ANSWER_LENGTH = 8000;

/** One saved piece of feedback, its place in the list and the user's steps on it, oldest first. */
export type FeedbackItem = UserFeedback & { sequence: number; work: UserFeedbackWorkView[] };

/** One Send whose result Pilot does not know. Only Check settles it. */
export type FeedbackOp = { operationId: string; state: "unknown" | "checking"; text: string };

/** One step whose result Pilot does not know, on one saved item. Only Check settles it. */
export type FeedbackStepOp = { operationId: string; state: "unknown" | "checking"; feedbackId: string; step: string };

/** A project agents can work in, as Pilot read it. The ID is the identity. */
export type FeedbackProject = { projectId: string; name: string; contextDigest: string };

/** One explicit step on one saved item. */
export type StepIntent = { feedbackId: string } & (
	| { action: "triage"; projectId: string; contextDigest: string }
	| { action: "fix"; projectId: string; contextDigest: string; triageSessionId: string; proposalDigest: string }
	| { action: "link"; missionId: string }
	| { action: "resolve" | "reopen" }
	| { action: "answer"; triageSessionId: string; questionId: number; message: string }
);

/** What the feedback page shows. */
export type FeedbackView = {
	/** "idle" before the page asked; "unavailable" when no read could be shown. */
	availability: "idle" | "reading" | "live" | "unavailable";
	/** Why nothing is shown, or why what is shown is from an earlier read. */
	reason: string;
	/** Saved feedback read so far, newest first. */
	items: FeedbackItem[];
	/** Whether older feedback is left to read. */
	more: boolean;
	/** Sends whose result is not known. */
	unsettled: FeedbackOp[];
	/** Steps whose result is not known. While one is, no other step is sent. */
	unsettledSteps: FeedbackStepOp[];
	/** The projects agents can work in, or null before a read or when none could be read. */
	projects: FeedbackProject[] | null;
	/** A read is on its way. */
	reading: boolean;
	/** A Send is on its way. */
	sending: boolean;
	/** The feedback a step is on its way for, or null. */
	stepping: string | null;
};

/** The words and, when the user kept one, the exact mission or chat they are about. */
export type SendIntent = { text: string; origin: UserFeedbackOriginRef | null };

/** What a Send or a Check did, for the user. */
export type SendResult = {
	status: "accepted" | "rejected" | "unknown";
	message: string;
	operationId: string | null;
	/** The saved feedback, when a receipt carried it. */
	saved: UserFeedback | null;
};

/** The feedback's source. The connected window asks its root; tests use a script. */
export interface FeedbackSource {
	view(): FeedbackView;
	onChange(listener: (view: FeedbackView) => void): () => void;
	/** Reads the newest page again. Passive: it sends and settles nothing. */
	read(): Promise<void>;
	/** Reads the next older page. Passive. */
	more(): Promise<void>;
	/** Sends one piece of feedback once. Never resent. */
	send(intent: SendIntent): Promise<SendResult>;
	/** Reads one unsettled Send's saved receipt. Never sends it again. */
	check(operationId: string): Promise<SendResult>;
	/** Reads the projects agents can work in. Passive. */
	readProjects(): Promise<void>;
	/** Sends one step once. Never resent. */
	step(intent: StepIntent): Promise<StepResult>;
	/** Reads one unsettled step's saved receipt. Never sends it again. */
	checkStep(operationId: string): Promise<StepResult>;
	dispose(): void;
}

/** What a step or its Check did, for the user. */
export type StepResult = { status: "accepted" | "rejected" | "stale" | "unknown"; message: string };

/** The UTF-8 length of `text`, as the service counts its limit. */
export function utf8Bytes(text: string): number {
	let n = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
	}
	return n;
}

/** Why saved feedback could not be read, in one calm sentence. */
export function feedbackReason(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service.";
		case "identity":
			return "The Pilot service changed. Open Pilot again to see your feedback.";
		case "closed":
		case "busy":
			return "Pilot is closing.";
		case "denied":
		case "unavailable":
			return "This Pilot service cannot keep feedback yet.";
		case "invalid":
			return "Pilot's service answered in a way this app does not understand.";
		default:
			return "Pilot could not read your feedback.";
	}
}

export const UNKNOWN_SEND =
	"Pilot sent your feedback but heard nothing back. It will not send it again; Check only reads.";

/** What a refused or lost Send means. Only a lost or uncertain one may have been saved. */
export function refusedSend(refusal: Refusal): SendResult {
	const r = (status: SendResult["status"], message: string): SendResult => ({
		status,
		message,
		operationId: null,
		saved: null,
	});
	switch (refusal) {
		case "lost":
		case "unknown":
			return r("unknown", UNKNOWN_SEND);
		case "busy":
			return r("rejected", "Pilot is busy. Nothing was sent; your text stays.");
		case "closed":
			return r("rejected", "Pilot is closing. Nothing was sent; your text stays.");
		case "offline":
			return r("rejected", "Pilot could not reach its service. Nothing was sent; your text stays.");
		case "identity":
			return r("rejected", "The Pilot service changed. Open Pilot again. Nothing was sent.");
		case "capacity":
		case "invalid":
			return r("rejected", "Pilot cannot send this feedback. Keep it shorter. Nothing was sent.");
		case "denied":
		case "unavailable":
			return r("rejected", "This Pilot service cannot keep feedback yet. Nothing was sent; your text stays.");
		default:
			return r("rejected", "Pilot could not send this. Nothing was sent; your text stays.");
	}
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function originOf(x: unknown): UserFeedbackOrigin | null | undefined {
	if (x === null) return null;
	const o = x as Record<string, unknown> | undefined;
	if (!o || typeof o !== "object" || typeof o.projectId !== "string" || typeof o.title !== "string") return undefined;
	if (o.kind === "mission" && typeof o.missionId === "string" && ID.test(o.missionId))
		return { kind: "mission", missionId: o.missionId, projectId: o.projectId, title: o.title };
	if (o.kind === "chat" && typeof o.sessionId === "string" && ID.test(o.sessionId))
		return { kind: "chat", sessionId: o.sessionId, projectId: o.projectId, title: o.title };
	return undefined;
}

/** Saved feedback the page can show. Anything else is not shown. */
export function feedbackOf(x: unknown): UserFeedback | null {
	const f = x as Record<string, unknown> | null;
	if (!f || typeof f !== "object" || typeof f.id !== "string" || typeof f.text !== "string") return null;
	if (typeof f.operationId !== "string" || typeof f.recordedAt !== "number") return null;
	const origin = originOf(f.origin);
	if (origin === undefined) return null;
	return { id: f.id, text: f.text, origin, recordedAt: f.recordedAt, operationId: f.operationId };
}

const STATES = ["starting", "working", "question", "done", "failed", "stopped", "archived", "missing"];
const NEXT = ["fix", "existing-mission", "new-mission", "none"];
const str = (v: unknown) => typeof v === "string";

function proposalOf(x: unknown): UserFeedbackWorkView["proposal"] | null {
	const p = x as Record<string, unknown> | null;
	if (!p || typeof p !== "object") return null;
	if (str(p.problem)) return { problem: p.problem as string };
	const v = p.value as Record<string, unknown> | null;
	if (!v || typeof v !== "object" || !str(p.digest) || !str(v.summary) || !str(v.detail)) return null;
	if (!NEXT.includes(v.next as string) || !Array.isArray(v.duplicates) || !v.duplicates.every(str)) return null;
	if ((v.missionId !== null && !str(v.missionId)) || (v.goal !== null && !str(v.goal))) return null;
	return { value: v as unknown as UserFeedbackProposal, digest: p.digest as string };
}

/** A triage's pending question, or null when it does not read. */
function questionOf(x: unknown): UserFeedbackQuestion | null {
	const q = x as Record<string, unknown> | null;
	if (!q || typeof q !== "object" || typeof q.id !== "number" || !str(q.question)) return null;
	if (q.context !== undefined && !str(q.context)) return null;
	if (!Array.isArray(q.options) || q.options.length > 9) return null;
	for (const o of q.options as Record<string, unknown>[])
		if (!o || !str(o.label) || (o.detail !== undefined && !str(o.detail))) return null;
	return q as unknown as UserFeedbackQuestion;
}

/** One saved step as a read shows it, or null when it does not read. */
function workOf(x: unknown): UserFeedbackWorkView | null {
	const w = x as Record<string, unknown> | null;
	if (!w || typeof w !== "object" || !str(w.operationId) || typeof w.recordedAt !== "number") return null;
	if (w.kind === "triage" || w.kind === "fix") {
		const chat = w.chat as Record<string, unknown> | undefined;
		if (!str(w.sessionId) || !str(w.projectId)) return null;
		if (chat !== undefined && (!chat || !str(chat.title) || !STATES.includes(chat.state as string))) return null;
		if (w.kind === "fix" && (!str(w.triageSessionId) || !str(w.proposalDigest))) return null;
		if (w.proposal !== undefined && !proposalOf(w.proposal)) return null;
		if (w.question !== undefined && !questionOf(w.question)) return null;
		return w as unknown as UserFeedbackWorkView;
	}
	if (w.kind === "mission") {
		const m = w.mission as Record<string, unknown> | null | undefined;
		if (!str(w.missionId) || !str(w.projectId)) return null;
		if (m && (!str(m.title) || !str(m.status) || typeof m.tasksDone !== "number")) return null;
		return w as unknown as UserFeedbackWorkView;
	}
	if (w.kind === "answer")
		return str(w.sessionId) && typeof w.questionId === "number" && str(w.text)
			? (w as unknown as UserFeedbackWorkView)
			: null;
	return w.kind === "resolved" || w.kind === "reopened" ? (w as unknown as UserFeedbackWorkView) : null;
}

/** The root's page: newest first, with its cursor. `older` marks a page after the first. */
type Page = { items: FeedbackItem[]; more: boolean; before: number | null; older: boolean };

/** A page whose items all read, newest first. Else null. */
export function pageOf(x: unknown): Page | null {
	const p = x as Record<string, unknown> | null;
	if (!p || typeof p !== "object" || p.version !== 1 || !Array.isArray(p.items) || typeof p.more !== "boolean")
		return null;
	const items: FeedbackItem[] = [];
	for (const raw of p.items as Record<string, unknown>[]) {
		const f = feedbackOf(raw);
		if (!f || typeof raw.sequence !== "number") return null;
		// An older service lists no steps; a step that does not read hides nothing else.
		const work: UserFeedbackWorkView[] = [];
		for (const w of Array.isArray(raw.work) ? raw.work : []) {
			const step = workOf(w);
			if (!step) return null;
			work.push(step);
		}
		items.push({ ...f, sequence: raw.sequence, work });
	}
	const before = typeof p.before === "number" ? p.before : null;
	return { items, more: p.more, before, older: p.older === true };
}

type Summary = { operationId: string; text: string; feedbackId: string | null; step: string | null };

function summariesOf(x: unknown): Summary[] | null {
	if (!Array.isArray(x)) return null;
	const out: Summary[] = [];
	for (const raw of x as Record<string, unknown>[]) {
		if (!raw || typeof raw.operationId !== "string") continue;
		const step = typeof raw.step === "string" && typeof raw.feedbackId === "string";
		out.push({
			operationId: raw.operationId,
			text: typeof raw.text === "string" ? raw.text : "",
			feedbackId: step ? (raw.feedbackId as string) : null,
			step: step ? (raw.step as string) : null,
		});
	}
	return out;
}

export const UNKNOWN_STEP = "Pilot sent this but heard nothing back. It will not send it again; Check only reads.";

/** What a refused or lost step means. Only a lost or uncertain one may have happened. */
export function refusedStep(refusal: Refusal): StepResult {
	switch (refusal) {
		case "lost":
			return { status: "unknown", message: UNKNOWN_STEP };
		case "unknown":
			return { status: "rejected", message: "An earlier step is not confirmed. Check it first; nothing was sent." };
		case "stale":
			return {
				status: "stale",
				message: "This project changed since Pilot read it. Choose it again. Nothing was sent.",
			};
		case "busy":
		case "closed":
			return { status: "rejected", message: "Pilot is closing. Nothing was sent." };
		case "offline":
			return { status: "rejected", message: "Pilot could not reach its service. Nothing was sent." };
		case "denied":
		case "unavailable":
			return { status: "rejected", message: "This Pilot service cannot triage feedback yet. Nothing was sent." };
		default:
			return { status: "rejected", message: "Pilot could not send this. Nothing was sent." };
	}
}

function stepOutcomeOf(x: unknown): StepResult {
	const o = x as { state?: unknown; receipt?: { reason?: unknown } | null } | null;
	if (o?.state === "accepted") return { status: "accepted", message: "" };
	if (o?.state === "rejected" || o?.state === "not-sent") {
		const reason = typeof o.receipt?.reason === "string" ? o.receipt.reason : "";
		return {
			status: "rejected",
			message: reason ? `Pilot's service refused it: ${reason}.` : "Pilot did not do it.",
		};
	}
	return { status: "unknown", message: UNKNOWN_STEP };
}

/** The projects a root's `day.projects.read` lists, or null when they do not read. */
function projectsOf(x: unknown): FeedbackProject[] | null {
	const s = x as { projects?: unknown } | null;
	if (!s || !Array.isArray(s.projects)) return null;
	const out: FeedbackProject[] = [];
	for (const p of s.projects as Record<string, unknown>[]) {
		if (!p || !str(p.projectId) || !str(p.name) || !str(p.contextDigest)) return null;
		out.push({ projectId: p.projectId as string, name: p.name as string, contextDigest: p.contextDigest as string });
	}
	return out;
}

/** A receipt's outcome. Only an accepted receipt naming the saved feedback proves a Send. */
function outcomeOf(x: unknown, operationId: string | null): SendResult {
	const o = x as { state?: unknown; receipt?: { reason?: unknown; result?: unknown } | null } | null;
	if (o?.state === "accepted") {
		const saved = feedbackOf(o.receipt?.result);
		if (saved) return { status: "accepted", message: "Saved. Thank you.", operationId, saved };
	}
	if (o?.state === "rejected" || o?.state === "not-sent") {
		const reason = typeof o.receipt?.reason === "string" ? o.receipt.reason : "";
		return {
			status: "rejected",
			message: reason
				? `Pilot's service refused it: ${reason}. Your text stays.`
				: "Pilot did not save it. Your text stays.",
			operationId,
			saved: null,
		};
	}
	return { status: "unknown", message: UNKNOWN_SEND, operationId, saved: null };
}

/** The connected window's feedback, through its native root. */
export class ConnectedFeedback implements FeedbackSource {
	#window: string;
	#items: FeedbackItem[] | null = null;
	#more = false;
	#before: number | null = null;
	#refusal: Refusal | null = null;
	#ops: Summary[] = [];
	#checking = new Set<string>();
	#reading: Promise<void> | null = null;
	#again = false;
	#asked = false;
	#sending = false;
	#stepping: string | null = null;
	#projects: FeedbackProject[] | null = null;
	#sent = 0;
	#applied = 0;
	#listeners = new Map<number, (view: FeedbackView) => void>();
	#next = 0;
	#closed = false;

	constructor(window: string) {
		this.#window = window;
	}

	view(): FeedbackView {
		const items = this.#items;
		const reason = this.#refusal
			? items
				? `${feedbackReason(this.#refusal)} What shows is from Pilot's last read.`
				: feedbackReason(this.#refusal)
			: "";
		return {
			availability: items ? "live" : this.#refusal ? "unavailable" : this.#asked ? "reading" : "idle",
			reason,
			items: items ?? [],
			more: this.#more,
			unsettled: this.#ops
				.filter((o) => o.step === null)
				.map((o) => ({
					operationId: o.operationId,
					state: this.#checking.has(o.operationId) ? "checking" : "unknown",
					text: o.text,
				})),
			unsettledSteps: this.#ops
				.filter((o) => o.step !== null)
				.map((o) => ({
					operationId: o.operationId,
					state: this.#checking.has(o.operationId) ? "checking" : "unknown",
					feedbackId: o.feedbackId ?? "",
					step: o.step ?? "",
				})),
			projects: this.#projects,
			reading: this.#reading !== null,
			sending: this.#sending,
			stepping: this.#stepping,
		};
	}

	onChange(listener: (view: FeedbackView) => void): () => void {
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

	/** One exact call. Only the newest call's first page replaces what is shown. */
	async #call(name: string, args: unknown): Promise<Reply<unknown>> {
		const order = ++this.#sent;
		const r = await call<unknown>(this.#window, name, args);
		if (this.#closed) return r;
		const reading = name === "day.feedback.read";
		if (r.ok) {
			const ops = summariesOf(r.value.operations);
			if (ops) this.#ops = ops;
			const page = pageOf(r.snapshot);
			if (page?.older) {
				// An older page continues the list it was asked for, never another one.
				if (this.#items && this.#before !== null && page.items.every((i) => i.sequence < (this.#before ?? 0))) {
					this.#items = [...this.#items, ...page.items];
					this.#more = page.more;
					this.#before = page.before;
				}
			} else if (page && order > this.#applied) {
				this.#items = page.items;
				this.#more = page.more;
				this.#before = page.before;
				this.#refusal = null;
				this.#applied = order;
			} else if (!page && reading && order > this.#applied) {
				this.#refusal = "invalid";
				this.#applied = order;
			}
		} else if (reading && order > this.#applied) {
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
				await this.#call("day.feedback.read", {});
				this.#publish();
			} while (this.#again && !this.#closed);
		})().finally(() => {
			this.#reading = null;
			this.#publish();
		});
		this.#publish();
		return this.#reading;
	}

	async more(): Promise<void> {
		if (!this.#more || this.#before === null) return;
		const r = await this.#call("day.feedback.read", { before: this.#before });
		if (!r.ok) this.#refusal = r.refusal;
		this.#publish();
	}

	async send(intent: SendIntent): Promise<SendResult> {
		if (this.#sending) return refusedSend("busy");
		if (this.#ops.some((o) => o.step === null)) {
			return {
				status: "unknown",
				message: "Earlier feedback is not confirmed. Check it first; nothing was sent.",
				operationId: null,
				saved: null,
			};
		}
		this.#sending = true;
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await this.#call("day.feedback.send", { text: intent.text, origin: intent.origin });
		} finally {
			this.#sending = false;
		}
		if (!r.ok) {
			// A lost answer may hide a saved Send: the read lists it as Unknown.
			void this.read();
			this.#publish();
			return refusedSend(r.refusal);
		}
		const outcome = r.value.outcome as { operationId?: unknown } | null;
		const id = typeof outcome?.operationId === "string" ? outcome.operationId : null;
		if (!pageOf(r.snapshot)) void this.read();
		this.#publish();
		return outcomeOf(outcome, id);
	}

	async check(operationId: string): Promise<SendResult> {
		if (this.#checking.has(operationId)) return refusedSend("busy");
		this.#checking.add(operationId);
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await this.#call("day.feedback.check", { operationId });
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
		const result = outcomeOf(r.value.outcome, operationId);
		if (result.status === "unknown")
			result.message = "Pilot's service has no result for it yet. Nothing was sent again.";
		return result;
	}

	async readProjects(): Promise<void> {
		const r = await call<unknown>(this.#window, "day.projects.read", {});
		if (this.#closed) return;
		// A failed read keeps the projects Pilot read before; none is chosen for the user.
		const projects = r.ok ? projectsOf(r.snapshot) : null;
		if (projects) this.#projects = projects;
		this.#publish();
	}

	async step(intent: StepIntent): Promise<StepResult> {
		if (this.#stepping) return refusedStep("busy");
		if (this.#ops.some((o) => o.step !== null)) return refusedStep("unknown");
		this.#stepping = intent.feedbackId;
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await this.#call("day.feedback.step", intent);
		} finally {
			this.#stepping = null;
		}
		if (!r.ok) {
			// A lost answer may hide a sent step: the read lists it as Unknown.
			void this.read();
			this.#publish();
			return refusedStep(r.refusal);
		}
		if (!pageOf(r.snapshot)) void this.read();
		this.#publish();
		return stepOutcomeOf(r.value.outcome);
	}

	async checkStep(operationId: string): Promise<StepResult> {
		if (this.#checking.has(operationId)) return refusedStep("busy");
		this.#checking.add(operationId);
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await this.#call("day.feedback.check", { operationId });
		} finally {
			this.#checking.delete(operationId);
		}
		this.#publish();
		if (!r.ok) return { status: "unknown", message: "Pilot could not check it now. Nothing was sent again." };
		if (!pageOf(r.snapshot)) void this.read();
		const result = stepOutcomeOf(r.value.outcome);
		if (result.status === "unknown")
			result.message = "Pilot's service has no result for it yet. Nothing was sent again.";
		return result;
	}

	dispose(): void {
		this.#closed = true;
		this.#listeners.clear();
	}
}

/** The feedback's view, mirrored in one signal that only the source's listener sets. */
export type FeedbackMirror = {
	source: FeedbackSource;
	view: Signal<FeedbackView>;
	close: () => void;
};

/** Mirrors `source`'s view. Rows that arrive glide to their places. */
export function mirrorFeedback(source: FeedbackSource): FeedbackMirror {
	const view = signal(source.view());
	const shape = (v: FeedbackView) => v.items.map((i) => i.id).join(",");
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
