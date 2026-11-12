// A scripted source of saved Linear issues with the connected read's scope,
// for the mock windows and headless tests. No daemon, provider, Linear or
// storage: the issues are invented to match the mock missions and requests.
// Like `day.linear.read`, it returns only the user's own saved issues and the
// saved cycle, counts what it does not show and never changes Linear.
import { signal } from "nsh";
import { type LinearSource, type LinearView, linearReason } from "./linearFeed";
import type { SavedLinearRead, TrackedItem } from "./linearRead";

/** The mock world's project. */
const PROJECT = "mock-project";

function issue(
	id: string,
	key: string,
	title: string,
	status: string,
	statusType: string,
	extra: Partial<TrackedItem> = {},
): TrackedItem {
	return {
		revision: 1,
		triageState: "new",
		id,
		projectId: PROJECT,
		kind: "linear",
		externalId: `mock-${id}`,
		title,
		url: `https://linear.app/mock/issue/${key}`,
		status,
		metadata: { identifier: key, statusType },
		dismissed: false,
		createdAt: 1,
		updatedAt: 1,
		...extra,
	};
}

const ISSUES: TrackedItem[] = [
	issue("ln-219", "BIL-219", "Retry failed webhooks with backoff", "In Progress", "started", {
		missionId: "search",
		sessionId: "chat-219",
		missionIds: ["old-mission", "search"],
		sessionIds: ["chat-219"],
	}),
	issue("ln-224", "BIL-224", "Invoice PDF footer overlaps totals", "In Review", "started", { sessionId: "chat-224" }),
	// The mock world's Linear request in New.
	issue("ln-231", "BIL-231", "CSV export times out for large accounts", "Todo", "unstarted"),
	issue("ln-226", "BIL-226", "Show tax ID on credit notes", "Backlog", "backlog", { triageState: "later" }),
	// Same title as a mission on Today, but no saved link: never shown as part of it.
	issue("ln-240", "BIL-240", "Faster search", "Todo", "unstarted"),
	issue("ln-227", "BIL-227", "Refund webhook is missing the currency", "Done", "completed", { missionId: "archived" }),
	issue("ln-230", "BIL-230", "Old invoice importer", "Canceled", "canceled", {
		linearParent: { id: "p-200", identifier: "BIL-200", title: "Billing cleanup", url: "https://linear.app/mock" },
	}),
];

/** What the next read returns. */
export type LinearDemoMode = "saved" | "trouble" | "notCurrent" | "unset" | "unreadable" | "overflow" | "noCycle";

function overflow(): TrackedItem[] {
	return Array.from({ length: 100 }, (_, i) =>
		issue(`ln-${500 + i}`, `BIL-${500 + i}`, `Saved issue ${i + 1}`, "Todo", "unstarted"),
	);
}

function snapshot(m: LinearDemoMode): SavedLinearRead | null {
	if (m === "unreadable") return null;
	const current = m !== "notCurrent" && m !== "unset";
	const items = !current ? [] : m === "overflow" ? overflow() : m === "noCycle" ? ISSUES.slice(0, 3) : ISSUES;
	const total = m === "overflow" ? 130 : items.length;
	return {
		version: 1,
		projectId: PROJECT,
		contextDigest: "a".repeat(64),
		scope: "saved-own-issues",
		configurationCurrent: current,
		source: {
			id: `${PROJECT}:linear`,
			projectId: PROJECT,
			kind: "linear",
			label: "Linear",
			configured: m !== "unset",
			status: m === "unset" ? "not_configured" : m === "trouble" ? "sign_in_required" : "ok",
			...(current ? { lastPolledAt: Date.UTC(2026, 10, 12, 9, 30) } : {}),
			...(!current
				? {}
				: m === "noCycle"
					? {
							linear: {
								cycleStatus: "no_active_cycle" as const,
								statusMessage: "Cycles are disabled or no cycle is active. Showing your open issues.",
							},
						}
					: {
							linear: {
								cycleStatus: "current" as const,
								currentCycle: {
									id: "c42",
									number: 42,
									startsAt: "2026-11-03T12:00:00Z",
									endsAt: "2026-11-16T12:00:00Z",
									progress: 0.3,
									total: 7,
									done: 2,
									inProgress: 2,
									todo: 3,
								},
							},
						}),
		},
		items,
		limit: 100,
		total,
		complete: total === items.length,
		more: total - items.length,
	};
}

/** Demo saved issues. `mode` picks what the next read returns; `reads` counts reads. */
export class ScriptedLinear implements LinearSource {
	readonly mode = signal<LinearDemoMode>("saved");
	readonly reads = signal(0);
	#last: SavedLinearRead | null = null;
	#refused = false;
	#listeners = new Set<(v: LinearView) => void>();

	view(): LinearView {
		const reason = this.#refused
			? this.#last
				? `${linearReason("offline")} What shows is from Pilot's last read.`
				: linearReason("offline")
			: "";
		return {
			availability: this.#last ? "live" : this.#refused ? "unavailable" : this.reads() ? "reading" : "idle",
			reason,
			read: this.#last,
			reading: false,
		};
	}

	onChange(listener: (v: LinearView) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async read(): Promise<void> {
		this.reads.set(this.reads() + 1);
		const next = snapshot(this.mode());
		this.#refused = !next;
		if (next) this.#last = next;
		const v = this.view();
		for (const l of this.#listeners) l(v);
	}

	dispose(): void {
		this.#listeners.clear();
	}
}
