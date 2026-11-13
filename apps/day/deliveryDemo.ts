// A scripted source of delivered results with the connected rules, for the
// mock windows and headless tests. No daemon, worker, provider or storage:
// its results are invented to match the mock missions. Like the native root,
// it sends a command once for exactly the result and revision shown, keeps a
// lost answer Unknown until Check reads it, and refuses another meanwhile.
import { signal } from "nsh";
import type { Refusal } from "./bridge";
import { artifactSelection } from "./deliveryArtifact";
import type { AgentWork } from "./deliveryBridge";
import {
	type AgentWorkResult,
	type ArtifactLink,
	type Assessment,
	type CapturedArtifact,
	type DeliveredWork,
	type DeliveryOperation,
	type DeliveryResult,
	type DeliverySource,
	type DeliveryView,
	deliveryKey,
	type InspectResult,
	linkUrl,
	type OpenResult,
	type OutputLink,
	refusedAgentWork,
	refusedInspect,
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
	/** Hold every source read's answer until `releaseReads`. */
	holdReads: boolean;
	/** Refuse every source read like native would, such as "stale" after the artifact's chat left the mission. */
	refuseReads: Refusal | null;
};

/** Saved artifact sources the demo results link, by artifact. Plain text: nothing runs them. */
export const DEMO_SOURCES: Record<string, string> = {
	"3f0d6c2a-6b1e-4f7a-9d1c-2a5e8b7c4d10": [
		"<!doctype html>",
		'<script>document.title = "never run";</script>',
		"<p>Older messages load while a reply streams.</p>",
	].join("\n"),
	"9a4e1f7b-2c3d-4e5f-8a6b-7c8d9e0f1a2b": '({ ui }) => ui.text("50 older messages load in 140 ms")',
};

/** UTF-8 bytes of `text`. */
function bytesOf(text: string): number {
	let n = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
	}
	return n;
}

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
					artifactId: "3f0d6c2a-6b1e-4f7a-9d1c-2a5e8b7c4d10",
					sessionId: "w-history",
					title: "Scroll check page",
					kind: "html",
					revision: 3,
					linkedAt: 1,
				},
				{
					artifactId: "9a4e1f7b-2c3d-4e5f-8a6b-7c8d9e0f1a2b",
					sessionId: "w-history",
					title: "Load timing",
					kind: "visual",
					revision: 2,
					linkedAt: 1,
				},
				{
					artifactId: "5b2c8d1e-0f3a-4b6c-9d7e-1a2b3c4d5e6f",
					sessionId: "w-history",
					title: "History capture",
					kind: "image",
					revision: 1,
					linkedAt: 1,
				},
				{
					artifactId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
					sessionId: "w-history",
					title: "Notes draft",
					kind: "visual",
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

const hex = (c: string, n = 40) => c.repeat(n);

/**
 * The demo History slice's agent work: one owned change rebased once, a
 * confirmed push of main, a pull request whose command result never came
 * back, and an older record with no separate attempt.
 */
export function demoWork(work: DeliveredWork): AgentWork {
	const change = "k".repeat(32);
	const attempt = (id: string, kind: "push" | "pr_opened", at: number, branch: string | null) => ({
		id: `${id}:attempt`,
		kind,
		branch,
		prNumber: null,
		url: null,
		summary: kind === "push" ? "jj git push" : "gh pr create",
		description: kind === "push" ? `pushed ${branch}` : "opened a PR",
		at,
		exitCode: null,
		publication: {
			attemptId: `${id}:attempt`,
			stage: "attempted" as const,
			evidence: "command-dispatch" as const,
			local:
				kind === "push"
					? {
							status: "owned" as const,
							revisions: [
								{ changeId: change, commitId: hex("c"), startCommitId: hex("a"), baselineCommitId: hex("b") },
							],
						}
					: { status: "unknown" as const },
		},
	});
	const push = attempt("call-1/0:0", "push", Date.UTC(2026, 10, 13, 9, 30), "main");
	const pr = attempt("call-2/0:0", "pr_opened", Date.UTC(2026, 10, 13, 9, 40), null);
	return {
		version: 1,
		reference: {
			subject: work.subject,
			targetId: work.targetId,
			deliveryId: work.deliveryId ?? "",
			ownerSessionId: work.ownerSessionId ?? "",
		},
		changes: [
			{
				snapshotId: "snap-1",
				state: "shown",
				changeId: change,
				creationCommitId: hex("a"),
				baselineCommitId: hex("b"),
				current: "present",
				seed: "current",
				revisions: [
					{ changeId: change, commitId: hex("c"), parents: [hex("d")], ownedChange: true },
					{ changeId: change, commitId: hex("a"), parents: [hex("b")], ownedChange: true },
				],
				more: false,
				operationId: hex("f", 128),
			},
			{ snapshotId: "snap-0", state: "unavailable" },
		],
		moreChanges: false,
		publication: {
			state: "shown",
			scope: "mission",
			more: false,
			actions: [
				{
					id: "old-1:0",
					kind: "push",
					branch: "history",
					prNumber: null,
					url: null,
					summary: "git push",
					description: "pushed history",
					at: Date.UTC(2026, 10, 12, 18, 0),
					exitCode: 0,
					publication: null,
				},
				push,
				{
					...push,
					id: "call-1/0:0",
					exitCode: 0,
					at: push.at + 4000,
					publication: { ...push.publication, stage: "confirmed", evidence: "command-result" },
				},
				pr,
			],
		},
	};
}

export class ScriptedDelivery implements DeliverySource {
	script: DeliveryScript = { loseNext: false, hold: false, loseOpen: false, holdReads: false, refuseReads: null };
	/** Sends, Checks and the exact note last sent. */
	counts = signal({ sends: 0, checks: 0, note: "" });
	/** Every web address handed to the browser, in order. Opening is never a send. */
	opened = signal<string[]>([]);
	/** Whether this window can show web links, as a native root with a browser opener says. */
	webLinks = true;
	/** Every source read, in order, as "<artifact>@<revision>". Reading is never a send. */
	reads = signal<string[]>([]);
	/** Why a saved copy is not shown, by artifact, as the service would say. */
	unavailable: Record<string, "missing" | "oversize" | "redacted" | "unsupported" | "invalid"> = {};
	/** Results whose last read failed: the page keeps the earlier read and says so. */
	unreadable = new Set<string>();
	/** Agent work reads, in order, by result key. Reading is never a send. */
	workReads = signal<string[]>([]);
	/** The agent work each result shows, by key. Absent ones are refused as unavailable. */
	work = new Map<string, (w: DeliveredWork) => AgentWork>([["task/mock-project/native/native-4", demoWork]]);
	/** Refuse every Agent work read like native would. */
	refuseWork: Refusal | null = null;
	#heldReads: Array<() => void> = [];
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
							{
								key,
								subject: w.subject,
								snapshot: w,
								availability: "live" as const,
								reason: this.unreadable.has(key)
									? "Pilot could not reach its service. What shows is from Pilot's last read."
									: "",
							},
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

	/** Releases held source reads, the newest first, so older answers arrive late. */
	releaseReads() {
		this.script.holdReads = false;
		const held = this.#heldReads.reverse();
		this.#heldReads = [];
		for (const r of held) r();
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

	async inspect(shown: DeliveredWork, link: ArtifactLink): Promise<InspectResult> {
		const pin = artifactSelection(shown, link);
		if (!pin) return refusedInspect("unavailable");
		this.reads.set([...this.reads(), `${link.artifactId}@${link.revision}`]);
		if (this.script.holdReads)
			await new Promise<void>((r) => {
				this.#heldReads.push(r);
			});
		if (this.script.refuseReads) return refusedInspect(this.script.refuseReads);
		// Like native: the exact result and pin, checked again after the read.
		const now = this.works.get(deliveryKey(shown.subject));
		const current = now?.artifacts.find((a) => a.artifactId === link.artifactId && a.sessionId === link.sessionId);
		if (!now || now.deliveryId !== shown.deliveryId || current?.revision !== link.revision) {
			return refusedInspect("stale");
		}
		const source = DEMO_SOURCES[link.artifactId];
		const reason = this.unavailable[link.artifactId] ?? (link.kind === "image" ? "unsupported" : undefined);
		return {
			status: "shown",
			artifact: {
				version: 1,
				reference: pin,
				metadata: { title: link.title, kind: link.kind as CapturedArtifact["metadata"]["kind"] },
				rendering: "unsupported",
				content:
					reason || source === undefined
						? { state: "unavailable", reason: reason ?? "missing" }
						: { state: "text", source, containerSha256: "0".repeat(64), containerBytes: bytesOf(source) + 96 },
			},
		};
	}

	async agentWork(shown: DeliveredWork): Promise<AgentWorkResult> {
		const key = deliveryKey(shown.subject);
		this.workReads.set([...this.workReads(), key]);
		if (this.refuseWork) return refusedAgentWork(this.refuseWork);
		// Like native: the exact result, checked again after the read.
		const now = this.works.get(key);
		if (!now || now.deliveryId !== shown.deliveryId || now.ownerSessionId !== shown.ownerSessionId) {
			return refusedAgentWork("stale");
		}
		const make = this.work.get(key);
		return make ? { status: "shown", work: make(now) } : refusedAgentWork("unavailable");
	}

	dispose(): void {
		this.#listeners.clear();
	}
}
