// Today's New section over the native root: the selected project's request
// pages, the user's Later and Discard, and an explicit Start. A read only
// reads. Each write names the exact request, its revision and the project
// context shown; Rust saves the operation and sends it once. A write whose
// answer is lost stays Unknown, also after reopening: Check reads that one
// operation's saved receipt and never sends again (docs/technical/day-intake.md).
import { type Signal, signal } from "nsh";
import type { Intake, Request } from "pilot-day/native";
import { call, type Refusal, type Reply } from "./bridge";
import { glide } from "./motion";

/** The user's triage of a request. Separate from any Slack or Linear status. */
export type Triage = "new" | "later" | "discarded";

/** A request as shown, with the exact revision a write names. */
export type IntakeRow = { request: Request; revision: number };

/** One intake write Pilot saved and sent. */
export type IntakeOp = {
	operationId: string;
	itemId: string;
	kind: "triage" | "start";
	/** What a triage asked for. Null for a Start. */
	asked: Triage | null;
	/** The mission a Start chose. Null for standalone work. */
	missionId: string | null;
	/** The chat a Start names. Null for a triage. */
	sessionId: string | null;
	/** Unknown until a receipt says otherwise; checking while Check reads it. */
	delivery: "unknown" | "checking" | "accepted" | "rejected";
	/** The request's title when Pilot read it, else empty. */
	title: string;
	/** Why the service refused it, exactly as written. */
	reason: string;
};

/** What the New section shows. */
export type IntakeView = {
	/** "reading" before the first answer; "unavailable" when no read could be shown. */
	availability: "reading" | "live" | "unavailable";
	/** Why the requests are not shown, or why what is shown is from an earlier read. */
	reason: string;
	/** The project configuration the rows were read under. Every write names it. */
	contextDigest: string;
	/** The project the rows belong to, or "" before a read. */
	projectId: string;
	/** Sources, their trouble and unshown rows, from Rust's projection of the newest read. */
	intake: Intake;
	fresh: IntakeRow[];
	later: IntakeRow[];
	discarded: IntakeRow[];
	/** Writes whose result is not known. Only Check settles them. */
	unsettled: IntakeOp[];
	/** Writes settled while this window was open, oldest first. */
	settled: IntakeOp[];
	/** Confirmed Starts of standalone work, from every saved write: the chats they created. */
	started: IntakeOp[];
	/** Requests with a write on its way. */
	sending: string[];
};

/** What a write or a Check did, for the user. */
export type IntakeResult = {
	status: "accepted" | "stale" | "rejected" | "unknown";
	message: string;
	operationId: string | null;
};

export type TriageIntent = { itemId: string; revision: number; contextDigest: string; state: Triage };
export type StartIntent = { itemId: string; revision: number; contextDigest: string; missionId: string | null };

/** The New section's source. The connected window has one; the mock window has none. */
export interface IntakeSource {
	view(): IntakeView;
	onChange(listener: (view: IntakeView) => void): () => void;
	/** Reads the requests again. Passive: it sends, starts and settles nothing. */
	read(): Promise<void>;
	triage(intent: TriageIntent): Promise<IntakeResult>;
	start(intent: StartIntent): Promise<IntakeResult>;
	/** Reads one unsettled write's saved receipt. Never sends the write again. */
	check(operationId: string): Promise<IntakeResult>;
	dispose(): void;
}

const NO_INTAKE: Intake = { watched: false, sources: [], requests: [], trouble: [], more: "" };

/** What the root returns for a read, as far as the screen uses it. */
type RawItem = { id?: unknown; revision?: unknown; title?: unknown };
type Snapshot = {
	version: 1;
	projectId?: string;
	contextDigest: string;
	sources: { items?: RawItem[] }[];
	intake: Intake;
	later?: Intake;
	discarded?: Intake;
	claimed?: Intake;
};
type Summary = {
	operationId: string;
	itemId: string;
	kind: "intake-triage" | "intake-start";
	asked?: Triage | null;
	missionId?: string | null;
	sessionId?: string | null;
	state: string;
	receipt?: { state?: string; reason?: string } | null;
};

function isIntake(x: unknown): x is Intake {
	const i = x as Intake | null;
	return !!i && typeof i === "object" && Array.isArray(i.requests) && Array.isArray(i.trouble);
}

function snapshotOf(x: unknown): Snapshot | null {
	const s = x as Snapshot | null;
	if (!s || typeof s !== "object" || s.version !== 1 || typeof s.contextDigest !== "string") return null;
	if (!Array.isArray(s.sources) || !isIntake(s.intake)) return null;
	return s;
}

function summariesOf(x: unknown): Summary[] | null {
	if (!Array.isArray(x)) return null;
	return x.filter(
		(o): o is Summary =>
			!!o &&
			typeof o.operationId === "string" &&
			typeof o.itemId === "string" &&
			(o.kind === "intake-triage" || o.kind === "intake-start") &&
			typeof o.state === "string",
	);
}

/** Why requests could not be read, in one calm sentence. */
export function intakeReason(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service.";
		case "identity":
			return "The Pilot service changed. Open Pilot again to see them.";
		case "closed":
		case "busy":
			return "Pilot is closing.";
		case "denied":
		case "unavailable":
			return "This Pilot service cannot show requests here yet.";
		case "invalid":
			return "Pilot's service answered in a way this app does not understand.";
		default:
			return "Pilot could not read new requests.";
	}
}

/** Unknown words for a lost answer: the same promise everywhere. */
const UNKNOWN = "Pilot sent this but heard nothing back. It will not send it again; Check only reads.";

/** What a refused write means, before anything was saved or sent. */
function refused(refusal: Refusal): IntakeResult {
	const r = (status: IntakeResult["status"], message: string): IntakeResult => ({
		status,
		message,
		operationId: null,
	});
	switch (refusal) {
		case "lost":
		case "unknown":
			return r("unknown", UNKNOWN);
		case "stale":
			return r("stale", "This request changed since Pilot read it. Nothing was sent. Look again first.");
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
			return r("rejected", "This is not available here yet. Nothing was sent.");
		default:
			return r("rejected", "Pilot could not send this. Nothing was sent.");
	}
}

/** The New section over this window's native root. */
export class ConnectedIntake implements IntakeSource {
	#window: string;
	#snapshot: Snapshot | null = null;
	#refusal: Refusal | null = null;
	#ops: Summary[] = [];
	/** Call order: an answer to an older call never replaces a newer one's read. */
	#sent = 0;
	#applied = 0;
	#reading: Promise<void> | null = null;
	#again = false;
	#sending = new Set<string>();
	#checking = new Set<string>();
	/** Operations this window sent or checked, so their settled result can show. */
	#mine: string[] = [];
	/** Titles from every read in this window, for writes whose request left the read. */
	#titles = new Map<string, string>();
	#listeners = new Map<number, (view: IntakeView) => void>();
	#next = 0;
	#closed = false;

	constructor(window: string) {
		this.#window = window;
	}

	view(): IntakeView {
		const s = this.#snapshot;
		const revisions = new Map<string, number>();
		for (const source of s?.sources ?? []) {
			for (const item of source.items ?? []) {
				if (typeof item.id === "string" && typeof item.revision === "number") revisions.set(item.id, item.revision);
			}
		}
		const rows = (intake: Intake | undefined): IntakeRow[] =>
			(intake?.requests ?? [])
				.filter((r) => revisions.has(r.id))
				.map((request) => ({ request, revision: revisions.get(request.id) as number }));
		const op = (o: Summary): IntakeOp => ({
			operationId: o.operationId,
			itemId: o.itemId,
			kind: o.kind === "intake-start" ? "start" : "triage",
			asked: o.asked ?? null,
			missionId: o.missionId ?? null,
			sessionId: typeof o.sessionId === "string" ? o.sessionId : null,
			delivery:
				o.state === "accepted" || o.state === "rejected"
					? o.state
					: this.#checking.has(o.operationId)
						? "checking"
						: "unknown",
			title: this.#titles.get(o.itemId) ?? "",
			reason: o.receipt?.reason ?? "",
		});
		const sent = this.#ops.filter((o) => o.state !== "not-sent");
		const unsettled = sent.filter((o) => o.state !== "accepted" && o.state !== "rejected").map(op);
		const settled = this.#mine
			.map((id) => sent.find((o) => o.operationId === id))
			.filter((o): o is Summary => !!o && (o.state === "accepted" || o.state === "rejected"))
			.map(op);
		const reason = this.#refusal
			? s
				? `${intakeReason(this.#refusal)} What shows is from Pilot's last read.`
				: intakeReason(this.#refusal)
			: "";
		return {
			availability: s ? "live" : this.#refusal ? "unavailable" : "reading",
			reason,
			contextDigest: s?.contextDigest ?? "",
			projectId: typeof s?.projectId === "string" ? s.projectId : "",
			intake: s?.intake ?? NO_INTAKE,
			fresh: rows(s?.intake),
			later: rows(s?.later),
			discarded: rows(s?.discarded),
			unsettled,
			settled,
			started: sent
				.filter((o) => o.kind === "intake-start" && o.state === "accepted" && !o.missionId && o.sessionId)
				.map(op),
			sending: [...this.#sending],
		};
	}

	onChange(listener: (view: IntakeView) => void): () => void {
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

	/** One exact call. Only the newest call's answer replaces what is shown. */
	async #call(name: string, args: unknown) {
		const order = ++this.#sent;
		const r = await call<unknown>(this.#window, name, args);
		if (r.ok && order > this.#applied) {
			const snapshot = snapshotOf(r.snapshot);
			const ops = summariesOf(r.value.operations);
			if (snapshot) {
				this.#snapshot = snapshot;
				this.#refusal = null;
				for (const intake of [snapshot.intake, snapshot.later, snapshot.discarded, snapshot.claimed]) {
					for (const request of intake?.requests ?? []) this.#titles.set(request.id, request.title);
				}
			} else if (name === "day.intake.read") {
				this.#refusal = "invalid";
			}
			if (ops) this.#ops = ops;
			this.#applied = order;
		} else if (!r.ok && name === "day.intake.read" && order > this.#applied) {
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
		this.#reading = (async () => {
			do {
				this.#again = false;
				await this.#call("day.intake.read", {});
				this.#publish();
			} while (this.#again && !this.#closed);
		})().finally(() => {
			this.#reading = null;
		});
		return this.#reading;
	}

	/** Sends one write for `itemId` once. A request with a write on its way or unsettled takes no other. */
	async #write(itemId: string, name: string, args: Record<string, unknown>): Promise<IntakeResult> {
		if (this.#sending.has(itemId)) return refused("busy");
		if (this.view().unsettled.some((o) => o.itemId === itemId)) {
			return {
				status: "unknown",
				message: "An earlier change to this request is not confirmed. Check it first.",
				operationId: null,
			};
		}
		this.#sending.add(itemId);
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await this.#call(name, args);
		} finally {
			this.#sending.delete(itemId);
		}
		if (!r.ok) {
			// A lost answer may hide a saved operation: the read lists it as Unknown.
			void this.read();
			this.#publish();
			return refused(r.refusal);
		}
		const outcome = r.value.outcome as {
			operationId?: unknown;
			state?: unknown;
			receipt?: { reason?: unknown };
		} | null;
		const id = typeof outcome?.operationId === "string" ? outcome.operationId : null;
		if (id) this.#mine.push(id);
		// A write whose answer came without a fresh read keeps what was shown; read once more.
		if (!snapshotOf(r.snapshot)) void this.read();
		this.#publish();
		if (outcome?.state === "accepted") return { status: "accepted", message: "", operationId: id };
		if (outcome?.state === "rejected") {
			const reason = typeof outcome.receipt?.reason === "string" ? outcome.receipt.reason : "";
			return {
				status: "rejected",
				message: reason ? `Pilot's service refused it: ${reason}` : "Pilot's service refused it.",
				operationId: id,
			};
		}
		return { status: "unknown", message: UNKNOWN, operationId: id };
	}

	triage(intent: TriageIntent): Promise<IntakeResult> {
		const { itemId, revision, contextDigest, state } = intent;
		return this.#write(itemId, "day.intake.triage", { itemId, revision, contextDigest, state });
	}

	start(intent: StartIntent): Promise<IntakeResult> {
		const { itemId, revision, contextDigest, missionId } = intent;
		const args: Record<string, unknown> = { itemId, revision, contextDigest };
		if (missionId) args.missionId = missionId;
		return this.#write(itemId, "day.intake.start", args);
	}

	async check(operationId: string): Promise<IntakeResult> {
		if (this.#checking.has(operationId)) return refused("busy");
		this.#checking.add(operationId);
		this.#publish();
		let r: Reply<unknown>;
		try {
			r = await this.#call("day.intake.check", { operationId });
		} finally {
			this.#checking.delete(operationId);
		}
		if (!this.#mine.includes(operationId)) this.#mine.push(operationId);
		this.#publish();
		if (!r.ok) {
			return {
				status: "unknown",
				message: "Pilot could not check it now. Nothing was sent; it stays not confirmed.",
				operationId,
			};
		}
		const outcome = r.value.outcome as { state?: unknown } | null;
		if (outcome?.state === "accepted" || outcome?.state === "rejected") {
			return { status: outcome.state, message: "", operationId };
		}
		return {
			status: "unknown",
			message: "Pilot's service has no result for it yet. Nothing was sent again.",
			operationId,
		};
	}

	dispose(): void {
		this.#closed = true;
		this.#listeners.clear();
	}
}

/** The New section's view, mirrored in one signal that only the source's listener sets. */
export type IntakeMirror = {
	source: IntakeSource;
	view: Signal<IntakeView>;
	close: () => void;
};

/** Which rows show where: what a glide follows. */
function shape(v: IntakeView): string {
	return [v.fresh, v.later, v.discarded, v.unsettled]
		.map((l) => l.map((r) => ("request" in r ? r.request.id : r.operationId)).join(","))
		.join("|");
}

/** Mirrors `source`'s view. Rows that arrive or leave glide to their places. */
export function mirrorIntake(source: IntakeSource): IntakeMirror {
	const view = signal(source.view());
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
