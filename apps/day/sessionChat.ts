// One chat Pilot started for the user, read only: a feedback triage or fix,
// or a chat started from New. `day.chat.read` opens it and reads its newest
// rows, or the page before what shows; `day.chat.snapshot` reads what the
// root last read (it reads the chat again as it changes, while it is open);
// `day.chat.close` stops that. Reading sends nothing to the chat and
// changes nothing. Only one chat is open at a time.
// `day.chat.continue` is the one write: it asks a stopped chat to go on with
// fixed words the service writes, sent once. `day.chat.check` reads its receipt.
import { type Signal, signal } from "nsh";
import type { ChatRow } from "pilot-day/native";
import { call, type Refusal } from "./bridge";

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
	specialist?: boolean;
	archived?: boolean;
	workspaceKept?: boolean;
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
	/** Asks stopped chat `sessionId` to continue. The service writes the words and sends them once. */
	continueChat(sessionId: string): Promise<ContinueResult>;
	/** Retry or corrected words, in this same failed/stopped chat. Empty means Retry. */
	recoverChat?(sessionId: string, message: string): Promise<ContinueResult>;
	/** Reads one Continue's exact receipt. Nothing is sent again. */
	checkContinue(operationId: string): Promise<ContinueResult>;
	dispose(): void;
}

/** What one Continue did. Unknown keeps its operation for Check. */
export type ContinueResult = {
	status: "accepted" | "rejected" | "unknown";
	message: string;
	operationId?: string;
	/** Exact words from the native operation, used only to clear an unchanged acknowledged draft. */
	submittedText?: string;
};

const CONTINUE_UNKNOWN = "Pilot does not know if Continue reached this chat. It will not send it again.";

function continueOutcome(x: unknown, recovery = false): ContinueResult {
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
	return {
		status: "unknown",
		message: recovery ? CONTINUE_UNKNOWN.replace("Continue", "Recovery") : CONTINUE_UNKNOWN,
		operationId,
		submittedText,
	};
}

function refusedContinue(refusal: Refusal, recovery = false): ContinueResult {
	switch (refusal) {
		case "lost":
			return {
				status: "unknown",
				message: recovery
					? "Recovery is Unknown. Reopen this chat to find its saved attempt. Nothing will be sent again."
					: `${CONTINUE_UNKNOWN} Press Continue again to find it.`,
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
		specialist: c.specialist === true,
		archived: c.archived === true,
		workspaceKept: c.workspaceKept === true,
		restartOnly: c.restartOnly === true,
		recoveryBlocked: typeof c.recoveryBlocked === "string" ? c.recoveryBlocked : "",
		pendingRecovery: c.pendingRecovery ? continueOutcome(c.pendingRecovery, true) : null,
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

	async continueChat(sessionId: string): Promise<ContinueResult> {
		const r = await call<unknown>(this.#window, "day.chat.continue", { sessionId });
		if (!r.ok) return refusedContinue(r.refusal);
		void this.refresh();
		return continueOutcome(r.value.outcome);
	}
	async recoverChat(sessionId: string, message: string): Promise<ContinueResult> {
		const r = await call<unknown>(this.#window, "day.chat.recover", { sessionId, message });
		void this.refresh();
		if (!r.ok) return refusedContinue(r.refusal, true);
		return continueOutcome(r.value.outcome, true);
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
