// The screen agent's side of this window (docs/technical/day-screen-agent.md): it answers the agent's requests
// from the component registry, keeps the bar's conversation, and turns it into feedback. The native root
// tells the window when a request waits ("day.screen.requested"); the window takes it, answers it and sends
// the answer back. Pictures are the root's own: the window never sees their bytes.
import { host, signal } from "nsh";
import type { ChatChoice } from "pilot-day/native";
import { call } from "./bridge";
import { ConnectedChats } from "./chatFeed";
import { ConnectedFeedback } from "./feedbackFeed";
import { feedbackProject } from "./feedbackView";
import type { ScreenAnswer, ScreenPicture, ScreenRequest } from "./screenAgentContract";
import { ConnectedSessionChat, type SessionChat } from "./sessionChat";
import { todayProject } from "./todayScope";
import { act, onActed, query, setScreenHeader, snapshot } from "./ui";
import { dataSource } from "./view";
import { shownKey } from "./windowState";

/** Answers one request from this window's registry. Never throws: a failure is the agent's sentence. */
export async function answerRequest(request: ScreenRequest): Promise<ScreenAnswer> {
	const op = request.operation;
	try {
		if (op.op === "snapshot") return { ok: true, value: await snapshot() };
		if (op.op === "query") {
			const found = await query({ text: op.text, within: op.within, kind: op.kind });
			return "error" in found ? { ok: false, error: found.error } : { ok: true, value: found };
		}
		if (op.op === "act") return { ok: true, value: await act(op.steps) };
		return { ok: false, error: `This window does not answer ${op.op} requests.` };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Takes and answers waiting requests one at a time, in order, as UI SDK queues act and query calls. A notice
 * that arrives while it works makes it take again once it is done.
 */
export function screenRequests(window: string): { drain: () => Promise<void> } {
	let running: Promise<void> | null = null;
	let again = false;
	const drain = (): Promise<void> => {
		if (running) {
			again = true;
			return running;
		}
		running = (async () => {
			do {
				again = false;
				const r = await call<ScreenRequest[]>(window, "day.screen.take", {});
				if (!r.ok || !Array.isArray(r.snapshot)) return;
				for (const request of r.snapshot) {
					const answer = await answerRequest(request);
					await call(window, "day.screen.answer", { id: request.id, answer });
				}
			} while (again);
		})().finally(() => {
			running = null;
		});
		return running;
	};
	return { drain };
}

/** The screen header the agent reads first: where the window is and what it shows. */
export function screenHeader(): Record<string, unknown> {
	return {
		place: shownKey(),
		todayProject: todayProject(),
		data: dataSource(),
	};
}

/** What the bar knows about a pointed control. */
export type Pointed = { ref: string; component: string; label?: string };

/** The bar's conversation, read only, and the person's commands on it. */
export interface ScreenAgentSource {
	chat(): SessionChat | null;
	onChange(listener: (chat: SessionChat | null) => void): () => void;
	/** Sends the person's words: the first starts the chat, the rest reply to it. Resolves with a problem, or "". */
	ask(message: string): Promise<string>;
	/** The last picture the agent took of this window, or null. */
	picture(): Promise<ScreenPicture | null>;
	/** Saves feedback from this conversation and makes the conversation its triage. Resolves with what happened. */
	sendFeedback(text: string, picture: ScreenPicture | null): Promise<{ ok: boolean; message: string }>;
	dispose(): void;
}

/** The message the agent gets for a pointed control, before the person's words. */
export function pointedMessage(pointed: Pointed | null, words: string): string {
	if (!pointed) return words;
	const name = pointed.label ? ` "${pointed.label}"` : "";
	return `[The person points at ${pointed.ref}${name} (${pointed.component}).]\n${words}`;
}

/** What the agent is asked when the person presses Make feedback. */
export const FEEDBACK_REQUEST =
	'Write feedback for Pilot\'s developers about what we found: what is wrong, where, and what would be better. Reply with only one JSON object: {"text": "..."}, under 1000 characters.';

/** The feedback text of the agent's last answer, when it is the JSON object Make feedback asked for. */
export function feedbackDraft(chat: SessionChat | null): string | null {
	const last = [...(chat?.rows ?? [])].reverse().find((r) => r.role === "pilot");
	if (!last) return null;
	const body = last.text
		.trim()
		.replace(/^```(?:json)?\s*/u, "")
		.replace(/\s*```$/u, "");
	try {
		const value = JSON.parse(body) as { text?: unknown };
		return typeof value.text === "string" && value.text.trim() ? value.text.trim() : null;
	} catch {
		return null;
	}
}

const START_FAILED = "Pilot could not start the screen agent. Nothing was sent.";

/** The connected window's screen agent: Day's existing chat, feedback and picture calls. */
export class ConnectedScreenAgent implements ScreenAgentSource {
	#window: string;
	#chats: ConnectedChats;
	#session: ConnectedSessionChat;
	#feedback: ConnectedFeedback;
	#choice: ChatChoice | null = null;
	#sessionId: string | null = null;
	#stops: (() => void)[] = [];

	constructor(window: string) {
		this.#window = window;
		this.#chats = new ConnectedChats(window);
		this.#session = new ConnectedSessionChat(window);
		this.#feedback = new ConnectedFeedback(window);
		// The root re-reads the open chat on the service's notices; show its newest read.
		const changed = (payload: unknown) => {
			const p = payload as { version?: unknown; window?: unknown } | null;
			if (p?.version === 1 && p.window === window && this.#sessionId) void this.#session.refresh();
		};
		host.on("day.changed", changed);
	}

	chat() {
		return this.#session.chat();
	}

	onChange(listener: (chat: SessionChat | null) => void) {
		return this.#session.onChange(listener);
	}

	async ask(message: string): Promise<string> {
		if (this.#sessionId) {
			const r = await this.#session.replyChat(this.#sessionId, message);
			return r.status === "accepted" ? "" : r.message || "Pilot did not send it.";
		}
		return this.#start(message);
	}

	/** The project the agent works in: the feedback page's, else this window's, else the first. */
	#project() {
		const projects = this.#chats.view().projects;
		const want = [feedbackProject(), todayProject() === "all" ? null : todayProject(), this.#chats.view().current];
		for (const id of want) {
			const p = projects.find((x) => x.projectId === id);
			if (p) return p;
		}
		return projects[0] ?? null;
	}

	async #start(message: string): Promise<string> {
		await this.#chats.read();
		const project = this.#project();
		if (!project) return "Add a project in Settings first: the screen agent works in one.";
		const picked = await this.#chats.select({
			projectId: project.projectId,
			contextDigest: project.contextDigest,
			mode: "screen",
		});
		if (picked.status !== "accepted" || !picked.choice) return picked.message || START_FAILED;
		const made = await this.#chats.create(picked.choice, message);
		if (made.status !== "accepted") return made.message || START_FAILED;
		const sessionId = await this.#sessionOf(made.operationId);
		if (!sessionId) return "Pilot started the screen agent but did not say which chat it is. Try again in a moment.";
		this.#choice = picked.choice;
		this.#sessionId = sessionId;
		const bound = await call(this.#window, "day.screen.bind", { sessionId });
		await this.#session.open(sessionId);
		return bound.ok ? "" : "The screen agent started, but this window could not show itself to it.";
	}

	/** The chat a creation started, once its receipt names it. */
	async #sessionOf(operationId: string | null): Promise<string | null> {
		if (!operationId) return null;
		for (let i = 0; i < 4; i++) {
			const op = this.#chats.view().settled.find((o) => o.operationId === operationId);
			if (op?.sessionId) return op.sessionId;
			await new Promise((done) => setTimeout(done, 250 * (i + 1)));
			await this.#chats.read();
		}
		return null;
	}

	async picture(): Promise<ScreenPicture | null> {
		if (!this.#sessionId) return null;
		const r = await call<ScreenPicture | null>(this.#window, "day.screen.picture", { sessionId: this.#sessionId });
		return r.ok ? (r.snapshot ?? null) : null;
	}

	async sendFeedback(text: string, picture: ScreenPicture | null): Promise<{ ok: boolean; message: string }> {
		const sessionId = this.#sessionId;
		const choice = this.#choice;
		if (!sessionId || !choice) return { ok: false, message: "Ask the screen agent something first." };
		const sent = await this.#feedback.send({
			text,
			origin: { kind: "chat", sessionId },
			...(picture ? { attachments: [picture.attachment] } : {}),
		});
		if (sent.status !== "accepted" || !sent.saved)
			return { ok: false, message: sent.message || "Pilot did not save it." };
		const step = await this.#feedback.step({
			feedbackId: sent.saved.id,
			action: "triage",
			projectId: choice.projectId,
			contextDigest: choice.contextDigest,
			adoptSessionId: sessionId,
		});
		if (step.status !== "accepted")
			return {
				ok: true,
				message: `Feedback saved. Its triage did not start: ${step.message || "start it on the Feedback page."}`,
			};
		return { ok: true, message: "Feedback saved. This conversation is its triage now." };
	}

	dispose() {
		for (const stop of this.#stops) stop();
		if (this.#sessionId) void call(this.#window, "day.screen.unbind", {});
		this.#session.dispose();
		this.#chats.dispose();
		this.#feedback.dispose();
	}
}

/** Installs the window's request handling and header once. */
export function installScreenAgent(window: string) {
	setScreenHeader(screenHeader);
	const requests = screenRequests(window);
	host.on("day.screen.requested", (payload) => {
		const p = payload as { version?: unknown; window?: unknown } | null;
		if (p?.version === 1 && p.window === window) void requests.drain();
	});
}

/** The control an agent step just acted on, for the bar's ring. */
export const acted = signal<string | null>(null);
let actedTimer: ReturnType<typeof setTimeout> | undefined;
onActed((ref) => {
	acted.set(ref);
	clearTimeout(actedTimer);
	actedTimer = setTimeout(() => acted.set(null), 1500);
});
