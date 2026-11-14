// One chat Pilot started for the user, read only: a feedback triage or fix,
// or a chat started from New. `day.chat.read` opens it and reads its newest
// rows, or the page before what shows; `day.chat.snapshot` reads what the
// root last read (it reads the chat again as it changes, while it is open);
// `day.chat.close` stops that. Reading sends nothing to the chat and
// changes nothing. Only one chat is open at a time.
import { type Signal, signal } from "nsh";
import type { ChatRow } from "pilot-day/native";
import { call } from "./bridge";

/** Where the chat is: working, asking, finished, failed, stopped, quiet, or not read yet. */
export type SessionChatState = "unknown" | "working" | "question" | "done" | "failed" | "stopped" | "idle";

/** One chat as read. */
export type SessionChat = {
	sessionId: string;
	/** Its title, or "" before a good read. */
	title: string;
	state: SessionChatState;
	/** The chat's own reason for its state, such as why it failed. */
	stateReason: string;
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
	dispose(): void;
}

const UNREAD = "Pilot could not read this chat. Nothing was sent.";

function chatOf(x: unknown, sessionId: string): SessionChat | null {
	const c = x as Partial<SessionChat> | null;
	if (!c || c.sessionId !== sessionId || !Array.isArray(c.rows)) return null;
	return {
		sessionId,
		title: typeof c.title === "string" ? c.title : "",
		state: (c.state ?? "unknown") as SessionChatState,
		stateReason: typeof c.stateReason === "string" ? c.stateReason : "",
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
