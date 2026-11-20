// Where each place sits on the Wayfinder expedition chart, and the camera
// that looks at it. Pure and deterministic: the same records give the same
// chart. A place's spot comes from its stable id, so it keeps that spot as
// its state changes: answers ink new ground and fog lifts in place.
// Coordinates are chart points at zoom 1. Presentation only; reading the
// chart answers, approves and starts nothing.
import type { Exploration, FogArea, PlanPage } from "pilot-day/native";

export type Pt = { x: number; y: number };

/** The mark drawn for a place. */
export type GlyphKind =
	| "flag"
	| "flag-changed"
	| "signpost"
	| "signpost-ready"
	| "trig"
	| "tent"
	| "tent-done"
	| "flask"
	| "flask-run"
	| "gate"
	| "anchor"
	| "crate"
	| "fog";

/** One question on the chart. */
export type Place = { id: string; item: Exploration; at: Pt; glyph: GlyphKind };
/** One fog area, active or lifted. */
export type FogSpot = { id: string; fog: FogArea; at: Pt };
/**
 * What waits for what: a quadratic curve from start through control to end, between place ids
 * (a fog area is "fog:<id>"). A fan trail goes into a place that waits for more than
 * TRAILS_IN others: it is drawn only while either end is selected.
 */
export type Trail = {
	key: string;
	kind: "open" | "wait" | "fog";
	from: string;
	to: string;
	fan: boolean;
	s: Pt;
	c: Pt;
	e: Pt;
};

/** A place that waits for more than this many others draws no trails until it is selected. */
export const TRAILS_IN = 3;
/** A place's label next to its 32-point mark: two title lines and one state line, in screen points. */
export const LABEL = { w: 196, h: 60 };
/** A settled place's island: its puff radius and its outer contour ring, in chart points. */
export const ISLAND = { r: 28, pad: 20 };
/** How far an island reaches from its place, contour rings included (see puffs). */
export const ISLAND_REACH = { x: ISLAND.r * 1.58 + ISLAND.pad, y: ISLAND.r * 1.39 + ISLAND.pad };
/** Where a planning round happened: the home port, the mission's region or the destination. */
export type Harbor = "home" | "region" | "dest";
/** One planning round, a camp on the route. */
export type Camp = { n: number; harbor: Harbor; title: string; line: string };
/** One leg of Pilot's route between harbors. Only the latest legs are strong. */
export type Leg = { pts: Pt[]; strong: boolean; latest: boolean };

/** The whole chart of one mission: one region (D68), its home port and destination. */
export type Chart = {
	width: number;
	height: number;
	region: { x: number; y: number; w: number; h: number };
	lane: number;
	home: Pt;
	harbor: Pt;
	dest: Pt;
	/** The top right corner of the destination's words. */
	destBox: Pt;
	places: Place[];
	fogs: FogSpot[];
	trails: Trail[];
	camps: Camp[];
	legs: Leg[];
	/** Rounds spent in the region, shown on its harbor. */
	regionRounds: number;
	/** Where Pilot is: the harbor of the latest round. */
	here: Harbor;
	/** The place that needs you, or null when nothing does. */
	target: string | null;
};

// The grid: three columns of four rows per sheet, wide enough for a label
// at the zoom the chart opens at, and tall enough that a label never meets
// the island of the row below. A mission with more questions grows downward
// by whole sheets, so no place moves.
const COLS = 3;
const ROWS = 4;
const SHEET = COLS * ROWS;
const DX = 260;
const DY = 116;
const RX = 150;
const RY = 28;
const GX = RX + 48;
const GY = RY + 96;
const FOG_COLS = 3;
const FX = RX + 130;
const FDX = 240;
const FDY = 120;
const REGION_W = (COLS - 1) * DX + 238;

/** FNV-1a, so a place's spot depends only on its id. */
export function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/**
 * Gives each id a slot: the one its hash names in the first sheet with room,
 * or the next free one there. Ids go in the map's order, so a later place
 * never takes the spot of an earlier one.
 */
export function slots(ids: string[], sheet: number): Map<string, number> {
	const taken = new Set<number>();
	const out = new Map<string, number>();
	for (const id of ids) {
		if (out.has(id)) continue;
		const start = hash(id) % sheet;
		for (let base = 0; ; base += sheet) {
			let found = -1;
			for (let k = 0; k < sheet; k++) {
				const i = base + ((start + k) % sheet);
				if (!taken.has(i)) {
					found = i;
					break;
				}
			}
			if (found >= 0) {
				taken.add(found);
				out.set(id, found);
				break;
			}
		}
	}
	return out;
}

/** A few overlapping circles around a point: drawn together, one irregular island or cloud. */
export function puffs(key: string, x: number, y: number, r: number, n: number): [number, number, number][] {
	let h = hash(key) || 1;
	const rnd = () => {
		h ^= h << 13;
		h ^= h >>> 17;
		h ^= h << 5;
		return ((h >>> 0) % 1000) / 1000;
	};
	const out: [number, number, number][] = [[x, y, r]];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2 + rnd() * 1.1;
		const d = r * (0.55 + rnd() * 0.35);
		out.push([x + Math.cos(a) * d, y + Math.sin(a) * d * 0.78, r * (0.42 + rnd() * 0.26)]);
	}
	return out;
}

/** The mark of a question, from its kind and state. */
export function glyphOf(e: Exploration): GlyphKind {
	if (e.state === "resolved") return e.changed.length > 0 ? "flag-changed" : "flag";
	if (e.state === "asking") return "signpost";
	if (e.state === "waiting") return "gate";
	if (e.kind === "grilling") return "signpost-ready";
	if (e.kind === "research") return e.state === "running" ? (e.findingsWaiting ? "tent-done" : "tent") : "trig";
	return e.state === "running" ? "flask-run" : "flask";
}

function curve(a: Pt, b: Pt, s0: number, s1: number, k: number): Pick<Trail, "s" | "c" | "e"> {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy) || 1;
	const ux = dx / len;
	const uy = dy / len;
	const s = { x: a.x + ux * s0, y: a.y + uy * s0 };
	const e = { x: b.x - ux * s1, y: b.y - uy * s1 };
	const bend = (k % 2 ? 1 : -1) * Math.min(48, len * 0.14);
	return { s, c: { x: (s.x + e.x) / 2 - uy * bend, y: (s.y + e.y) / 2 + ux * bend }, e };
}

/** The route between two harbors: down to the channel, along it, and up to the other one. */
function legPts(a: Pt, b: Pt, lane: number): Pt[] {
	if (Math.abs(a.x - b.x) < 1) return [a, b];
	return [a, { x: a.x, y: lane }, { x: b.x, y: lane }, b];
}

function stageLine(page: PlanPage): string {
	switch (page.stage) {
		case "review":
			return "Plan ready for your review";
		case "approved":
			return "Approved, not published";
		case "published":
			return "Published. No work started.";
		default:
			return "Pilot is planning";
	}
}

/** The chart of one mission. */
export function chartOf(page: PlanPage): Chart {
	const items = page.explorations;
	const spot = slots(
		items.map((e) => e.id),
		SHEET,
	);
	let used = 0;
	for (const i of spot.values()) used = Math.max(used, i + 1);
	const rows = Math.max(1, Math.ceil(used / SHEET)) * ROWS;
	const places: Place[] = items.map((item) => {
		const i = spot.get(item.id) ?? 0;
		const sheet = Math.floor(i / SHEET);
		const local = i % SHEET;
		const h = hash(`${item.id}#at`);
		return {
			id: item.id,
			item,
			glyph: glyphOf(item),
			at: {
				x: GX + (local % COLS) * DX + ((h % 17) - 8),
				y: GY + (sheet * ROWS + Math.floor(local / COLS)) * DY + (((h >>> 8) % 11) - 5),
			},
		};
	});
	const gridBottom = GY + (rows - 1) * DY;
	const fogSpot = slots(
		page.fog.map((f) => f.id),
		FOG_COLS,
	);
	let fogUsed = 0;
	for (const i of fogSpot.values()) fogUsed = Math.max(fogUsed, i + 1);
	const fogRows = Math.ceil(fogUsed / FOG_COLS);
	const fy = gridBottom + 120;
	const fogs: FogSpot[] = page.fog.map((fog) => {
		const i = fogSpot.get(fog.id) ?? 0;
		return { id: fog.id, fog, at: { x: FX + (i % FOG_COLS) * FDX, y: fy + Math.floor(i / FOG_COLS) * FDY } };
	});
	const regionBottom = fogRows > 0 ? fy + (fogRows - 1) * FDY + 66 : gridBottom + 62;
	const lane = regionBottom + 56;
	const home = { x: 84, y: lane };
	const harbor = { x: RX + REGION_W / 2, y: regionBottom };
	const dest = { x: RX + REGION_W + 120, y: lane };
	const width = dest.x + 170;

	// Trails name the titles they wait for; a title that is not on the map draws nothing.
	const byTitle = new Map<string, Place>();
	for (const p of places) if (!byTitle.has(p.item.title)) byTitle.set(p.item.title, p);
	const trails: Trail[] = [];
	for (const p of places) {
		const fan = p.item.after.length > TRAILS_IN;
		for (const title of p.item.after) {
			const a = byTitle.get(title);
			if (!a || a.id === p.id) continue;
			const key = `${a.id}>${p.id}`;
			trails.push({
				key,
				kind: a.item.state === "resolved" ? "open" : "wait",
				from: a.id,
				to: p.id,
				fan,
				...curve(a.at, p.at, 16, 18, hash(key)),
			});
		}
	}
	for (const f of fogs) {
		if (!f.fog.active) continue;
		const fan = f.fog.after.length > TRAILS_IN;
		for (const title of f.fog.after) {
			const a = byTitle.get(title);
			if (!a) continue;
			const key = `${a.id}>fog:${f.id}`;
			trails.push({ key, kind: "fog", from: a.id, to: `fog:${f.id}`, fan, ...curve(a.at, f.at, 16, 52, hash(key)) });
		}
	}

	// Planning rounds: the brief at home, each interview round in the region,
	// and the proposed plan at the destination.
	const camps: Camp[] = [{ n: 1, harbor: "home", title: "You set out", line: page.goal || "Your brief" }];
	for (const r of page.rounds) camps.push({ n: camps.length + 1, harbor: "region", title: r.title, line: r.line });
	const iv = page.interview;
	if (iv && iv.kind !== "review" && !page.rounds.some((r) => r.title === `Round ${iv.round}`))
		camps.push({
			n: camps.length + 1,
			harbor: "region",
			title: `Round ${iv.round}`,
			line:
				iv.submit === "submitted"
					? "Submitted. Pilot plans from your answers."
					: iv.kind === "topic"
						? `Questions about “${iv.topic}”`
						: "Questions for you",
		});
	if (page.proposal || page.stage === "review" || page.stage === "approved" || page.stage === "published")
		camps.push({ n: camps.length + 1, harbor: "dest", title: "Pilot proposed a plan", line: stageLine(page) });
	const at = (h: Harbor) => (h === "home" ? home : h === "dest" ? dest : harbor);
	const stays: Harbor[] = [];
	for (const c of camps) if (stays[stays.length - 1] !== c.harbor) stays.push(c.harbor);
	const legs: Leg[] = [];
	for (let i = 1; i < stays.length; i++)
		legs.push({ pts: legPts(at(stays[i - 1]), at(stays[i]), lane), strong: false, latest: false });
	legs.forEach((l, i) => {
		l.strong = i >= legs.length - 3;
		l.latest = i === legs.length - 1;
	});
	const asking = items.find((e) => e.state === "asking");
	return {
		width,
		height: lane + 150,
		region: { x: RX, y: RY, w: REGION_W, h: regionBottom - RY },
		lane,
		home,
		harbor,
		dest,
		destBox: { x: width - 24, y: RY + 52 },
		places,
		fogs,
		trails,
		camps,
		legs,
		regionRounds: camps.filter((c) => c.harbor === "region").length,
		here: camps[camps.length - 1].harbor,
		target: asking ? asking.id : page.stage === "review" ? "dest" : null,
	};
}

/** What a chart shows that can change while it is open: settled places, fog and planning rounds. */
export type Snapshot = {
	places: string[];
	settled: string[];
	/** Every fog area, active or lifted. */
	fogs: string[];
	/** The active ones. */
	fog: string[];
	camps: number;
	legs: number;
};

export function snapshotOf(chart: Chart): Snapshot {
	return {
		places: chart.places.map((p) => p.id),
		settled: chart.places.filter((p) => p.item.state === "resolved").map((p) => p.id),
		fogs: chart.fogs.map((f) => f.id),
		fog: chart.fogs.filter((f) => f.fog.active).map((f) => f.id),
		camps: chart.camps.length,
		legs: chart.legs.length,
	};
}

/** What changed between two looks at one chart, each to be shown once. */
export type Changes = {
	/** Places that were open and are settled now: their ground is inked. */
	ink: string[];
	/** Fog areas that were active and are lifted now. */
	lift: string[];
	/** The number of the new planning round, or null. */
	camp: number | null;
	/** The index of the route's new leg, or null when the new round stayed in the same harbor. */
	leg: number | null;
};

/** What changed since `prev`. The first look (`prev` null) changes nothing: opening a chart plays nothing. */
export function changesOf(prev: Snapshot | null, next: Snapshot): Changes {
	if (!prev) return { ink: [], lift: [], camp: null, leg: null };
	const was = new Set(prev.places);
	const settled = new Set(prev.settled);
	const fog = new Set(next.fog);
	const kept = new Set(next.fogs);
	return {
		ink: next.settled.filter((id) => was.has(id) && !settled.has(id)),
		lift: prev.fog.filter((id) => kept.has(id) && !fog.has(id)),
		camp: next.camps > prev.camps ? next.camps : null,
		leg: next.camps > prev.camps && next.legs > prev.legs ? next.legs - 1 : null,
	};
}

/** Where a place id sits: a question, "fog:<id>", "home", "dest" or "harbor". */
export function pointOf(chart: Chart, id: string): Pt | null {
	if (id === "home") return chart.home;
	if (id === "dest") return chart.dest;
	if (id === "harbor") return chart.harbor;
	if (id.startsWith("fog:")) return chart.fogs.find((f) => f.id === id.slice(4))?.at ?? null;
	return chart.places.find((p) => p.id === id)?.at ?? null;
}

/** The camera: screen point = chart point × s + t. */
export type Cam = { s: number; tx: number; ty: number };
/** The chart's frame on screen, in points. */
export type Frame = { w: number; h: number };

/** The most a chart zooms in. */
export const MAX_ZOOM = 2.4;
/** Below this zoom, labels at full size would crowd each other. */
const READABLE = 0.72;

/** The zoom the chart opens at in a frame `width` wide: as large as fits, but readable. */
function startZoom(chart: Chart, width: number): number {
	return Math.min(1.15, Math.max(READABLE, width / chart.width));
}

/** The zoom at which the whole chart fits the frame. */
export function fitZoom(chart: Chart, frame: Frame): number {
	return Math.min(frame.w / chart.width, frame.h / chart.height);
}

/** The whole chart: centred where it fits, from its start where it does not. */
export function homeCam(chart: Chart, frame: Frame): Cam {
	const s = startZoom(chart, frame.w);
	const w = chart.width * s;
	const h = chart.height * s;
	return { s, tx: w <= frame.w ? (frame.w - w) / 2 : 0, ty: h <= frame.h ? (frame.h - h) / 2 : 0 };
}

/** How tall the still chart on the planning page is at `width`: the whole chart, no larger than 1.15. */
export function fitHeight(chart: Chart, width: number): number {
	return Math.round(chart.height * Math.min(1.15, width / chart.width));
}

/** The whole chart fitted and centred in `frame`: the still chart on the planning page. */
export function fitCam(chart: Chart, frame: Frame): Cam {
	const s = Math.min(1.15, fitZoom(chart, frame));
	return { s, tx: (frame.w - chart.width * s) / 2, ty: (frame.h - chart.height * s) / 2 };
}

/** The zoom limits in `frame`. */
export function zoomLimits(chart: Chart, frame: Frame): { min: number; max: number } {
	return { min: Math.min(fitZoom(chart, frame), startZoom(chart, frame.w)) * 0.85, max: MAX_ZOOM };
}

/** The zoom at which labels show: the small chart reads whole, so they show from the start. */
export function labelZoom(chart: Chart, frame: Frame): number {
	return Math.min(fitZoom(chart, frame), startZoom(chart, frame.w)) * 0.95;
}

/** Keeps part of the chart in view. */
export function clampCam(c: Cam, chart: Chart, frame: Frame): Cam {
	const { min, max } = zoomLimits(chart, frame);
	const s = Math.min(max, Math.max(min, c.s));
	const lim = (t: number, view: number, size: number) => {
		const slack = view * 0.3;
		const mid = (view - size) / 2;
		return Math.min(Math.max(slack, mid), Math.max(Math.min(view - size - slack, mid), t));
	};
	return { s, tx: lim(c.tx, frame.w, chart.width * s), ty: lim(c.ty, frame.h, chart.height * s) };
}

/** Zooms by `k` around the frame point (px, py), which stays where it is. */
export function zoomAt(c: Cam, k: number, px: number, py: number, chart: Chart, frame: Frame): Cam {
	const { min, max } = zoomLimits(chart, frame);
	const s = Math.min(max, Math.max(min, c.s * k));
	const r = s / c.s;
	return clampCam({ s, tx: px - (px - c.tx) * r, ty: py - (py - c.ty) * r }, chart, frame);
}

/** Whether two cameras are the same, to the half point. */
export function sameCam(a: Cam, b: Cam): boolean {
	return Math.abs(a.s - b.s) < 1e-3 && Math.abs(a.tx - b.tx) < 0.5 && Math.abs(a.ty - b.ty) < 0.5;
}
