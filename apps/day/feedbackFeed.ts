// The user's feedback about Pilot over the native root: `day.feedback.read`
// reads saved feedback newest first, Send sends the words once with the
// exact mission or chat the user kept, and Check only looks up a lost Send's
// receipt. Rust names the record; the service reads the origin's project and
// title. Feedback is the user's own words: saving it starts no work, routes
// nothing and approves nothing.
import { type Signal, signal } from "nsh";
import { call, type Refusal, type Reply } from "./bridge";
import type { UserFeedback, UserFeedbackOrigin, UserFeedbackOriginRef } from "./feedbackContract";
import { glide } from "./motion";

export type { UserFeedback, UserFeedbackOrigin, UserFeedbackOriginRef };

/** At most this many UTF-8 bytes of feedback, as the service counts them. */
export const MAX_FEEDBACK_BYTES = 8192;

/** One saved piece of feedback and its place in the list. */
export type FeedbackItem = UserFeedback & { sequence: number };

/** One Send whose result Pilot does not know. Only Check settles it. */
export type FeedbackOp = { operationId: string; state: "unknown" | "checking"; text: string };

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
	/** A read is on its way. */
	reading: boolean;
	/** A Send is on its way. */
	sending: boolean;
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
		items.push({ ...f, sequence: raw.sequence });
	}
	const before = typeof p.before === "number" ? p.before : null;
	return { items, more: p.more, before, older: p.older === true };
}

type Summary = { operationId: string; text: string };

function summariesOf(x: unknown): Summary[] | null {
	if (!Array.isArray(x)) return null;
	const out: Summary[] = [];
	for (const raw of x as Record<string, unknown>[]) {
		if (!raw || typeof raw.operationId !== "string") continue;
		out.push({ operationId: raw.operationId, text: typeof raw.text === "string" ? raw.text : "" });
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
			unsettled: this.#ops.map((o) => ({
				operationId: o.operationId,
				state: this.#checking.has(o.operationId) ? "checking" : "unknown",
				text: o.text,
			})),
			reading: this.#reading !== null,
			sending: this.#sending,
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
		if (this.#ops.length > 0) {
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
