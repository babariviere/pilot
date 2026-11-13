// A scripted chat source with the connected rules, for the mock windows and
// headless tests. No daemon, worker, provider or storage: its projects are
// invented and a "chat" is a counter. Like the native root, it keeps only the
// newest selection, saves a creation before sending it once, keeps a lost
// answer Unknown until Check reads it, and refuses another meanwhile.
import { signal } from "nsh";
import type { ChatChoice } from "pilot-day/native";
import {
	CHAT_UNKNOWN,
	type ChatOp,
	type ChatPick,
	type ChatProject,
	type ChatResult,
	type ChatSource,
	type ChatView,
	chatResult,
} from "./chatFeed";

/** Demo projects. The first is the window's own. */
export const DEMO_PROJECTS: ChatProject[] = [
	{ projectId: "demo-pilot", projectPath: "/Users/you/src/pilot", name: "pilot", contextDigest: "a".repeat(64) },
	{ projectId: "demo-website", projectPath: "/Users/you/src/website", name: "website", contextDigest: "b".repeat(64) },
];

type Saved = { op: ChatOp; choice: ChatChoice; message: string };

/** What a test can make the script do next. */
export type ChatScript = {
	/** Lose the next creation's answer: it still happens, and stays Unknown until Check. */
	loseNext: boolean;
	/** Hold every selection's answer until `releaseSelect`. */
	holdSelects: boolean;
	/** The service is unreachable: reads and sends are refused. */
	offline: boolean;
};

export class ScriptedChats implements ChatSource {
	projects: ChatProject[];
	current: string | null;
	script: ChatScript = { loseNext: false, holdSelects: false, offline: false };
	/** Calls that reached the script. */
	readonly counts = signal({ reads: 0, selects: 0, sends: 0, checks: 0, chats: 0 });
	/** What each sent chat started with, by draft. */
	readonly started = new Map<string, { projectId: string; mode: string; message: string }>();
	#unavailable: () => string;
	#read = false;
	#latest: ChatChoice | null = null;
	#selection = 0;
	#held: (() => void)[] = [];
	#saved: Saved[] = [];
	#mine: string[] = [];
	#creating = false;
	#listeners = new Set<(view: ChatView) => void>();
	#next = 0;

	/** `unavailable` says why chats cannot start here, or "" when they can. */
	constructor(
		projects: ChatProject[] = DEMO_PROJECTS,
		current: string | null = projects[0]?.projectId ?? null,
		unavailable: () => string = () => "",
	) {
		this.projects = projects.map((p) => ({ ...p }));
		this.current = current;
		this.#unavailable = unavailable;
	}

	#count(key: "reads" | "selects" | "sends" | "checks" | "chats") {
		this.counts.set({ ...this.counts(), [key]: this.counts()[key] + 1 });
	}

	view(): ChatView {
		const off = this.#unavailable();
		const live = this.#read && !off && !this.script.offline;
		const ops = this.#saved.map((s) => s.op);
		return {
			availability: live ? "live" : this.#read ? "unavailable" : "reading",
			reason: off || (this.script.offline ? "Pilot could not reach its service." : ""),
			projects: live ? this.projects.map((p) => ({ ...p })) : [],
			current: this.current,
			unsettled: ops.filter((o) => o.delivery === "unknown" || o.delivery === "checking"),
			settled: this.#mine
				.map((id) => ops.find((o) => o.operationId === id))
				.filter((o): o is ChatOp => !!o && (o.delivery === "accepted" || o.delivery === "rejected")),
			creating: this.#creating,
		};
	}

	onChange(listener: (view: ChatView) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	publish() {
		const view = this.view();
		for (const listener of this.#listeners) listener(view);
	}

	async read(): Promise<void> {
		this.#count("reads");
		this.#read = true;
		this.publish();
	}

	/** Answers the oldest held selection. */
	releaseSelect(newestFirst = false) {
		const release = newestFirst ? this.#held.pop() : this.#held.shift();
		release?.();
	}

	/** How many selections wait for `releaseSelect`. */
	heldSelects(): number {
		return this.#held.length;
	}

	#pending(): boolean {
		return this.#saved.some((s) => s.op.delivery === "unknown" || s.op.delivery === "checking");
	}

	async select(pick: ChatPick): Promise<ChatResult> {
		const order = ++this.#selection;
		this.#latest = null;
		this.#count("selects");
		if (this.script.holdSelects) await new Promise<void>((resolve) => this.#held.push(resolve));
		if (order !== this.#selection) return chatResult("stale", "");
		if (this.#unavailable() || this.script.offline)
			return chatResult("rejected", "Pilot could not reach its service. Nothing was sent.");
		if (this.#pending())
			return chatResult("unknown", "An earlier new chat is not confirmed. Check it before you start another.");
		const project = this.projects.find((p) => p.projectId === pick.projectId);
		if (!project || project.contextDigest !== pick.contextDigest) {
			return chatResult("stale", "This project changed while Pilot read it. Choose it again.");
		}
		const n = ++this.#next;
		const choice: ChatChoice = {
			draftId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
			projectId: project.projectId,
			projectPath: project.projectPath,
			contextDigest: project.contextDigest,
			mode: pick.mode,
			model: "Default model",
			thinking: "medium",
		};
		this.#latest = choice;
		return chatResult("accepted", "", { choice });
	}

	async create(choice: ChatChoice, message: string): Promise<ChatResult> {
		const same = (a: ChatChoice, b: ChatChoice) => JSON.stringify(a) === JSON.stringify(b);
		const prior = this.#saved.find((s) => s.choice.draftId === choice.draftId);
		if (prior) {
			if (!same(prior.choice, choice) || prior.message !== message)
				return chatResult(
					"stale",
					"This project or its setup changed since Pilot read it. Nothing was sent; your words stay.",
				);
			return this.#result(prior.op);
		}
		if (this.#creating) return chatResult("rejected", "A new chat is already on its way.");
		if (this.#pending())
			return chatResult("rejected", "An earlier new chat is not confirmed. Check it first; nothing was sent.");
		if (this.#unavailable() || this.script.offline)
			return chatResult("rejected", "Pilot could not reach its service. Nothing was sent; your words stay.");
		const project = this.projects.find((p) => p.projectId === choice.projectId);
		if (!this.#latest || !same(this.#latest, choice) || !project || project.contextDigest !== choice.contextDigest) {
			return chatResult(
				"stale",
				"This project or its setup changed since Pilot read it. Nothing was sent; your words stay.",
			);
		}
		this.#creating = true;
		this.publish();
		const lost = this.script.loseNext;
		this.script.loseNext = false;
		const op: ChatOp = {
			operationId: `chat-op-${this.#saved.length + 1}`,
			draftId: choice.draftId,
			projectId: choice.projectId,
			delivery: lost ? "unknown" : "accepted",
			reason: "",
		};
		this.#saved.push({ op, choice: { ...choice }, message });
		this.started.set(choice.draftId, { projectId: choice.projectId, mode: choice.mode, message });
		this.#count("sends");
		this.#count("chats");
		this.#creating = false;
		if (!lost) this.#mine.push(op.operationId);
		this.publish();
		return lost ? chatResult("unknown", CHAT_UNKNOWN, { operationId: op.operationId }) : this.#result(op);
	}

	#result(op: ChatOp): ChatResult {
		if (op.delivery === "accepted") return chatResult("accepted", "", { operationId: op.operationId });
		if (op.delivery === "rejected")
			return chatResult("rejected", "Pilot's service refused it.", { operationId: op.operationId });
		return chatResult("unknown", CHAT_UNKNOWN, { operationId: op.operationId });
	}

	async check(operationId: string): Promise<ChatResult> {
		const saved = this.#saved.find((s) => s.op.operationId === operationId);
		if (!saved) return chatResult("unknown", "Pilot has no such creation.", { operationId });
		this.#count("checks");
		// The chat was created before its answer was lost: the receipt says so.
		if (saved.op.delivery !== "rejected") saved.op.delivery = "accepted";
		if (!this.#mine.includes(operationId)) this.#mine.push(operationId);
		this.publish();
		return this.#result(saved.op);
	}

	adopt(draftId: string): void {
		for (const s of this.#saved) {
			if (s.op.draftId === draftId && !this.#mine.includes(s.op.operationId)) this.#mine.push(s.op.operationId);
		}
		this.publish();
	}

	dispose(): void {
		this.#listeners.clear();
	}
}
