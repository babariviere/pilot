// Mock data for headless tests only. No daemon, worker, provider or storage.
// A scripted request source with the connected source's rules: a write names
// the exact request, revision and context shown and is sent once; a lost
// answer stays Unknown until Check reads it; Check never sends again.
import { signal } from "nsh";
import type { Request } from "pilot-day/native";
import { LOST, type Refusal } from "./refusals";
import {
	type IntakeOp,
	type IntakeResult,
	type IntakeSource,
	type IntakeView,
	intakeReason,
	type StartIntent,
	type Triage,
	type TriageIntent,
} from "./intakeFeed";

type Item = {
	id: string;
	title: string;
	source: "slack" | "linear";
	place: string;
	who?: string;
	quote?: string;
	client?: string;
	reporter?: string;
	kind?: string;
	triage: Triage;
	revision: number;
	claimed: boolean;
	linked: boolean;
};
const items: Item[] = [
	{
		id: "northwind",
		title: "Northwind can't export invoices to CSV",
		source: "slack" as const,
		place: "#client-northwind",
		who: "Jane Doe",
		quote: "Since this morning the Export button on the invoices page spins forever and no file comes out.",
		client: "Northwind",
		reporter: "Jane Doe",
		kind: "Bug, high",
	},
	{ id: "stripe", title: "Update the Stripe SDK to v15", source: "slack" as const, place: "#billing-eng" },
	{ id: "bil-231", title: "CSV export times out for large accounts", source: "linear" as const, place: "BIL-231" },
].map((i) => ({ ...i, triage: "new" as Triage, revision: 1, claimed: false, linked: false }));

const DIGEST = "a".repeat(64);
let context = DIGEST;
const ops: IntakeOp[] = [];
const settled: string[] = [];
const sending = new Set<string>();
/** Sends, Checks and reads so far. */
export const intakeCounts = signal({ sends: 0, checks: 0, reads: 0 });
const lose = signal(false);
const hold = signal(false);
const unreadable = signal<Refusal | null>(null);
const trouble = signal(false);
const incomplete = signal(false);
const changeOnSend = signal(false);
let release: (() => void) | null = null;
const listeners = new Set<(v: IntakeView) => void>();
let readOnce = false;
/** Every request link handed to the browser, in order. Opening is never a send. */
export const intakeOpened = signal<string[]>([]);

function count(key: "sends" | "checks" | "reads") {
	intakeCounts.set({ ...intakeCounts(), [key]: intakeCounts()[key] + 1 });
}

function request(i: Item): Request {
	return {
		id: i.id,
		source: i.source,
		sourceLabel: i.source === "slack" ? "Slack" : "Linear",
		title: i.title,
		place: i.place,
		kind: i.kind ?? "",
		age: i.source === "slack" ? "20 min ago" : "",
		link:
			i.source === "slack" && i.id === "northwind"
				? "https://example.slack.com/archives/C0MOCK/p1791892800000100"
				: "",
		who: i.who ?? "",
		quote: i.quote ?? "",
		client: i.client ?? "",
		reporter: i.reporter ?? "",
	};
}

const rows = (t: Triage) =>
	items
		.filter((i) => i.triage === t && !i.claimed && !i.linked)
		.map((i) => ({ request: request(i), revision: i.revision }));

function view(): IntakeView {
	if (!readOnce || unreadable()) {
		return {
			availability: readOnce ? "unavailable" : "reading",
			reason: readOnce ? intakeReason(unreadable() ?? "offline") : "",
			contextDigest: "",
			projectId: "",
			intake: { watched: false, sources: [], requests: [], trouble: [], more: "" },
			fresh: [],
			later: [],
			discarded: [],
			unsettled: ops.filter((o) => o.delivery === "unknown" || o.delivery === "checking"),
			settled: [],
			started: [],
			sending: [],
			canOpen: true,
		};
	}
	const fresh = rows("new");
	return {
		availability: "live",
		reason: "",
		contextDigest: context,
		projectId: "project",
		intake: {
			watched: true,
			sources: ["Slack", "Linear"],
			requests: fresh.map((r) => r.request),
			trouble: trouble() ? ["Slack needs you to sign in again. These are the requests Pilot read before."] : [],
			more: incomplete() ? "40 more Slack messages are not shown here." : "",
		},
		fresh,
		later: rows("later"),
		discarded: rows("discarded"),
		unsettled: ops.filter((o) => o.delivery === "unknown" || o.delivery === "checking"),
		settled: settled.map((id) => ops.find((o) => o.operationId === id) as IntakeOp),
		started: [],
		sending: [...sending],
		canOpen: true,
	};
}

function publish() {
	const v = view();
	for (const l of listeners) l(v);
}

let next = 0;
async function write(
	itemId: string,
	revision: number,
	digest: string,
	effect: (i: Item) => void,
	op: Omit<IntakeOp, "operationId" | "itemId" | "delivery" | "title" | "reason">,
): Promise<IntakeResult> {
	const item = items.find((i) => i.id === itemId);
	if (
		!item ||
		sending.has(itemId) ||
		ops.some((o) => o.itemId === itemId && o.delivery !== "accepted" && o.delivery !== "rejected")
	) {
		return { status: "rejected", message: "Refused before sending.", operationId: null };
	}
	if (changeOnSend()) {
		changeOnSend.set(false);
		item.revision += 1;
	}
	if (item.revision !== revision || digest !== context) {
		publish();
		return {
			status: "stale",
			message: "This request changed since Pilot read it. Nothing was sent. Look again first.",
			operationId: null,
		};
	}
	sending.add(itemId);
	publish();
	if (hold())
		await new Promise<void>((r) => {
			release = r;
		});
	sending.delete(itemId);
	count("sends");
	const operationId = `op-${++next}`;
	effect(item);
	item.revision += 1;
	const lost = lose();
	lose.set(false);
	ops.push({ operationId, itemId, delivery: lost ? "unknown" : "accepted", title: item.title, reason: "", ...op });
	if (!lost) settled.push(operationId);
	publish();
	return lost
		? {
				status: "unknown",
				message: LOST,
				operationId,
			}
		: { status: "accepted", message: "", operationId };
}

/** The scripted source. Each fixture opens a fresh app, so its state starts over. */
export const scriptedIntake: IntakeSource = {
	view,
	onChange(l) {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	async read() {
		readOnce = true;
		count("reads");
		publish();
	},
	triage(i: TriageIntent) {
		return write(
			i.itemId,
			i.revision,
			i.contextDigest,
			(item) => {
				item.triage = i.state;
			},
			{ kind: "triage", asked: i.state, missionId: null, sessionId: null },
		);
	},
	start(i: StartIntent) {
		return write(
			i.itemId,
			i.revision,
			i.contextDigest,
			(item) => {
				item.claimed = true;
			},
			{ kind: "start", asked: null, missionId: i.missionId, sessionId: null },
		);
	},
	async check(operationId: string) {
		const op = ops.find((o) => o.operationId === operationId);
		if (!op) return { status: "unknown", message: "No such operation.", operationId };
		count("checks");
		op.delivery = "accepted";
		const item = items.find((i) => i.id === op.itemId);
		if (item && op.kind === "start") item.linked = true;
		settled.push(operationId);
		publish();
		return { status: "accepted", message: "", operationId };
	},
	async open(i) {
		const item = items.find((x) => x.id === i.itemId);
		const link = item ? request(item).link : "";
		if (!item || item.revision !== i.revision || !link) {
			return {
				status: "stale",
				message: "This request changed since Pilot read it. Nothing opened.",
				operationId: null,
			};
		}
		intakeOpened.set([...intakeOpened(), link]);
		return { status: "accepted", message: "", operationId: null };
	},
	dispose() {
		listeners.clear();
	},
};

/** What the fixtures' buttons do to the scripted source. */
export const intakeScript = {
	loseNext: () => lose.set(true),
	hold: () => hold.set(true),
	release: () => {
		hold.set(false);
		release?.();
		release = null;
	},
	changeOnSend: () => changeOnSend.set(true),
	changeFirst: () => {
		items[0].revision += 1;
		publish();
	},
	changeProject: () => {
		context = "b".repeat(64);
		publish();
	},
	trouble: () => {
		trouble.set(true);
		incomplete.set(true);
		publish();
	},
	unreadable: (refusal: Refusal) => {
		unreadable.set(refusal);
		publish();
	},
	readable: () => {
		unreadable.set(null);
		publish();
	},
};
