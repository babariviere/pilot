// A scripted source of delivered results with the connected rules, for the
// mock windows and headless tests. No daemon, worker, provider or storage:
// its results are invented to match the mock missions. Like the native root,
// it sends a command once for exactly the result and revision shown, keeps a
// lost answer Unknown until Check reads it, and refuses another meanwhile.
import { signal } from "nsh";
import {
	type Assessment,
	type DeliveredWork,
	type DeliveryOperation,
	type DeliveryResult,
	type DeliverySource,
	type DeliveryView,
	deliveryKey,
	linkUrl,
	type OpenResult,
	type OutputLink,
	refusedOpen,
	UNKNOWN,
	type VerificationSubject,
	webLink,
} from "./deliveryFeed";
import { deliveryTitles } from "./deliveryView";

/** The mock world's project. */
const PROJECT = "mock-project";

/** What a test can make the script do next. */
export type DeliveryScript = {
	/** Lose the next command's answer: it still happens, and stays Unknown until Check. */
	loseNext: boolean;
	/** Hold every command's answer until `release`. */
	hold: boolean;
	/** Lose the next open's answer: the browser may or may not have shown it. */
	loseOpen: boolean;
};

function result(subject: VerificationSubject, id: string, rest: Partial<DeliveredWork>): DeliveredWork {
	return {
		version: 1,
		subject,
		deliveryId: id.repeat(64),
		targetId: `target-${id}`,
		ownerSessionId: subject.kind === "chat" ? subject.sessionId : `w-${id}`,
		pullRequests: [],
		artifacts: [],
		production: "not_tracked",
		verification: null,
		verificationCurrent: false,
		verificationReceiptState: "unknown",
		verificationRevision: 0,
		pendingOperationId: null,
		...rest,
	};
}

function pr(n: number, title: string, state: "open" | "merged"): DeliveredWork["pullRequests"][number] {
	const url = `https://github.com/mock/pilot/pull/${n}`;
	return {
		id: `pr-${n}`,
		url,
		kind: "github.pr",
		relationship: "ownership",
		pullRequest: { number: n, url, title, state, checkedAt: 1, ...(state === "merged" ? { mergedAt: 1 } : {}) },
	};
}

/** The demo results: one with an open PR, one merged, one standalone chat. */
export function demoResults(): DeliveredWork[] {
	return [
		result({ kind: "task", projectId: PROJECT, missionId: "native", taskId: "native-4" }, "1", {
			completion: {
				commit: "4a1c9e0b".padEnd(40, "0"),
				checks: "History loads 50 older messages while a reply streams. Scroll position holds.",
				issues: "Images in old messages load after the text.",
			},
			pullRequests: [pr(431, "Load older messages while streaming", "open")],
			artifacts: [
				{
					artifactId: "history-capture",
					sessionId: "w-history",
					title: "History capture",
					kind: "image",
					revision: 1,
					linkedAt: 1,
				},
			],
		}),
		result({ kind: "task", projectId: PROJECT, missionId: "native", taskId: "native-2" }, "2", {
			completion: {
				commit: "9b7f21c4".padEnd(40, "0"),
				checks: "Chat view renders 10,000 messages; typing stays smooth.",
				issues: "",
			},
			pullRequests: [pr(412, "Native chat view", "merged")],
		}),
		result({ kind: "chat", projectId: PROJECT, sessionId: "explain-exports" }, "3", {
			outcome: { outcomeAt: 1, reason: "The guide now explains CSV exports, with one example." },
		}),
	];
}

/** Titles for the demo results, as the pages that name them would. */
export const DEMO_TITLES: Record<string, string> = {
	"task/mock-project/native/native-4": "#4 History slice",
	"task/mock-project/native/native-2": "#2 Chat view",
	"chat/mock-project/explain-exports": "Explain CSV exports in the guide",
};

export class ScriptedDelivery implements DeliverySource {
	script: DeliveryScript = { loseNext: false, hold: false, loseOpen: false };
	/** Sends, Checks and the exact note last sent. */
	counts = signal({ sends: 0, checks: 0, note: "" });
	/** Every web address handed to the browser, in order. Opening is never a send. */
	opened = signal<string[]>([]);
	/** Whether this window can show web links, as a native root with a browser opener says. */
	webLinks = true;
	works = new Map<string, DeliveredWork>();
	#ops: DeliveryOperation[] = [];
	#mine: string[] = [];
	#sending = new Set<string>();
	#listeners = new Set<(v: DeliveryView) => void>();
	#read = false;
	#next = 0;
	#release: (() => void) | null = null;

	constructor(results: DeliveredWork[] = demoResults()) {
		for (const w of results) this.works.set(deliveryKey(w.subject), w);
		deliveryTitles.update((all) => ({ ...DEMO_TITLES, ...all }));
	}

	view(): DeliveryView {
		const op = (o: DeliveryOperation) => ({ ...o, key: deliveryKey(o.subject), checking: false });
		return {
			entries: this.#read
				? Object.fromEntries(
						[...this.works].map(([key, w]) => [
							key,
							{ key, subject: w.subject, snapshot: w, availability: "live" as const, reason: "" },
						]),
					)
				: {},
			candidates: this.#read ? [...this.works.keys()] : [],
			unsettled: this.#ops.filter((o) => o.state === "unknown").map(op),
			settled: this.#mine
				.map((id) => this.#ops.find((o) => o.operationId === id))
				.filter((o): o is DeliveryOperation => !!o && o.state !== "unknown")
				.map(op),
			sending: [...this.#sending],
			saved: this.#read ? "live" : "reading",
			projectId: PROJECT,
			webLinks: this.webLinks,
			opening: [],
		};
	}

	onChange(listener: (v: DeliveryView) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	publish() {
		const v = this.view();
		for (const l of this.#listeners) l(v);
	}

	/** Releases a held answer. */
	release() {
		this.script.hold = false;
		this.#release?.();
		this.#release = null;
	}

	/** The agent delivers again: a new result for `key`, not checked yet. */
	deliverAgain(key: string, id: string) {
		const w = this.works.get(key);
		if (!w) return;
		this.works.set(key, { ...w, deliveryId: id.repeat(64), verificationCurrent: false });
		this.publish();
	}

	/** The agent's pull request moves to another address under the same result. */
	moveLink(key: string, url: string) {
		const w = this.works.get(key);
		if (!w) return;
		const [first, ...rest] = w.pullRequests;
		if (!first?.pullRequest) return;
		this.works.set(key, { ...w, pullRequests: [{ ...first, pullRequest: { ...first.pullRequest, url } }, ...rest] });
	}

	async read(subject: VerificationSubject): Promise<void> {
		const key = deliveryKey(subject);
		// A result the demo does not have: nothing delivered yet.
		if (!this.works.has(key)) this.works.set(key, result(subject, "0", { deliveryId: null }));
		this.publish();
	}

	async readSaved(): Promise<void> {
		this.#read = true;
		this.publish();
	}

	#settle(key: string, o: DeliveryOperation) {
		const w = this.works.get(key) as DeliveredWork;
		const state = o.action === "done" ? "done" : o.action === "send_back" ? "sent_back" : "open";
		this.works.set(key, {
			...w,
			verification: {
				version: 1,
				subject: w.subject,
				deliveryId: o.deliveryId,
				revision: o.expectedRevision + 1,
				operationId: o.operationId,
				state,
				note: o.note,
				createdAt: 1,
			},
			verificationCurrent: o.deliveryId === w.deliveryId,
			verificationReceiptState: "accepted",
			verificationRevision: o.expectedRevision + 1,
			pendingOperationId: null,
		});
	}

	async assess(shown: DeliveredWork, action: Assessment, note: string): Promise<DeliveryResult> {
		const key = deliveryKey(shown.subject);
		const now = this.works.get(key);
		if (this.#sending.has(key) || this.#ops.some((o) => o.state === "unknown" && deliveryKey(o.subject) === key)) {
			return { status: "unknown", message: "An earlier check of this result is not confirmed.", operationId: null };
		}
		if (!now || now.deliveryId !== shown.deliveryId || now.verificationRevision !== shown.verificationRevision) {
			return {
				status: "stale",
				message: "This result changed since you opened it. Nothing was sent. Look at it again.",
				operationId: null,
			};
		}
		this.#sending.add(key);
		this.publish();
		if (this.script.hold)
			await new Promise<void>((r) => {
				this.#release = r;
			});
		this.#sending.delete(key);
		const lost = this.script.loseNext;
		this.script.loseNext = false;
		const c = this.counts();
		this.counts.set({ ...c, sends: c.sends + 1, note });
		const o: DeliveryOperation = {
			operationId: `op-${++this.#next}`,
			subject: shown.subject,
			targetId: shown.targetId,
			deliveryId: shown.deliveryId as string,
			expectedRevision: shown.verificationRevision,
			ownerSessionId: shown.ownerSessionId,
			action,
			note,
			state: lost ? "unknown" : "accepted",
			lookup: null,
		};
		this.#ops.push(o);
		this.#mine.push(o.operationId);
		// The service saved it either way; only a lost answer hides that.
		this.#settle(key, o);
		if (lost) {
			const w = this.works.get(key) as DeliveredWork;
			this.works.set(key, { ...w, verificationCurrent: false, pendingOperationId: o.operationId });
		}
		this.publish();
		return lost
			? { status: "unknown", message: UNKNOWN, operationId: o.operationId }
			: { status: "accepted", message: "", operationId: o.operationId };
	}

	async check(operationId: string): Promise<DeliveryResult> {
		const o = this.#ops.find((x) => x.operationId === operationId);
		if (!o) return { status: "unknown", message: "Pilot has no such command.", operationId };
		const c = this.counts();
		this.counts.set({ ...c, checks: c.checks + 1 });
		o.state = "accepted";
		this.#settle(deliveryKey(o.subject), o);
		this.publish();
		return { status: "accepted", message: "", operationId };
	}

	async open(shown: DeliveredWork, link: OutputLink): Promise<OpenResult> {
		if (!this.webLinks) return refusedOpen("unavailable");
		if (!webLink(link)) return refusedOpen("invalid");
		// Like native: the exact result, owner and address, read again before anything opens.
		const now = this.works.get(deliveryKey(shown.subject));
		const current = now?.pullRequests.find((r) => r.id === link.id);
		if (!now || now.deliveryId !== shown.deliveryId || !current || linkUrl(current) !== linkUrl(link)) {
			this.publish();
			return refusedOpen("stale");
		}
		this.opened.set([...this.opened(), linkUrl(link)]);
		if (this.script.loseOpen) {
			this.script.loseOpen = false;
			return refusedOpen("lost");
		}
		return { status: "opened", message: "" };
	}

	dispose(): void {
		this.#listeners.clear();
	}
}
