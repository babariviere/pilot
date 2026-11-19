// Today's project scope: which projects Today shows, per window, and the
// passive cross-project read behind it (`day.today.scope`). The choice is
// the window's own, saved with its other screen state. Changing it reads
// only: it moves no draft, starts or sends nothing and never retargets a
// chat. The native root names the project the window acts on (`own`);
// other projects' rows carry no actions (`canAct` is false).
// What Pilot could not read stays unknown, never zero or empty.
import { type Signal, signal } from "nsh";
import type { Planning, Today } from "pilot-day/native";
import { call, type Refusal } from "./bridge";
import { type CodingQueue, queueOf } from "./codingQueue";
import type { DeliveredWork, VerificationSubject } from "./deliveryContract";
import { FAILED_TRIES, retryDelay, staleLine, staleWarning } from "./freshness";

/** Passive results from another project. No actions can use that project's root. */
export type ScopeResults = {
	complete: boolean;
	more: boolean | null;
	reason: string;
	items: {
		subject: VerificationSubject;
		snapshot: DeliveredWork | null;
		title: string;
		currentness: string;
		unsettled?: boolean;
	}[];
};

/** The window's Today scope: "all" for All projects, else one project's ID. */
export const todayProject = signal<string>("all");

/** A count Pilot may not know. Null with complete false is unknown, never zero. */
export type ScopeCount = { count: number | null; complete: boolean };

/** Activity is authored by the host, not inferred from mission reports. */
export type WorkingChat = {
	sessionId: string;
	title: string;
	missionId: string | null;
	missionTitle: string | null;
	purpose: string | null;
	status: "working";
};
/** A chat whose saved input waits for a coding slot. Not Needs you: it starts by itself. */
export type WaitingChat = {
	sessionId: string;
	title: string;
	missionId: string | null;
	missionTitle: string | null;
	queue: CodingQueue;
};
export type WorkingRead = {
	state: "live" | "stale" | "disconnected" | "failed" | "unavailable";
	items: WorkingChat[];
	/** First in line first. Null or absent when Pilot does not know. */
	waiting?: WaitingChat[] | null;
};

/** One project in a scope read. Only selected projects carry their sections. */
export type ScopeProject = {
	id: string;
	name: string;
	selected: boolean;
	/** "reading" only in the first read of a switch: the complete read fills it in. */
	currentness: "live" | "stale" | "unavailable" | "reading";
	observedAt: string;
	needsYou: ScopeCount;
	today: Today | null;
	planning: Planning | null;
	/** Also reported for projects read only for outside counts. */
	planningRead?: "read" | "offline" | "stale" | "refused";
	/** Legacy project-bound windows cannot open other projects' interviews. */
	canOpenPlanning?: boolean;
	results?: ScopeResults | null;
	/** Why a section of this project could not be read, by section. */
	errors: Record<string, string>;
	working?: WorkingRead | null;
};

/** One scope read, as the root answered it. */
export type ScopeSnapshot = {
	scope: string;
	generation: number;
	/** The project this window acts on now, as the native root says, or null. */
	own: string | null;
	/** Whether the project list itself is complete. */
	catalogComplete: boolean;
	/** Whether every selected project's sections were read. */
	complete: boolean;
	/** The first read of a switch: only the selected project was read; the others follow. */
	partial: boolean;
	projects: ScopeProject[];
	/** What needs the user outside the scope. */
	outsideNeedsYou: ScopeCount;
};

/** What Today shows about the scope read. */
export type ScopeView = {
	/** "reading" before the first answer; "unavailable" when no read can be shown. */
	state: "reading" | "live" | "unavailable";
	/** Why the read is not shown, or why it is earlier, or "". */
	reason: string;
	/** The newest accepted read for the current scope, or null. */
	snapshot: ScopeSnapshot | null;
};

/** The scope source. The connected window's asks its root; mock windows' is a script. */
export interface ScopeSource {
	/**
	 * Reads `scope` with `generation`. Passive: it sends, starts and moves nothing.
	 * `selectedOnly` reads only the selected project, as the first read of a switch.
	 */
	read(
		scope: string,
		generation: number,
		selectedOnly?: boolean,
	): Promise<{ ok: true; snapshot: unknown } | { ok: false; refusal: Refusal }>;
}

/** A saved scope changes only the view, never native project authority. */
export function restoreTodayScope(saved = "") {
	todayProject.set(saved || "all");
}

/** Why the scope read is not shown, in one calm sentence. */
export function scopeReason(refusal: Refusal): string {
	switch (refusal) {
		case "offline":
			return "Pilot could not reach its service.";
		case "identity":
			return "The Pilot service changed. Open Pilot again.";
		case "closed":
		case "busy":
			return "Pilot is closing.";
		case "denied":
		case "unavailable":
			return "This Pilot service cannot read your other projects here yet.";
		case "invalid":
			return "Pilot's service answered in a way this app does not understand.";
		default:
			return "Pilot could not read your other projects.";
	}
}

function count(x: unknown): ScopeCount | null {
	const c = x as { count?: unknown; complete?: unknown } | null;
	if (!c || typeof c.complete !== "boolean") return null;
	if (c.count === null) return { count: null, complete: false };
	if (typeof c.count !== "number" || !Number.isSafeInteger(c.count) || c.count < 0) return null;
	return { count: c.count, complete: c.complete };
}

const LISTS = ["decisions", "actions", "moving", "notMoving", "unreported", "done"] as const;

/** A project's Today, if it has the lists Today shows. Anything else is not shown. */
function todayOf(x: unknown): Today | null {
	const t = x as Record<string, unknown> | null;
	if (!t || typeof t !== "object" || !LISTS.every((k) => Array.isArray(t[k]))) return null;
	return t as unknown as Today;
}

function planningOf(x: unknown): Planning | null {
	const p = x as { plans?: unknown } | null;
	return p && typeof p === "object" && Array.isArray(p.plans) ? (p as unknown as Planning) : null;
}

/** A scope read, checked. Null when it is not the shape this app reads. */
export function scopeOf(x: unknown): ScopeSnapshot | null {
	const s = x as Record<string, unknown> | null;
	if (s?.version !== 1 || typeof s.scope !== "string" || typeof s.generation !== "number") return null;
	if (typeof s.catalogComplete !== "boolean" || typeof s.complete !== "boolean" || !Array.isArray(s.projects))
		return null;
	const outside = count(s.outsideNeedsYou);
	if (!outside) return null;
	const projects: ScopeProject[] = [];
	for (const raw of s.projects as Record<string, unknown>[]) {
		const needs = count(raw?.needsYou);
		const currentness = raw?.currentness;
		if (
			!raw ||
			typeof raw.id !== "string" ||
			typeof raw.name !== "string" ||
			typeof raw.selected !== "boolean" ||
			(currentness !== "live" &&
				currentness !== "stale" &&
				currentness !== "unavailable" &&
				currentness !== "reading") ||
			!needs
		)
			return null;
		// No scoped action authority is read from a reply: rows stay read only.
		if (raw.canAct !== undefined && raw.canAct !== false) return null;
		const errors: Record<string, string> = {};
		if (raw.errors && typeof raw.errors === "object") {
			for (const [k, v] of Object.entries(raw.errors as Record<string, unknown>)) {
				if (typeof v === "string") errors[k] = v;
			}
		}
		const today = raw.selected ? todayOf(raw.today) : null;
		if (raw.selected && raw.today != null && !today) errors.today ||= "Pilot could not read this project's Today.";
		projects.push({
			id: raw.id,
			name: raw.name,
			selected: raw.selected,
			currentness,
			observedAt: typeof raw.observedAt === "string" ? raw.observedAt : "",
			needsYou: needs,
			today,
			planning: raw.selected ? planningOf(raw.planning) : null,
			planningRead:
				raw.planningRead === "read" ||
				raw.planningRead === "offline" ||
				raw.planningRead === "stale" ||
				raw.planningRead === "refused"
					? raw.planningRead
					: undefined,
			canOpenPlanning: raw.canOpenPlanning !== false,
			results: raw.selected ? resultsOf(raw.results, raw.id) : null,
			working: raw.selected ? workingOf(raw.working) : null,
			errors,
		});
	}
	return {
		scope: s.scope,
		generation: s.generation,
		own: typeof s.own === "string" && s.own !== "" ? s.own : null,
		catalogComplete: s.catalogComplete,
		complete: s.complete,
		partial: s.partial === true,
		projects,
		outsideNeedsYou: outside,
	};
}

function workingOf(x: unknown): WorkingRead | null {
	const w = x as WorkingRead | null;
	if (!w || !["live", "stale", "disconnected", "failed", "unavailable"].includes(w.state) || !Array.isArray(w.items))
		return null;
	const seen = new Set<string>();
	for (const r of w.items) {
		if (
			!r ||
			typeof r.sessionId !== "string" ||
			!r.sessionId ||
			typeof r.title !== "string" ||
			r.status !== "working" ||
			![r.missionId, r.missionTitle, r.purpose].every((v) => v === null || typeof v === "string")
		)
			return null;
		if (seen.has(r.sessionId)) return null;
		seen.add(r.sessionId);
	}
	return { state: w.state, items: w.items, waiting: waitingOf((w as { waiting?: unknown }).waiting) };
}

/** Waiting rows, or null when they do not read. They never make the working list fail. */
function waitingOf(x: unknown): WaitingChat[] | null {
	if (!Array.isArray(x)) return null;
	const rows: WaitingChat[] = [];
	const seen = new Set<string>();
	for (const r of x as Record<string, unknown>[]) {
		const queue = r ? queueOf(r.queue) : null;
		if (
			!queue ||
			typeof r.sessionId !== "string" ||
			!r.sessionId ||
			seen.has(r.sessionId) ||
			typeof r.title !== "string" ||
			![r.missionId, r.missionTitle].every((v) => v === null || typeof v === "string")
		)
			return null;
		seen.add(r.sessionId);
		rows.push({
			sessionId: r.sessionId,
			title: r.title,
			missionId: (r.missionId as string | null) ?? null,
			missionTitle: (r.missionTitle as string | null) ?? null,
			queue,
		});
	}
	return rows;
}

function resultsOf(x: unknown, project: string): ScopeResults | null {
	const r = x as ScopeResults | null;
	if (!r || typeof r.complete !== "boolean" || !Array.isArray(r.items) || r.items.length > 40) return null;
	if (
		r.items.some(
			(i) =>
				!i.subject ||
				i.subject.projectId !== project ||
				(i.snapshot && (i.snapshot.version !== 1 || i.snapshot.subject.projectId !== project)),
		)
	)
		return null;
	return {
		complete: r.complete,
		more: r.more,
		reason: typeof r.reason === "string" ? r.reason : "",
		items: r.items.map((i) => ({ ...i, title: typeof i.title === "string" ? i.title : "A delivered result" })),
	};
}

/** The connected window's scope source: its root's `day.today.scope`. */
export class ConnectedScope implements ScopeSource {
	#window: string;
	constructor(window: string) {
		this.#window = window;
	}
	async read(scope: string, generation: number, selectedOnly = false) {
		const r = await call<unknown>(
			this.#window,
			"day.today.scope",
			selectedOnly ? { scope, generation, selectedOnly } : { scope, generation },
		);
		return r.ok ? { ok: true as const, snapshot: r.snapshot } : { ok: false as const, refusal: r.refusal };
	}
}

/** Today's scope reads, mirrored in one signal. Only the newest read counts. */
export type ScopeMirror = {
	view: Signal<ScopeView>;
	/** Activity never stays live across an invalidation or failed read. */
	activity: Signal<"reading" | "live" | "stale" | "disconnected" | "failed">;
	/** Last read failed or was invalidated. Ordinary passive re-reads do not change this. */
	incomplete: Signal<boolean>;
	/** A newer event ages entered reads; completed same-scope reads still advance as earlier. */
	invalidate: () => void;
	/** The projects the last complete project list named, kept across scope changes. */
	catalog: Signal<{ id: string; name: string }[]>;
	/** Reads `scope` again. Passive; an older answer never replaces a newer one. */
	read: (scope: string) => Promise<void>;
	/** Stops the automatic retry. */
	close?: () => void;
};

// Generations increase on every read, also across a reload of the screens:
// the root rejects an older one.
let generation = Date.now();

/** Refusals that pass: the service is down, slow, busy or changing. Pilot tries again by itself. */
const PASSING = new Set<Refusal>(["offline", "unknown", "stale", "busy", "lost"]);

/** Mirrors `source` for one window. */
export function mirrorScope(source: ScopeSource): ScopeMirror {
	const view = signal<ScopeView>({ state: "reading", reason: "", snapshot: null });
	const activity = signal<"reading" | "live" | "stale" | "disconnected" | "failed">("reading");
	const incomplete = signal(true);
	const catalog = signal<{ id: string; name: string }[]>([]);
	let newest = 0;
	let invalidated = 0;
	// What the shown snapshot and catalog hold, without the generation: an
	// unchanged answer does not set the view again, so nothing redraws.
	let shown = "";
	let listed = "";
	// The scope last asked for, and how many passing failures in a row it had.
	let wanted = "";
	let failures = 0;
	let retry: ReturnType<typeof setTimeout> | null = null;
	let closed = false;
	const stopRetry = () => {
		if (retry !== null) clearTimeout(retry);
		retry = null;
	};
	// The last good read of each recent scope, so switching back shows it at
	// once. At most 4: All projects and the 3 projects chosen last. Each read
	// can be large (it holds every selected project's Today), so older ones go.
	const goods = new Map<string, { key: string; snapshot: ScopeSnapshot; at: number }>();
	const remember = (scope: string, good: { key: string; snapshot: ScopeSnapshot; at: number }) => {
		goods.delete(scope);
		goods.set(scope, good);
		while (goods.size > 4) goods.delete(goods.keys().next().value as string);
	};
	const read = async (scope: string) => {
		const mine = ++generation;
		const epoch = invalidated;
		newest = mine;
		activity.set(
			view().snapshot?.scope === scope && activity() !== "failed" && activity() !== "disconnected"
				? "stale"
				: "reading",
		);
		// Switching to one project reads it alone first, so it shows at once;
		// the complete read that follows fills in the other projects in place.
		const first = scope !== wanted && scope !== "all";
		if (scope !== wanted) {
			// Another scope's rows never show while this one is read. Its own
			// last good read, if any, shows meanwhile.
			wanted = scope;
			incomplete.set(true);
			failures = 0;
			const kept = goods.get(scope);
			shown = kept ? kept.key : "";
			if (view().snapshot?.scope !== scope)
				view.set(
					kept
						? { state: "live", reason: "", snapshot: kept.snapshot }
						: { state: "reading", reason: "", snapshot: null },
				);
		}
		stopRetry();
		const r = await source
			.read(scope, mine, first)
			.catch(() => ({ ok: false as const, refusal: "invalid" as Refusal }));
		// A newer read was asked for: this answer means nothing now.
		if (mine !== newest) return;
		incomplete.set(!r.ok || epoch !== invalidated);
		if (!r.ok && PASSING.has(r.refusal)) {
			// A passing failure: the service is down, slow or busy. Pilot tries
			// again with backoff. Rows of this scope stay without a note until
			// they are old (freshness.ts); with none, it reads quietly, and says
			// so only after 3 failed tries.
			activity.set(
				r.refusal === "offline"
					? "disconnected"
					: r.refusal === "stale" || r.refusal === "busy"
						? "stale"
						: "failed",
			);
			if (r.refusal !== "stale" && r.refusal !== "busy") failures += 1;
			const earlier = view().snapshot;
			const keep = earlier && earlier.scope === scope ? earlier : null;
			const at = goods.get(scope)?.at ?? null;
			const next: ScopeView = keep
				? {
						state: "live",
						reason: staleWarning({ readAt: at, failures }, Date.now()) && at !== null ? staleLine(at) : "",
						snapshot: keep,
					}
				: failures >= FAILED_TRIES
					? { state: "unavailable", reason: scopeReason(r.refusal), snapshot: null }
					: { state: "reading", reason: "", snapshot: null };
			const v = view();
			if (v.state !== next.state || v.reason !== next.reason || v.snapshot !== next.snapshot) view.set(next);
			retry = setTimeout(() => {
				retry = null;
				if (!closed && wanted === scope && mine === newest) void read(scope);
			}, retryDelay(failures));
			return;
		}
		if (!r.ok) {
			// A refusal that does not pass: the service cannot give this read.
			// Rows from before would look current, so they go.
			activity.set("failed");
			const denied = r.refusal === "identity" || r.refusal === "denied";
			goods.delete(scope);
			shown = "";
			if (denied) {
				catalog.set([]);
				listed = "";
				goods.clear();
			}
			view.set({ state: "unavailable", reason: scopeReason(r.refusal), snapshot: null });
			return;
		}
		let snapshot = scopeOf(r.snapshot);
		if (!snapshot || snapshot.scope !== scope || snapshot.generation !== mine) {
			incomplete.set(true);
			activity.set("failed");
			goods.delete(scope);
			shown = "";
			view.set({ state: "unavailable", reason: scopeReason("invalid"), snapshot: null });
			return;
		}
		const kept = goods.get(scope)?.snapshot;
		// Never recover a removed project's cards from another scope's cache.
		const present = new Set(snapshot.projects.map((p) => p.id));
		const refused = new Set(snapshot.projects.filter((p) => p.planningRead === "refused").map((p) => p.id));
		const freshPlanning = new Map(
			snapshot.projects
				.filter((p) => p.planning?.availability === "live")
				.map((p) => [p.id, JSON.stringify(p.planning?.plans)]),
		);
		for (const [key, cached] of goods) {
			if (
				cached.snapshot.projects.some(
					(p) =>
						(snapshot?.catalogComplete && !present.has(p.id)) ||
						(p.planning &&
							(refused.has(p.id) ||
								(freshPlanning.has(p.id) && freshPlanning.get(p.id) !== JSON.stringify(p.planning.plans)))),
				)
			)
				goods.delete(key);
		}
		if (kept) {
			snapshot = {
				...snapshot,
				projects: snapshot.projects.map((p) => {
					const earlier =
						p.selected &&
						(p.planningRead === "offline" || p.planningRead === "stale") &&
						kept.projects.find((k) => k.id === p.id)?.planning;
					return earlier ? { ...p, planning: { ...earlier, availability: "stale" } } : p;
				}),
			};
		}
		if (snapshot.partial) {
			// The other projects' rows of this scope's last good read stay until
			// the complete read replaces them, so nothing flickers to "reading".
			if (kept?.projects.every((p) => present.has(p.id)))
				snapshot = {
					...snapshot,
					outsideNeedsYou: kept.outsideNeedsYou,
					projects: snapshot.projects.map((p) =>
						p.currentness === "reading" ? (kept.projects.find((k) => k.id === p.id) ?? p) : p,
					),
				};
		}
		const key = JSON.stringify({ ...snapshot, generation: 0 });
		const retryPlanning = snapshot.projects.some(
			(p) =>
				p.selected && p.canOpenPlanning !== false && (p.planningRead === "offline" || p.planningRead === "stale"),
		);
		failures = retryPlanning ? failures + 1 : 0;
		// Only a complete read is kept as this scope's last good read.
		if (!snapshot.partial) remember(scope, { key, snapshot, at: Date.now() });
		const v = view();
		if (key !== shown || v.state !== "live" || v.reason !== "") {
			shown = key;
			view.set({ state: "live", reason: "", snapshot });
		}
		if (snapshot.catalogComplete) {
			const projects = snapshot.projects.map((p) => ({ id: p.id, name: p.name }));
			const names = JSON.stringify(projects);
			if (names !== listed) {
				listed = names;
				catalog.set(projects);
			}
		}
		// Continuous streaming must not starve starts/stops/task changes. A
		// read crossed by an event advances rows as earlier, never as live.
		activity.set(epoch === invalidated ? "live" : "stale");
		// The chosen project shows; now the complete read fills in the others.
		if (snapshot.partial && mine === newest) void read(scope);
		else if (retryPlanning)
			retry = setTimeout(() => {
				retry = null;
				if (!closed && wanted === scope && mine === newest) void read(scope);
			}, retryDelay(failures));
	};
	return {
		view,
		activity,
		incomplete,
		catalog,
		read,
		invalidate: () => {
			invalidated++;
			incomplete.set(true);
			if (activity() === "live") activity.set("stale");
		},
		close: () => {
			closed = true;
			stopRetry();
		},
	};
}
