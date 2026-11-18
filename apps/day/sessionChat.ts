// One chat Pilot started for the user, read only: a feedback triage or fix,
// or a chat started from New. `day.chat.read` opens it and reads its newest
// rows, or the page before what shows; `day.chat.snapshot` reads what the
// root last read (it reads the chat again as it changes, while it is open);
// `day.chat.close` stops that. Reading sends nothing to the chat and
// changes nothing. Only one chat is open at a time.
// `day.chat.continue` asks a stopped or failed chat to go on with fixed words
// the service writes, sent once. `day.chat.dismiss` takes a failed chat off
// Needs you and sends nothing to it. `day.chat.reply` sends the user's own
// words, once, to a chat waiting for a reply. `day.chat.check` reads any of
// these receipts.
import { type Signal, signal } from "nsh";
import type { ChatRow } from "pilot-day/native";
import { call, type Refusal } from "./bridge";
import { type CodingQueue, queueOf } from "./codingQueue";

/** Where the chat is: working, asking, finished, failed, stopped, quiet, or not read yet. */
export type SessionChatState = "unknown" | "working" | "question" | "done" | "failed" | "stopped" | "idle";

/** One chat as read. */
export type SessionChat = {
	sessionId: string;
	/** Its title, or "" before a good read. */
	title: string;
	sourcePath?: string;
	sourceLabel?: string;
	state: SessionChatState;
	/** The chat's own reason for its state, such as why it failed. */
	stateReason: string;
	/** While it waits for a coding slot: its place in line and what holds the slots. */
	queue?: CodingQueue | null;
	/** The service says Continue can move it: stopped, or failed with a safe retry. */
	canContinue?: boolean;
	/** Its question no longer needs the user: the plan settled it. */
	questionSettled?: boolean;
	specialist?: boolean;
	archived?: boolean;
	workspaceKept?: boolean;
	/** An opaque key for the open chat's eligible coding copy. */
	liveChangesKey?: string;
	restartOnly?: boolean;
	recoveryBlocked?: string;
	pendingRecovery?: ContinueResult | null;
	/** Rows read so far, oldest first. */
	rows: ChatRow[];
	/** Whether earlier rows can be read. */
	more: boolean;
	/** Whether a read is on its way. */
	reading: boolean;
	/** Why the chat or its newest part cannot be shown. Empty when it can. */
	reason: string;
};

/** The chat page's source. The connected window asks its root; tests use a script. */
export interface SessionChatSource {
	/** The open chat as read, or null. */
	chat(): SessionChat | null;
	onChange(listener: (chat: SessionChat | null) => void): () => void;
	/** Opens chat `sessionId` and reads its newest rows. Passive. */
	open(sessionId: string): Promise<void>;
	/** Reads the rows before what shows. Passive. */
	earlier(): Promise<void>;
	/** Reads what the root last read of the open chat. No service read. */
	refresh(): Promise<void>;
	/** Closes chat `sessionId` when it is open: it is no longer read or kept. */
	close(sessionId: string): void;
	/** Inspect only this chat's current private copy. No chat input or subscription. */
	readLiveChanges?(sessionId: string, workspaceKey: string): Promise<LiveChangesResult>;
	/** Asks stopped or failed chat `sessionId` to continue. The service writes the words and sends them once. */
	continueChat(sessionId: string): Promise<ContinueResult>;
	/** Retry or corrected words, in this same failed/stopped chat. Empty means Retry. */
	recoverChat?(sessionId: string, message: string): Promise<ContinueResult>;
	/** Takes failed chat `sessionId` off Needs you, once. It sends nothing to the chat. */
	dismissChat?(sessionId: string): Promise<ContinueResult>;
	/** Sends the user's own words once to chat `sessionId`, which waits for a reply. */
	replyChat?(sessionId: string, message: string): Promise<ContinueResult>;
	/** Reads one Continue's exact receipt. Nothing is sent again. */
	checkContinue(operationId: string): Promise<ContinueResult>;
	dispose(): void;
}

export type LiveChangesResult =
	| { status: "read"; fileCount: number; patch: string; truncated: boolean }
	| { status: "stale" | "unavailable" };

/** What one Continue did. Unknown keeps its operation for Check. */
export type ContinueResult = {
	status: "accepted" | "rejected" | "unknown";
	message: string;
	operationId?: string;
	/** Exact words from the native operation, used only to clear an unchanged acknowledged draft. */
	submittedText?: string;
};

const CONTINUE_UNKNOWN = "Pilot does not know if Continue reached this chat. It will not send it again.";
const REPLY_UNKNOWN = "Pilot does not know if your reply reached this chat. It will not send it again.";

const RECOVERY_UNKNOWN = CONTINUE_UNKNOWN.replace("Continue", "Recovery");

function continueOutcome(x: unknown, unknown = CONTINUE_UNKNOWN): ContinueResult {
	const o = x as {
		operationId?: unknown;
		submittedText?: unknown;
		state?: unknown;
		receipt?: { reason?: unknown } | null;
	} | null;
	const operationId = typeof o?.operationId === "string" ? o.operationId : undefined;
	const submittedText = typeof o?.submittedText === "string" ? o.submittedText : undefined;
	if (o?.state === "accepted") return { status: "accepted", message: "", operationId, submittedText };
	if (o?.state === "rejected" || o?.state === "not-sent") {
		const reason = typeof o.receipt?.reason === "string" ? o.receipt.reason : "";
		return {
			status: "rejected",
			message: reason ? `Pilot's service refused it: ${reason}.` : "Pilot did not send it.",
			operationId,
		};
	}
	return { status: "unknown", message: unknown, operationId, submittedText };
}

function refusedContinue(refusal: Refusal, unknown = CONTINUE_UNKNOWN): ContinueResult {
	switch (refusal) {
		case "lost":
			return {
				status: "unknown",
				message:
					unknown === RECOVERY_UNKNOWN
						? "Recovery is Unknown. Reopen this chat to find its saved attempt. Nothing will be sent again."
						: `${unknown} Press ${unknown === CONTINUE_UNKNOWN ? "Continue" : "Reply"} again to find it.`,
			};
		case "offline":
			return { status: "rejected", message: "Pilot could not reach its service. Nothing was sent." };
		case "busy":
		case "closed":
			return { status: "rejected", message: "Pilot is busy or closing. Nothing was sent." };
		default:
			return { status: "rejected", message: "Pilot could not send this. Nothing was sent." };
	}
}

const UNREAD = "Pilot could not read this chat. Nothing was sent.";

function chatOf(x: unknown, sessionId: string): SessionChat | null {
	const c = x as Partial<SessionChat> | null;
	if (!c || c.sessionId !== sessionId || !Array.isArray(c.rows)) return null;
	return {
		sessionId,
		title: typeof c.title === "string" ? c.title : "",
		sourcePath: typeof c.sourcePath === "string" ? c.sourcePath : "",
		sourceLabel: typeof c.sourceLabel === "string" ? c.sourceLabel : "",
		state: (c.state ?? "unknown") as SessionChatState,
		stateReason: typeof c.stateReason === "string" ? c.stateReason : "",
		queue: queueOf(c.queue),
		canContinue: c.canContinue === true,
		questionSettled: c.questionSettled === true,
		specialist: c.specialist === true,
		archived: c.archived === true,
		workspaceKept: c.workspaceKept === true,
		liveChangesKey: typeof c.liveChangesKey === "string" ? c.liveChangesKey : undefined,
		restartOnly: c.restartOnly === true,
		recoveryBlocked: typeof c.recoveryBlocked === "string" ? c.recoveryBlocked : "",
		pendingRecovery: c.pendingRecovery ? continueOutcome(c.pendingRecovery, RECOVERY_UNKNOWN) : null,
		rows: c.rows,
		more: c.more === true,
		reading: c.reading === true,
		reason: typeof c.reason === "string" ? c.reason : "",
	};
}

/** The chat page's source over this window's native root. */
export class ConnectedSessionChat implements SessionChatSource {
	#window: string;
	#chat: SessionChat | null = null;
	#listeners = new Map<number, (chat: SessionChat | null) => void>();
	#next = 0;
	#closed = false;

	constructor(window: string) {
		this.#window = window;
	}

	chat(): SessionChat | null {
		return this.#chat;
	}

	onChange(listener: (chat: SessionChat | null) => void): () => void {
		const id = this.#next++;
		this.#listeners.set(id, listener);
		return () => {
			this.#listeners.delete(id);
		};
	}

	#publish() {
		if (this.#closed) return;
		for (const listener of this.#listeners.values()) listener(this.#chat);
	}

	async #read(sessionId: string, older: boolean) {
		const prior = this.#chat?.sessionId === sessionId ? this.#chat : null;
		this.#chat = {
			...prior,
			sessionId,
			title: prior?.title ?? "",
			state: prior?.state ?? "unknown",
			stateReason: prior?.stateReason ?? "",
			queue: prior?.queue ?? null,
			rows: prior?.rows ?? [],
			more: prior?.more ?? false,
			reading: true,
			reason: prior?.reason ?? "",
		};
		this.#publish();
		const r = await call<unknown>(this.#window, "day.chat.read", { sessionId, older });
		// Closed or another chat opened meanwhile: drop the answer.
		if (this.#chat?.sessionId !== sessionId) return;
		const read = r.ok ? chatOf(r.snapshot, sessionId) : null;
		this.#chat = read ?? { ...this.#chat, reading: false, reason: UNREAD };
		this.#publish();
	}

	open(sessionId: string): Promise<void> {
		return this.#read(sessionId, false);
	}

	async earlier(): Promise<void> {
		const now = this.#chat;
		if (!now?.more || now.reading) return;
		await this.#read(now.sessionId, true);
	}

	async refresh(): Promise<void> {
		const id = this.#chat?.sessionId;
		if (!id) return;
		const r = await call<unknown>(this.#window, "day.chat.snapshot", { sessionId: id });
		if (this.#chat?.sessionId !== id || !r.ok) return;
		const read = chatOf(r.snapshot, id);
		if (!read) return;
		this.#chat = read;
		this.#publish();
	}

	close(sessionId: string): void {
		const id = this.#chat?.sessionId;
		if (id !== sessionId) return;
		this.#chat = null;
		this.#publish();
		void call(this.#window, "day.chat.close", { sessionId: id });
	}

	async readLiveChanges(sessionId: string, workspaceKey: string): Promise<LiveChangesResult> {
		const current = () =>
			!this.#closed && this.#chat?.sessionId === sessionId && this.#chat.liveChangesKey === workspaceKey;
		if (!current()) return { status: "stale" };
		const r = await call<{
			sessionId?: unknown;
			workspaceKey?: unknown;
			fileCount?: unknown;
			patch?: unknown;
			truncated?: unknown;
		} | null>(this.#window, "day.chat.liveChanges", { sessionId, workspaceKey });
		if (!current() || (!r.ok && r.refusal === "stale")) return { status: "stale" };
		if (!r.ok) return { status: "unavailable" };
		const s = r.snapshot;
		if (
			s?.sessionId !== sessionId ||
			s.workspaceKey !== workspaceKey ||
			typeof s.fileCount !== "number" ||
			!Number.isSafeInteger(s.fileCount) ||
			s.fileCount < 0 ||
			typeof s.patch !== "string" ||
			typeof s.truncated !== "boolean" ||
			(s.fileCount === 0 && (s.patch !== "" || s.truncated))
		)
			return { status: "unavailable" };
		return { status: "read", fileCount: s.fileCount, patch: s.patch, truncated: s.truncated };
	}

	async continueChat(sessionId: string): Promise<ContinueResult> {
		const r = await call<unknown>(this.#window, "day.chat.continue", { sessionId });
		if (!r.ok) return refusedContinue(r.refusal);
		void this.refresh();
		return continueOutcome(r.value.outcome);
	}
	async recoverChat(sessionId: string, message: string): Promise<ContinueResult> {
		const r = await call<unknown>(this.#window, "day.chat.recover", { sessionId, message });
		void this.refresh();
		if (!r.ok) return refusedContinue(r.refusal, RECOVERY_UNKNOWN);
		return continueOutcome(r.value.outcome, RECOVERY_UNKNOWN);
	}

	async dismissChat(sessionId: string): Promise<ContinueResult> {
		const r = await call<unknown>(this.#window, "day.chat.dismiss", { sessionId });
		if (!r.ok) return refusedContinue(r.refusal);
		return continueOutcome(r.value.outcome);
	}

	async replyChat(sessionId: string, message: string): Promise<ContinueResult> {
		const r = await call<unknown>(this.#window, "day.chat.reply", { sessionId, message });
		if (!r.ok) return refusedContinue(r.refusal, REPLY_UNKNOWN);
		void this.refresh();
		return continueOutcome(r.value.outcome, REPLY_UNKNOWN);
	}

	async checkContinue(operationId: string): Promise<ContinueResult> {
		const r = await call<unknown>(this.#window, "day.chat.check", { operationId });
		if (!r.ok)
			return { status: "unknown", message: "Pilot could not check it now. Nothing was sent again.", operationId };
		void this.refresh();
		const result = continueOutcome(r.value.outcome);
		return result.status === "unknown" ? { ...result, operationId: result.operationId ?? operationId } : result;
	}

	dispose(): void {
		this.#closed = true;
		this.#listeners.clear();
	}
}

/** The open chat, mirrored in one signal that only the source's listener sets. */
export type SessionChatMirror = {
	source: SessionChatSource;
	chat: Signal<SessionChat | null>;
	close: () => void;
};

export function mirrorSessionChat(source: SessionChatSource): SessionChatMirror {
	const chat = signal(source.chat());
	const stop = source.onChange((next) => chat.set(next));
	return {
		source,
		chat,
		close: () => {
			stop();
			source.dispose();
		},
	};
}
