// Delivered results the user checks: passive reads of the exact canonical
// result, and the user's explicit Done, Send back and Reopen. Rust saves each
// command and sends it once (docs/technical/day-user-verification.md). A
// command whose answer is lost stays Unknown, also after a reopen: Check
// reads that one saved command's receipt and never sends again. A read never
// counts as the user's check, and a read that already says Done never
// settles a command: only the command's own matching receipts do.
import { type Signal, signal } from "nsh";
import type { Refusal } from "./bridge";
import { type ArtifactLink, artifactSelection, type CapturedArtifact, readDeliveryArtifact } from "./deliveryArtifact";
import {
	assessDelivery,
	checkDelivery,
	type DeliveredWork,
	type DeliveryOperation,
	type DeliveryReply,
	listDeliveries,
	openDeliveryOutput,
	readDelivery,
	readSavedDeliveries,
	type VerificationSubject,
} from "./deliveryBridge";
import { glide } from "./motion";

export type { ArtifactLink, CapturedArtifact, DeliveredWork, DeliveryOperation, VerificationSubject };

/** What the user says about a delivered result. */
export type Assessment = "done" | "send_back" | "reopen";

/** The most results Today reads to find what waits for the user's check. */
export const MAX_CANDIDATES = 20;

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The exact key of a result: "task/<project>/<mission>/<task>" or "chat/<project>/<session>". */
export function deliveryKey(s: VerificationSubject): string {
	return s.kind === "task" ? `task/${s.projectId}/${s.missionId}/${s.taskId}` : `chat/${s.projectId}/${s.sessionId}`;
}

/** The result a key names, or null when the key is not exact. */
export function subjectOf(key: string): VerificationSubject | null {
	const parts = key.split("/");
	if (!parts.slice(1).every((p) => ID.test(p))) return null;
	if (parts[0] === "task" && parts.length === 4) {
		return { kind: "task", projectId: parts[1], missionId: parts[2], taskId: parts[3] };
	}
	if (parts[0] === "chat" && parts.length === 3) return { kind: "chat", projectId: parts[1], sessionId: parts[2] };
	return null;
}

/** One result as Pilot last read it. */
export type DeliveryEntry = {
	key: string;
	subject: VerificationSubject;
	/** The canonical result. Kept when a later read fails; then `reason` says so. */
	snapshot: DeliveredWork | null;
	availability: "reading" | "live" | "unavailable";
	/** Why the result is not shown, or why what is shown is from an earlier read. */
	reason: string;
	/** Canonical task title supplied by discovery, not inferred from task status. */
	title?: string;
};

/** A saved command, by its result's key. `checking` while Check reads it. */
export type DeliveryOp = DeliveryOperation & { key: string; checking: boolean };

/** What the screens show. */
export type DeliveryView = {
	entries: Record<string, DeliveryEntry>;
	/** The results Today looked at, those most likely to wait for the user first. */
	candidates: string[];
	/** Commands whose result is not known. Only Check settles them. */
	unsettled: DeliveryOp[];
	/** Commands settled while this window was open, oldest first. */
	settled: DeliveryOp[];
	/** Results with a command on its way. */
	sending: string[];
	/** Whether Pilot could read the saved commands. */
	saved: "reading" | "live" | "unavailable";
	/** The project this window's results belong to, as the native root chose it. "" before a read. */
	projectId: string;
	/** Whether this window can show a result's web links in the browser, as the native root last said. */
	webLinks: boolean;
	/** Links on their way to the browser, as "<result key>#<resource id>". */
	opening: string[];
	/** Automatic discovery is separate from saved checks and their Unknown receipts. */
	discovery?: { complete: boolean; more: boolean; reason: string; later?: boolean };
};

/** What a command or a Check did, for the user. */
export type DeliveryResult = {
	status: "accepted" | "stale" | "rejected" | "unknown";
	message: string;
	operationId: string | null;
};

/** What one press on an output link did. Opening never counts as the user's check. */
export type OpenResult = { status: "opened" | "refused" | "unknown"; message: string };

/**
 * What one press on Inspect source read: the saved source as inert text, or
 * why nothing is shown. Reading never counts as the user's check.
 */
export type InspectResult = { status: "shown"; artifact: CapturedArtifact } | { status: "refused"; message: string };

/** A pull request linked to a result, as the page shows it. */
export type OutputLink = DeliveredWork["pullRequests"][number];

/** The results' source. The connected window has one; the mock window has none. */
export interface DeliverySource {
	view(): DeliveryView;
	onChange(listener: (view: DeliveryView) => void): () => void;
	/** Reads one result. Passive: it sends, starts and settles nothing. */
	read(subject: VerificationSubject): Promise<void>;
	/**
	 * Reads the saved commands, then the results they name and the requests
	 * started as standalone chats, at most `MAX_CANDIDATES`. Passive.
	 */
	readSaved(): Promise<void>;
	/** Reads the next bounded page. It never advances the durable cutoff. */
	readMore?(): Promise<void>;
	/** Sends the user's assessment of exactly the result shown, once. */
	assess(shown: DeliveredWork, action: Assessment, note: string): Promise<DeliveryResult>;
	/** Reads one unsettled command's saved receipt. Never sends the command again. */
	check(operationId: string): Promise<DeliveryResult>;
	/**
	 * Shows one web link of exactly the result shown in the browser, once, for
	 * one press. Native reads the result again first; a changed link opens
	 * nothing. Nothing is saved, sent or retried, and it is never a check.
	 */
	open(shown: DeliveredWork, link: OutputLink): Promise<OpenResult>;
	/**
	 * Reads the saved source of one exactly pinned artifact revision of the
	 * result shown, once, for one press. Native checks the result, the pin and
	 * the artifact's place in the mission again. Nothing is run, drawn, opened,
	 * saved or retried, there is no latest revision, and it is never a check.
	 */
	inspect(shown: DeliveredWork, link: ArtifactLink): Promise<InspectResult>;
	dispose(): void;
}

/** Unknown words for a lost answer: the same promise everywhere. */
export const UNKNOWN = "Pilot sent this but heard nothing back. It will not send it again; Check only reads.";

/** Why a result could not be read, in one calm sentence. */
export function deliveryReason(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service.";
		case "identity":
			return "The Pilot service changed. Open Pilot again to see it.";
		case "closed":
		case "busy":
			return "Pilot is closing.";
		case "denied":
		case "unavailable":
			return "This Pilot service cannot show delivered results here.";
		case "invalid":
			return "Pilot's service answered in a way this app does not understand.";
		default:
			return "Pilot could not read this result.";
	}
}

/** What a refused command means. Only a lost answer may hide a sent command. */
export function refusedResult(refusal: Refusal): DeliveryResult {
	const r = (status: DeliveryResult["status"], message: string): DeliveryResult => ({
		status,
		message,
		operationId: null,
	});
	switch (refusal) {
		case "lost":
			return r("unknown", UNKNOWN);
		case "unknown":
			return r("unknown", "An earlier check of this result is not confirmed. Check it first; nothing was sent.");
		case "stale":
			return r("stale", "This result changed since you opened it. Nothing was sent. Look at it again.");
		case "busy":
			return r("rejected", "Pilot is saving this window before it closes. Nothing was sent.");
		case "closed":
			return r("rejected", "Pilot is closing. Nothing was sent.");
		case "offline":
			return r("rejected", "Pilot could not reach its service. Nothing was sent.");
		case "identity":
			return r("rejected", "The Pilot service changed. Open Pilot again. Nothing was sent.");
		case "denied":
		case "unavailable":
			return r("rejected", "This is not available here. Nothing was sent.");
		case "capacity":
			return r("rejected", "Pilot cannot save another command here. Nothing was sent.");
		case "storage":
			return r("rejected", "Pilot could not save it, so nothing was sent.");
		default:
			return r("rejected", "Pilot could not send this. Nothing was sent.");
	}
}

/** What a refused open means. Only an attempt whose answer is lost may have opened. */
export function refusedOpen(refusal: Refusal): OpenResult {
	const r = (message: string): OpenResult => ({ status: "refused", message });
	switch (refusal) {
		case "lost":
		case "unknown":
			return {
				status: "unknown",
				message: "Pilot asked your browser to open it but did not hear back. It will not try again by itself.",
			};
		case "stale":
			return r("This link changed since Pilot read the result. Nothing opened. Look at it again.");
		case "busy":
		case "closed":
			return r("Pilot is closing. Nothing opened.");
		case "offline":
			return r("Pilot could not reach its service to check this link. Nothing opened.");
		case "identity":
			return r("The Pilot service changed. Open Pilot again. Nothing opened.");
		case "invalid":
			return r("Pilot only opens web links. Nothing opened.");
		case "denied":
		case "unavailable":
			return r("Pilot cannot open links in this window. Nothing opened.");
		default:
			return r("Pilot could not open this link. Nothing opened.");
	}
}

/** What a refused source read means. A read changes nothing, so no answer is Unknown. */
export function refusedInspect(refusal: Refusal): InspectResult {
	const r = (message: string): InspectResult => ({ status: "refused", message });
	switch (refusal) {
		case "stale":
			return r(
				"This result or its artifact changed since Pilot read it, or the artifact is no longer part of this mission. Nothing is shown.",
			);
		case "busy":
		case "closed":
			return r("Pilot is closing. Nothing is shown.");
		case "offline":
			return r("Pilot could not reach its service. Nothing is shown.");
		case "identity":
			return r("The Pilot service changed. Open Pilot again. Nothing is shown.");
		case "invalid":
			return r("Pilot's service answered in a way this app does not understand. Nothing is shown.");
		case "lost":
		case "unknown":
			return r("Pilot did not hear back. Nothing is shown, and nothing changed.");
		case "denied":
		case "unavailable":
			return r("Pilot cannot show saved sources in this window.");
		default:
			return r("Pilot could not read this source. Nothing is shown.");
	}
}

/** The web address a link opens: the pull request's own, else the linked one. */
export function linkUrl(link: OutputLink): string {
	return link.pullRequest?.url || link.url;
}

/** Whether a link is a plain web address Pilot may ask the browser to open. Native checks it again. */
export function webLink(link: OutputLink): boolean {
	return link.kind === "github.pr" && /^https?:\/\/[^\s/\\@]+(\/[^\s\\]*)?$/i.test(linkUrl(link));
}

function isSubject(x: unknown): x is VerificationSubject {
	const s = x as Record<string, unknown> | null;
	if (!s || typeof s !== "object" || typeof s.projectId !== "string") return false;
	return s.kind === "task"
		? typeof s.missionId === "string" && typeof s.taskId === "string"
		: s.kind === "chat" && typeof s.sessionId === "string";
}

function snapshotOf(x: unknown): DeliveredWork | null {
	const s = x as DeliveredWork | null;
	if (!s || typeof s !== "object" || s.version !== 1 || !isSubject(s.subject)) return null;
	if (typeof s.targetId !== "string" || s.production !== "not_tracked") return null;
	if (!Array.isArray(s.pullRequests) || !Array.isArray(s.artifacts)) return null;
	return s;
}

const ACTIONS = new Set(["done", "send_back", "reopen"]);

function opsOf(x: unknown): DeliveryOperation[] | null {
	if (!Array.isArray(x)) return null;
	return x.filter(
		(o): o is DeliveryOperation =>
			!!o &&
			typeof o.operationId === "string" &&
			isSubject(o.subject) &&
			ACTIONS.has(o.action) &&
			typeof o.note === "string" &&
			typeof o.state === "string",
	);
}

/** What a command's settled outcome means for the user. */
function outcomeResult(op: DeliveryOperation | null): DeliveryResult {
	const id = op?.operationId ?? null;
	if (op?.state === "accepted") return { status: "accepted", message: "", operationId: id };
	if (op?.state === "rejected") {
		const reason = (op.lookup?.receipt as { reason?: unknown } | undefined)?.reason;
		return {
			status: "rejected",
			message:
				typeof reason === "string" && reason
					? `Pilot's service refused it: ${reason}`
					: "Pilot's service refused it.",
			operationId: id,
		};
	}
	if (op?.state === "not-sent") {
		return { status: "rejected", message: "Pilot saved it but did not send it. Nothing changed.", operationId: id };
	}
	if (op?.receiptSaved === false) {
		return {
			status: "unknown",
			message: "Pilot heard back but could not save the answer. Check reads it again; nothing is sent again.",
			operationId: id,
		};
	}
	return { status: "unknown", message: UNKNOWN, operationId: id };
}

/** The results over this window's native root. */
export class ConnectedDelivery implements DeliverySource {
	#window: string;
	/** Standalone chats started from requests: results Today also looks at. */
	#started: () => VerificationSubject[];
	#entries = new Map<string, DeliveryEntry>();
	/** Call order: an answer to an older call never replaces a newer one's read. */
	#sent = 0;
	#applied = new Map<string, number>();
	#opsApplied = 0;
	#ops: DeliveryOperation[] = [];
	#saved: DeliveryView["saved"] = "reading";
	#project = "";
	#webLinks = false;
	#opening = new Set<string>();
	#candidates: string[] = [];
	#mine: string[] = [];
	#sending = new Set<string>();
	#checking = new Set<string>();
	#reading: Promise<void> | null = null;
	#again = false;
	#listeners = new Map<number, (view: DeliveryView) => void>();
	#next = 0;
	#closed = false;
	#discovered: VerificationSubject[] = [];
	#nextCursor: number | null = null;
	#discovery: NonNullable<DeliveryView["discovery"]> = {
		complete: false,
		more: false,
		reason: "Reading new deliveries…",
	};

	constructor(window: string, started: () => VerificationSubject[] = () => []) {
		this.#window = window;
		this.#started = started;
	}

	view(): DeliveryView {
		const op = (o: DeliveryOperation): DeliveryOp => ({
			...o,
			key: deliveryKey(o.subject),
			checking: this.#checking.has(o.operationId),
		});
		const settled = this.#mine
			.map((id) => this.#ops.find((o) => o.operationId === id))
			.filter((o): o is DeliveryOperation => !!o && o.state !== "unknown")
			.map(op);
		return {
			entries: Object.fromEntries(this.#entries),
			candidates: [...this.#candidates],
			unsettled: this.#ops.filter((o) => o.state === "unknown").map(op),
			settled,
			sending: [...this.#sending],
			saved: this.#saved,
			projectId: this.#project,
			webLinks: this.#webLinks,
			opening: [...this.#opening],
			discovery: this.#discovery,
		};
	}

	onChange(listener: (view: DeliveryView) => void): () => void {
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

	/** Applies an answer unless a newer call's answer was applied first. */
	#apply(order: number, reply: DeliveryReply, read?: VerificationSubject) {
		if (reply.ok) {
			// Only a read or the saved commands say what this window can open.
			if (reply.outputCapabilities) this.#webLinks = reply.outputCapabilities.web === true;
			if (order > this.#opsApplied) {
				this.#ops = opsOf(reply.operations) ?? this.#ops;
				this.#opsApplied = order;
			}
			const snapshot = snapshotOf(reply.snapshot);
			if (snapshot) {
				const key = deliveryKey(snapshot.subject);
				if (order > (this.#applied.get(key) ?? 0)) {
					this.#entries.set(key, {
						key,
						subject: snapshot.subject,
						snapshot,
						availability: "live",
						reason: "",
						title: this.#entries.get(key)?.title,
					});
					this.#applied.set(key, order);
				}
				return;
			}
		}
		if (!read) return;
		const key = deliveryKey(read);
		if (order <= (this.#applied.get(key) ?? 0)) return;
		this.#applied.set(key, order);
		const before = this.#entries.get(key);
		const why = reply.ok ? deliveryReason("invalid") : deliveryReason(reply.refusal);
		this.#entries.set(key, {
			key,
			subject: read,
			snapshot: before?.snapshot ?? null,
			availability: before?.snapshot ? "live" : "unavailable",
			reason: before?.snapshot ? `${why} What shows is from Pilot's last read.` : why,
		});
	}

	async read(subject: VerificationSubject): Promise<void> {
		const key = deliveryKey(subject);
		if (!this.#entries.has(key)) {
			this.#entries.set(key, { key, subject, snapshot: null, availability: "reading", reason: "" });
			this.#publish();
		}
		const order = ++this.#sent;
		const reply = await readDelivery(this.#window, subject);
		this.#apply(order, reply, subject);
		this.#publish();
	}

	/** Results with an unsettled command first, then those sent back or reopened, then started requests, then the rest. */
	#rank(): VerificationSubject[] {
		const latest = new Map<string, DeliveryOperation>();
		for (const o of this.#ops) {
			const key = deliveryKey(o.subject);
			const was = latest.get(key);
			if (!was || o.state === "unknown" || (was.state !== "unknown" && o.expectedRevision >= was.expectedRevision)) {
				latest.set(key, o);
			}
		}
		const all = [...latest.values()];
		const rank = (o: DeliveryOperation) => (o.state === "unknown" ? 0 : o.action === "done" ? 3 : 1);
		const keyed = all.map((o) => ({ subject: o.subject, rank: rank(o) }));
		for (const subject of this.#started()) keyed.push({ subject, rank: 2 });
		keyed.sort((a, b) => a.rank - b.rank);
		const seen = new Set<string>();
		const out: VerificationSubject[] = [];
		for (const { subject } of keyed) {
			const key = deliveryKey(subject);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(subject);
			if (out.length === MAX_CANDIDATES) break;
		}
		return out;
	}

	async #discover(after?: number) {
		const order = ++this.#sent;
		const reply = await listDeliveries(this.#window, after);
		if (this.#closed) return;
		if (!reply.ok) {
			this.#discovery = {
				complete: false,
				more: false,
				reason: `${deliveryReason(reply.refusal)} Earlier checks are kept.`,
			};
			return;
		}
		const list = reply.snapshot;
		if (
			list?.version !== 1 ||
			!Array.isArray(list.items) ||
			list.items.length > MAX_CANDIDATES ||
			(this.#project && list.projectId !== this.#project)
		) {
			this.#discovery = { complete: false, more: false, reason: deliveryReason("invalid") };
			return;
		}
		this.#project = list.projectId;
		this.#discovered = list.items.map((i) => i.subject);
		this.#nextCursor = list.nextCursor;
		this.#discovery = {
			complete: list.complete && after === undefined,
			more: list.more,
			later: after !== undefined,
			reason:
				list.currentness === "stale"
					? "Deliveries changed during this read. Look again for the latest results."
					: after === undefined
						? ""
						: "Showing later results. Earlier results are still pending, not accepted.",
		};
		for (const item of list.items) {
			const key = deliveryKey(item.subject);
			if (snapshotOf(item.snapshot) && order > (this.#applied.get(key) ?? 0)) {
				this.#entries.set(key, {
					key,
					subject: item.subject,
					snapshot: item.snapshot,
					availability: "live",
					reason: this.#discovery.reason,
					title: item.title,
				});
				this.#applied.set(key, order);
			}
		}
	}

	#candidatesNow() {
		// The saved 20 keep priority; a bounded discovery page adds at most 20.
		this.#candidates = [...new Set([...this.#rank(), ...this.#discovered].map(deliveryKey))];
	}

	async readMore(): Promise<void> {
		if (this.#reading || this.#nextCursor === null) return;
		this.#reading = (async () => {
			await this.#discover(this.#nextCursor!);
			this.#candidatesNow();
			this.#publish();
		})().finally(() => {
			this.#reading = null;
			if (this.#again && !this.#closed) void this.readSaved();
		});
		return this.#reading;
	}

	readSaved(): Promise<void> {
		if (this.#reading) {
			this.#again = true;
			return this.#reading;
		}
		this.#reading = (async () => {
			do {
				this.#again = false;
				const order = ++this.#sent;
				const reply = await readSavedDeliveries(this.#window);
				this.#apply(order, reply);
				if (order >= this.#opsApplied) this.#saved = reply.ok ? "live" : "unavailable";
				const project = reply.ok ? (reply.snapshot as { projectId?: unknown } | null)?.projectId : null;
				if (typeof project === "string") this.#project = project;
				await this.#discover();
				const subjects = this.#rank();
				this.#candidatesNow();
				this.#publish();
				for (const subject of subjects) {
					if (this.#closed) return;
					await this.read(subject);
				}
			} while (this.#again && !this.#closed);
		})().finally(() => {
			this.#reading = null;
		});
		return this.#reading;
	}

	/** Puts `key` first among the results Today looks at. */
	#notice(key: string) {
		this.#candidates = [key, ...this.#candidates.filter((k) => k !== key)].slice(0, MAX_CANDIDATES * 2);
	}

	async assess(shown: DeliveredWork, action: Assessment, note: string): Promise<DeliveryResult> {
		const key = deliveryKey(shown.subject);
		if (this.#sending.has(key)) return refusedResult("busy");
		if (this.#ops.some((o) => o.state === "unknown" && deliveryKey(o.subject) === key)) {
			return refusedResult("unknown");
		}
		this.#sending.add(key);
		this.#publish();
		const order = ++this.#sent;
		let reply: DeliveryReply;
		try {
			reply = await assessDelivery(this.#window, shown, action, action === "send_back" ? note : "");
		} finally {
			this.#sending.delete(key);
		}
		this.#apply(order, reply);
		this.#notice(key);
		if (!reply.ok) {
			// A lost answer may hide a saved command: reading the saved commands lists it as Unknown.
			if (reply.refusal === "lost" || reply.refusal === "unknown") void this.readSaved();
			if (reply.refusal === "stale") void this.read(shown.subject);
			this.#publish();
			return refusedResult(reply.refusal);
		}
		const op = reply.outcome;
		if (op) this.#mine.push(op.operationId);
		if (!snapshotOf(reply.snapshot)) void this.read(shown.subject);
		glide();
		this.#publish();
		return outcomeResult(op);
	}

	async check(operationId: string): Promise<DeliveryResult> {
		if (this.#checking.has(operationId)) return refusedResult("busy");
		const was = this.#ops.find((o) => o.operationId === operationId);
		this.#checking.add(operationId);
		this.#publish();
		const order = ++this.#sent;
		let reply: DeliveryReply;
		try {
			reply = await checkDelivery(this.#window, operationId);
		} finally {
			this.#checking.delete(operationId);
		}
		this.#apply(order, reply);
		if (!this.#mine.includes(operationId)) this.#mine.push(operationId);
		this.#publish();
		// The result itself, read again. Passive: the receipt alone decides the command.
		if (was) void this.read(was.subject);
		if (!reply.ok) {
			return {
				status: "unknown",
				message: "Pilot could not check it now. Nothing was sent; it stays not confirmed.",
				operationId,
			};
		}
		const result = outcomeResult(reply.outcome);
		if (result.status === "unknown" && reply.outcome?.receiptSaved !== false) {
			return {
				status: "unknown",
				message: "Pilot's service has no result for it yet. Nothing was sent again.",
				operationId,
			};
		}
		return result;
	}

	async open(shown: DeliveredWork, link: OutputLink): Promise<OpenResult> {
		const key = `${deliveryKey(shown.subject)}#${link.id}`;
		// One press, one attempt: a press while one is on its way does nothing.
		if (this.#opening.has(key)) return { status: "refused", message: "" };
		const own = shown.pullRequests.find((r) => r.id === link.id);
		if (!own || linkUrl(own) !== linkUrl(link) || !webLink(own)) return refusedOpen("invalid");
		this.#opening.add(key);
		this.#publish();
		try {
			const r = await openDeliveryOutput(this.#window, shown, own);
			if (r.ok) return { status: "opened", message: "" };
			// A changed link: read the result again so the page shows what is current.
			if (r.refusal === "stale") void this.read(shown.subject);
			return refusedOpen(r.refusal);
		} finally {
			this.#opening.delete(key);
			this.#publish();
		}
	}

	async inspect(shown: DeliveredWork, link: ArtifactLink): Promise<InspectResult> {
		// Only a pin the shown result itself names, never a latest revision.
		const own = shown.artifacts.find(
			(a) => a.artifactId === link.artifactId && a.sessionId === link.sessionId && a.revision === link.revision,
		);
		if (!own || own.kind !== link.kind || !artifactSelection(shown, own)) return refusedInspect("unavailable");
		const r = await readDeliveryArtifact(this.#window, shown, own);
		if (r.ok) return { status: "shown", artifact: r.snapshot };
		// A changed result or pin: read the result again so the page shows what is current.
		if (r.refusal === "stale") void this.read(shown.subject);
		return refusedInspect(r.refusal);
	}

	dispose(): void {
		this.#closed = true;
		this.#listeners.clear();
	}
}

/** The results' view, mirrored in one signal that only the source's listener sets. */
export type DeliveryMirror = {
	source: DeliverySource;
	view: Signal<DeliveryView>;
	close: () => void;
};

/** Mirrors `source`'s view. */
export function mirrorDelivery(source: DeliverySource): DeliveryMirror {
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
