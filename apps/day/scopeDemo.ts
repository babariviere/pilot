// A scripted Today scope source for the mock windows and headless tests.
// No daemon, worker, provider or storage: three invented projects, one of
// them unreadable. Like the native root, it answers each read with its
// generation, and a read can be held to answer out of order.
import { signal } from "nsh";
import { type Today, TodayFeed } from "pilot-day/native";
import type { Refusal } from "./bridge";
import type { DeliveredWork } from "./deliveryContract";
import type { ScopeSource } from "./todayScope";

/** What a test can make the script do next. */
export type ScopeScript = {
	/** The service has no scope read: every read is refused. */
	unavailable: boolean;
	/** Hold every answer until `release`. */
	hold: boolean;
	/** Whether billing can be read. */
	billingReadable: boolean;
};

/** The demo projects. The first is the window's own (see chatDemo.ts). */
export const SCOPE_PROJECTS = [
	{ id: "demo-pilot", name: "pilot" },
	{ id: "demo-website", name: "website" },
	{ id: "demo-billing", name: "billing" },
];

export class ScriptedScope implements ScopeSource {
	script: ScopeScript = { unavailable: false, hold: false, billingReadable: false };
	/** Reads that reached the script. */
	readonly reads = signal(0);
	#own: () => Today;
	#website: Today;
	#billing: Today;
	#held: (() => void)[] = [];

	/** `own` is the window's own Today, as its feed shows it now. */
	constructor(own: () => Today) {
		this.#own = own;
		const feed = new TodayFeed("actions");
		this.#website = feed.snapshot();
		feed.dispose();
		const quiet = new TodayFeed("quiet");
		this.#billing = quiet.snapshot();
		quiet.dispose();
	}

	/** Answers the oldest held read, or the newest. */
	release(newestFirst = false) {
		const next = newestFirst ? this.#held.pop() : this.#held.shift();
		next?.();
	}

	async read(scope: string, generation: number) {
		this.reads.set(this.reads() + 1);
		if (this.script.hold) await new Promise<void>((resolve) => this.#held.push(resolve));
		if (this.script.unavailable) return { ok: false as const, refusal: "unavailable" as Refusal };
		if (scope !== "all" && !SCOPE_PROJECTS.some((p) => p.id === scope))
			return { ok: false as const, refusal: "invalid" as Refusal };
		const needs = (t: Today) => t.decisions.length + t.actions.length;
		const rows = SCOPE_PROJECTS.map((p) => {
			const selected = scope === "all" || scope === p.id;
			const today = p.id === "demo-pilot" ? this.#own() : p.id === "demo-website" ? this.#website : this.#billing;
			const readable = p.id !== "demo-billing" || this.script.billingReadable;
			return {
				id: p.id,
				name: p.name,
				selected,
				currentness: readable ? "live" : "unavailable",
				observedAt: "",
				needsYou: readable ? { count: needs(today), complete: true } : { count: null, complete: false },
				today: selected && readable ? today : null,
				planning: null,
				intake: null,
				results: {
					complete: readable,
					more: false,
					reason: readable ? "" : "Delivered results could not be read.",
					items:
						selected && p.id === "demo-website"
							? [
									{
										subject: { kind: "task", projectId: p.id, missionId: "site", taskId: "copy" },
										title: "Landing page copy",
										currentness: "live",
										snapshot: {
											version: 1,
											subject: { kind: "task", projectId: p.id, missionId: "site", taskId: "copy" },
											deliveryId: "d".repeat(64),
											targetId: "copy",
											ownerSessionId: null,
											pullRequests: [],
											artifacts: [],
											production: "not_tracked",
											verification: null,
											verificationCurrent: false,
											verificationReceiptState: "unknown",
											verificationRevision: 0,
											pendingOperationId: null,
										} satisfies DeliveredWork,
									},
								]
							: [],
				},
				canAct: false,
				errors: readable ? {} : { today: "Pilot could not reach billing's coordinator." },
			};
		});
		const outside = rows.filter((r) => !r.selected);
		const unknown = outside.some((r) => r.needsYou.count === null);
		return {
			ok: true as const,
			snapshot: {
				version: 1,
				scope,
				generation,
				catalogComplete: true,
				complete: rows.every((r) => !r.selected || r.currentness === "live"),
				projects: rows,
				outsideNeedsYou: unknown
					? { count: null, complete: false }
					: { count: outside.reduce((n, r) => n + (r.needsYou.count ?? 0), 0), complete: true },
			},
		};
	}
}
