// Standalone New chat over the native root: the profile's projects, a
// passive selection of one project and access level, an explicit creation,
// and a lookup-only Check (docs/technical/day-new-chat.md). Reading and
// selecting create nothing. A creation names the exact choice Pilot last
// selected and the user's exact words; Rust saves it and sends it once. A
// creation whose answer is lost stays Unknown, also after reopening, and
// blocks another until Check reads its saved receipt. Nothing here picks a
// project for the user after a refusal.
import { type Signal, signal } from "nsh";
import type { ChatChoice } from "pilot-day/native";
import { call, type Refusal, type Reply } from "./bridge";

/** What a new chat may do: Ask reads only; Build uses the project's own workspace and limits. */
export type ChatMode = "ask" | "build";

/** One project of the profile, as Pilot read it. The ID is the identity; names can repeat. */
export type ChatProject = { projectId: string; projectPath: string; name: string; contextDigest: string };

/** One saved creation. Unknown until a receipt says otherwise; "checking" while Check reads it. */
export type ChatOp = {
	operationId: string;
	draftId: string;
	projectId: string;
	delivery: "unknown" | "checking" | "accepted" | "rejected";
	/** Why the service refused it, exactly as written. */
	reason: string;
};

/** What New shows about projects and creations. */
export type ChatView = {
	/** "reading" before the first answer; "unavailable" when no list could be shown. */
	availability: "reading" | "live" | "unavailable";
	/** Why the list is not shown, or why what shows is from an earlier read. */
	reason: string;
	/** Every project, in Pilot's order. */
	projects: ChatProject[];
	/** The project this window opened for (Today's), when Pilot said which. Missions start there. */
	current: string | null;
	/** Creations whose result is not known. Only Check settles them, and none other starts meanwhile. */
	unsettled: ChatOp[];
	/** Creations settled while this window was open, oldest first. */
	settled: ChatOp[];
	/** Whether a creation is on its way. */
	creating: boolean;
};

/** What a selection, creation or Check did, for the user. */
export type ChatResult = {
	status: "accepted" | "stale" | "rejected" | "unknown";
	message: string;
	/** The selected choice, for an accepted selection. */
	choice: ChatChoice | null;
	operationId: string | null;
};

/** The project and access the user asked for. Selecting it is passive. */
export type ChatPick = { projectId: string; contextDigest: string; mode: ChatMode };

/** New's chat source. The connected window's talks to its root; the mock windows' is a script. */
export interface ChatSource {
	view(): ChatView;
	onChange(listener: (view: ChatView) => void): () => void;
	/** Reads the projects and saved creations again. Passive: it sends, starts and settles nothing. */
	read(): Promise<void>;
	/** Asks Pilot for this project's chat setup. Passive; only the newest selection counts. */
	select(pick: ChatPick): Promise<ChatResult>;
	/** Creates one chat with exactly `message`, for the exact `choice` selected last. Sent once. */
	create(choice: ChatChoice, message: string): Promise<ChatResult>;
	/** Reads one unsettled creation's saved receipt. Never sends it again. */
	check(operationId: string): Promise<ChatResult>;
	/** Shows how a restored window's draft ended, if Pilot saved its creation. Reads and sends nothing. */
	adopt(draftId: string): void;
	dispose(): void;
}

/** The same promise everywhere a creation's answer was lost. */
export const CHAT_UNKNOWN = "Pilot sent this but heard nothing back. It will not send it again; Check only reads.";

/** Builds a result. */
export function chatResult(
	status: ChatResult["status"],
	message: string,
	extra: Partial<Pick<ChatResult, "choice" | "operationId">> = {},
): ChatResult {
	return { status, message, choice: extra.choice ?? null, operationId: extra.operationId ?? null };
}

/** Why the projects could not be read, in one calm sentence. */
export function projectsReason(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service.";
		case "identity":
			return "The Pilot service changed. Open Pilot again to see your projects.";
		case "closed":
		case "busy":
			return "Pilot is closing.";
		case "capacity":
			return "You have more projects than one read holds, so Pilot shows none of them.";
		case "denied":
		case "unavailable":
			return "This Pilot service cannot list projects here yet.";
		case "invalid":
			return "Pilot's service answered in a way this app does not understand.";
		default:
			return "Pilot could not read your projects.";
	}
}

/** What a refused selection means. Nothing was sent: selecting never creates. */
function refusedSelect(refusal: Refusal): ChatResult {
	switch (refusal) {
		case "unknown":
			return chatResult("unknown", "An earlier new chat is not confirmed. Check it before you start another.");
		case "stale":
			return chatResult("stale", "This project changed while Pilot read it. Choose it again.");
		case "lost":
			return chatResult("rejected", "Pilot did not answer. Nothing was sent; choose the project again.");
		default:
			return chatResult("rejected", `${projectsReason(refusal)} Nothing was sent.`);
	}
}

/** What a refused creation means. Every refusal here is before sending, except a lost answer. */
function refusedCreate(refusal: Refusal): ChatResult {
	switch (refusal) {
		case "lost":
			return chatResult("unknown", CHAT_UNKNOWN);
		case "unknown":
			return chatResult("rejected", "An earlier new chat is not confirmed. Check it first; nothing was sent.");
		case "stale":
			return chatResult(
				"stale",
				"This project or its setup changed since Pilot read it. Nothing was sent; your words stay.",
			);
		case "busy":
			return chatResult("rejected", "Pilot is saving this window before it closes. Nothing was sent.");
		case "closed":
			return chatResult("rejected", "Pilot is closing. Nothing was sent.");
		case "offline":
			return chatResult("rejected", "Pilot could not reach its service. Nothing was sent; your words stay.");
		case "identity":
			return chatResult("rejected", "The Pilot service changed. Open Pilot again. Nothing was sent.");
		case "denied":
		case "unavailable":
			return chatResult("rejected", "Pilot cannot start chats here. Nothing was sent.");
		default:
			return chatResult("rejected", "Pilot could not send this. Nothing was sent; your words stay.");
	}
}

type Summary = {
	operationId: string;
	draftId: string;
	projectId: string;
	state: string;
	receipt?: { state?: string; reason?: string } | null;
};

function projectsOf(x: unknown): ChatProject[] | null {
	const s = x as { version?: unknown; complete?: unknown; projects?: unknown } | null;
	if (s?.version !== 1 || s.complete !== true || !Array.isArray(s.projects)) return null;
	const rows = s.projects as Partial<ChatProject>[];
	const ok = rows.every(
		(p) =>
			!!p &&
			typeof p.projectId === "string" &&
			typeof p.projectPath === "string" &&
			typeof p.name === "string" &&
			typeof p.contextDigest === "string",
	);
	return ok
		? rows.map((p) => ({
				projectId: p.projectId as string,
				projectPath: p.projectPath as string,
				name: p.name as string,
				contextDigest: p.contextDigest as string,
			}))
		: null;
}

function summariesOf(x: unknown): Summary[] | null {
	if (!Array.isArray(x)) return null;
	return x.filter(
		(o): o is Summary =>
			!!o && typeof o.operationId === "string" && typeof o.draftId === "string" && typeof o.state === "string",
	);
}

function choiceOf(x: unknown): ChatChoice | null {
	const c = x as Partial<ChatChoice> | null;
	if (!c || typeof c !== "object") return null;
	const keys = ["draftId", "projectId", "projectPath", "contextDigest", "mode", "model", "thinking"] as const;
	if (!keys.every((k) => typeof c[k] === "string")) return null;
	return Object.fromEntries(keys.map((k) => [k, c[k]])) as unknown as ChatChoice;
}

/** A creation's saved outcome, for the user. */
function outcomeResult(outcome: unknown): ChatResult {
	const o = outcome as { operationId?: unknown; state?: unknown; receipt?: { reason?: unknown } | null } | null;
	const id = typeof o?.operationId === "string" ? o.operationId : null;
	if (o?.state === "accepted") return chatResult("accepted", "", { operationId: id });
	if (o?.state === "rejected") {
		const reason = typeof o.receipt?.reason === "string" ? o.receipt.reason : "";
		return chatResult("rejected", reason ? `Pilot's service refused it: ${reason}` : "Pilot's service refused it.", {
			operationId: id,
		});
	}
	if (o?.state === "not-sent")
		return chatResult("rejected", "Pilot did not send it. Nothing was created.", { operationId: id });
	return chatResult("unknown", CHAT_UNKNOWN, { operationId: id });
}

/** New's chat source over this window's native root. */
export class ConnectedChats implements ChatSource {
	#window: string;
	#projects: ChatProject[] | null = null;
	#current: string | null = null;
	#refusal: Refusal | null = null;
	#ops: Summary[] = [];
	/** Read order: an older read's answer never replaces a newer one's. */
	#sent = 0;
	#applied = 0;
	#reading: Promise<void> | null = null;
	#again = false;
	/** Only the newest selection's answer counts. */
	#selection = 0;
	#creating = false;
	#checking = new Set<string>();
	/** Creations this window sent or checked, so their settled result can show. */
	#mine: string[] = [];
	#listeners = new Map<number, (view: ChatView) => void>();
	#next = 0;
	#closed = false;

	constructor(window: string) {
		this.#window = window;
	}

	view(): ChatView {
		const op = (o: Summary): ChatOp => ({
			operationId: o.operationId,
			draftId: o.draftId,
			projectId: typeof o.projectId === "string" ? o.projectId : "",
			delivery:
				o.state === "accepted" || o.state === "rejected"
					? o.state
					: this.#checking.has(o.operationId)
						? "checking"
						: "unknown",
			reason: o.receipt?.reason ?? "",
		});
		const sent = this.#ops.filter((o) => o.state !== "not-sent");
		const settledState = (o: Summary) => o.state === "accepted" || o.state === "rejected";
		const reason = this.#refusal
			? this.#projects
				? `${projectsReason(this.#refusal)} What shows is from Pilot's last read.`
				: projectsReason(this.#refusal)
			: "";
		return {
			availability: this.#projects ? "live" : this.#refusal ? "unavailable" : "reading",
			reason,
			projects: this.#projects ?? [],
			current: this.#current,
			unsettled: sent.filter((o) => !settledState(o)).map(op),
			settled: this.#mine
				.map((id) => sent.find((o) => o.operationId === id))
				.filter((o): o is Summary => !!o && settledState(o))
				.map(op),
			creating: this.#creating,
		};
	}

	onChange(listener: (view: ChatView) => void): () => void {
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

	#takeOps(value: Record<string, unknown>) {
		const ops = summariesOf(value.operations);
		if (ops) this.#ops = ops;
	}

	read(): Promise<void> {
		if (this.#reading) {
			this.#again = true;
			return this.#reading;
		}
		this.#reading = (async () => {
			do {
				this.#again = false;
				const order = ++this.#sent;
				const r = await call<unknown>(this.#window, "day.projects.read", {});
				if (order <= this.#applied) continue;
				this.#applied = order;
				if (r.ok) {
					const projects = projectsOf(r.snapshot);
					if (projects) {
						this.#projects = projects;
						this.#refusal = null;
						const current = r.value.current;
						this.#current = typeof current === "string" && current !== "" ? current : null;
					} else {
						this.#refusal = "invalid";
					}
					this.#takeOps(r.value);
				} else {
					this.#refusal = r.refusal;
				}
				this.#publish();
			} while (this.#again && !this.#closed);
		})().finally(() => {
			this.#reading = null;
		});
		return this.#reading;
	}

	async select(pick: ChatPick): Promise<ChatResult> {
		const order = ++this.#selection;
		const r = await call<unknown>(this.#window, "day.chat.select", {
			projectId: pick.projectId,
			contextDigest: pick.contextDigest,
			mode: pick.mode,
		});
		// A newer selection replaced this one, in Rust too: its answer means nothing now.
		if (order !== this.#selection) return chatResult("stale", "");
		if (!r.ok) {
			// What changed or waits shows in the next read; reading sends nothing.
			if (r.refusal === "stale" || r.refusal === "unknown") void this.read();
			return refusedSelect(r.refusal);
		}
		const choice = choiceOf(r.snapshot);
		if (!choice || choice.projectId !== pick.projectId || choice.mode !== pick.mode) {
			return chatResult(
				"rejected",
				"Pilot's service answered in a way this app does not understand. Nothing was sent.",
			);
		}
		return chatResult("accepted", "", { choice });
	}

	async create(choice: ChatChoice, message: string): Promise<ChatResult> {
		if (this.#creating) return chatResult("rejected", "A new chat is already on its way.");
		if (this.view().unsettled.length > 0)
			return chatResult("rejected", "An earlier new chat is not confirmed. Check it first; nothing was sent.");
		this.#creating = true;
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await call<unknown>(this.#window, "day.chat.create", { choice, message });
		} finally {
			this.#creating = false;
		}
		if (!r.ok) {
			// A lost answer may hide a saved creation: the read lists it as Unknown.
			void this.read();
			this.#publish();
			return refusedCreate(r.refusal);
		}
		this.#takeOps(r.value);
		const result = outcomeResult(r.value.outcome);
		if (result.operationId && !this.#mine.includes(result.operationId)) this.#mine.push(result.operationId);
		// An answer without the saved list (its receipt was not saved here) is read once more.
		if (!Array.isArray(r.value.operations)) void this.read();
		this.#publish();
		return result;
	}

	async check(operationId: string): Promise<ChatResult> {
		if (this.#checking.has(operationId)) return chatResult("rejected", "Pilot is already checking it.");
		this.#checking.add(operationId);
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await call<unknown>(this.#window, "day.chat.check", { operationId });
		} finally {
			this.#checking.delete(operationId);
		}
		if (!this.#mine.includes(operationId)) this.#mine.push(operationId);
		if (!r.ok) {
			this.#publish();
			return chatResult("unknown", "Pilot could not check it now. Nothing was sent; it stays not confirmed.", {
				operationId,
			});
		}
		this.#takeOps(r.value);
		if (!Array.isArray(r.value.operations)) void this.read();
		this.#publish();
		const result = outcomeResult(r.value.outcome);
		return result.status === "unknown"
			? chatResult("unknown", "Pilot's service has no result for it yet. Nothing was sent again.", { operationId })
			: result;
	}

	adopt(draftId: string): void {
		for (const o of this.#ops) {
			if (o.draftId === draftId && !this.#mine.includes(o.operationId)) this.#mine.push(o.operationId);
		}
		this.#publish();
	}

	dispose(): void {
		this.#closed = true;
		this.#listeners.clear();
	}
}

/** New's chat view, mirrored in one signal that only the source's listener sets. */
export type ChatMirror = {
	source: ChatSource;
	view: Signal<ChatView>;
	close: () => void;
};

/** Mirrors `source`'s view. */
export function mirrorChats(source: ChatSource): ChatMirror {
	const view = signal(source.view());
	const stop = source.onChange((next) => view.set(next));
	return {
		source,
		view,
		close: () => {
			stop();
			source.dispose();
		},
	};
}
