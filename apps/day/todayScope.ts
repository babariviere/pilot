// Today's project scope: which projects Today shows, per window, and the
// passive cross-project read behind it (`day.today.scope`). The choice is
// the window's own, saved with its other screen state. Changing it reads
// only: it moves no draft, starts or sends nothing and never retargets a
// chat. Rows of other projects are read only here (`canAct` is false).
// What Pilot could not read stays unknown, never zero or empty.
import { type Signal, signal } from "nsh";
import type { Planning, Today } from "pilot-day/native";
import { call, type Refusal } from "./bridge";

/** The window's Today scope: "all" for All projects, else one project's ID. */
export const todayProject = signal<string>("all");

/** A count Pilot may not know. Null with complete false is unknown, never zero. */
export type ScopeCount = { count: number | null; complete: boolean };

/** One project in a scope read. Only selected projects carry their sections. */
export type ScopeProject = {
	id: string;
	name: string;
	selected: boolean;
	currentness: "live" | "stale" | "unavailable";
	observedAt: string;
	needsYou: ScopeCount;
	today: Today | null;
	planning: Planning | null;
	/** Why a section of this project could not be read, by section. */
	errors: Record<string, string>;
};

/** One scope read, as the root answered it. */
export type ScopeSnapshot = {
	scope: string;
	generation: number;
	/** Whether the project list itself is complete. */
	catalogComplete: boolean;
	/** Whether every selected project's sections were read. */
	complete: boolean;
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
	/** Reads `scope` with `generation`. Passive: it sends, starts and moves nothing. */
	read(scope: string, generation: number): Promise<{ ok: true; snapshot: unknown } | { ok: false; refusal: Refusal }>;
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
			(currentness !== "live" && currentness !== "stale" && currentness !== "unavailable") ||
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
			errors,
		});
	}
	return {
		scope: s.scope,
		generation: s.generation,
		catalogComplete: s.catalogComplete,
		complete: s.complete,
		projects,
		outsideNeedsYou: outside,
	};
}

/** The connected window's scope source: its root's `day.today.scope`. */
export class ConnectedScope implements ScopeSource {
	#window: string;
	constructor(window: string) {
		this.#window = window;
	}
	async read(scope: string, generation: number) {
		const r = await call<unknown>(this.#window, "day.today.scope", { scope, generation });
		return r.ok ? { ok: true as const, snapshot: r.snapshot } : { ok: false as const, refusal: r.refusal };
	}
}

/** Today's scope reads, mirrored in one signal. Only the newest read counts. */
export type ScopeMirror = {
	view: Signal<ScopeView>;
	/** The projects the last complete project list named, kept across scope changes. */
	catalog: Signal<{ id: string; name: string }[]>;
	/** Reads `scope` again. Passive; an older answer never replaces a newer one. */
	read: (scope: string) => Promise<void>;
};

// Generations increase on every read, also across a reload of the screens:
// the root rejects an older one.
let generation = Date.now();

/** Mirrors `source` for one window. */
export function mirrorScope(source: ScopeSource): ScopeMirror {
	const view = signal<ScopeView>({ state: "reading", reason: "", snapshot: null });
	const catalog = signal<{ id: string; name: string }[]>([]);
	let newest = 0;
	const read = async (scope: string) => {
		const mine = ++generation;
		newest = mine;
		// Another scope's rows never show while this one is read.
		if (view().snapshot?.scope !== scope) view.set({ state: "reading", reason: "", snapshot: null });
		const r = await source.read(scope, mine);
		// A newer read was asked for: this answer means nothing now.
		if (mine !== newest) return;
		if (!r.ok) {
			const earlier = view().snapshot;
			// An earlier read of the same scope stays, said to be earlier. Another scope's never shows.
			const keep = earlier && earlier.scope === scope ? earlier : null;
			view.set({
				state: keep ? "live" : "unavailable",
				reason: keep ? `${scopeReason(r.refusal)} What shows is Pilot's last read.` : scopeReason(r.refusal),
				snapshot: keep,
			});
			return;
		}
		const snapshot = scopeOf(r.snapshot);
		if (!snapshot || snapshot.scope !== scope || snapshot.generation !== mine) {
			view.set({ state: "unavailable", reason: scopeReason("invalid"), snapshot: null });
			return;
		}
		view.set({ state: "live", reason: "", snapshot });
		if (snapshot.catalogComplete) catalog.set(snapshot.projects.map((p) => ({ id: p.id, name: p.name })));
	};
	return { view, catalog, read };
}
