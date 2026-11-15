// The Wayfinder map drawn as an expedition chart. Settled questions are
// inked islands, open questions sit on blank ground with a mark for their
// kind, trails show what waits for what, fog of war is drawn as fog, and
// Pilot's route runs between the harbors of its planning rounds. The compass
// points at what needs you. Places keep their spot (chartLayout.ts).
//
// Drawing: one Canvas draws the land, fog, trails and route in chart points
// under an animated transform; places are native views moved by the same
// animated values, so they keep their screen size while the land zooms.
// Drags, wheel and zoom only set those values: nothing is laid out or drawn
// again in TSX until the records change. Nothing moves by itself.
// Reading the chart answers, approves and starts nothing.
import {
	type AnimatedNode,
	type AnimatedValue,
	Canvas,
	type CanvasRenderingContext2D,
	cleanup,
	computed,
	createAnimatedValue,
	effect,
	keymap,
	Path2D,
	reduceMotion,
	Scroll,
	type Signal,
	signal,
	Text,
	type TransformStep,
	token,
	untracked,
	View,
	type ViewProps,
	type ViewRef,
	windowSize,
} from "nsh";
import { Button } from "nsh/base";
import type { Exploration, ExploreKind, PlanPage } from "pilot-day/native";
import {
	type Cam,
	type Chart,
	changesOf,
	chartOf,
	clampCam,
	type Frame,
	fitCam,
	fitHeight,
	type GlyphKind,
	homeCam,
	ISLAND,
	labelZoom,
	type Pt,
	pointOf,
	puffs,
	type Snapshot,
	sameCam,
	snapshotOf,
	TRAILS_IN,
	zoomAt,
	zoomLimits,
} from "./chartLayout";
import { Agreement, exploreLine, FogRecord, ItemRecord, itemWord } from "./MapRecords";
import type { Plans } from "./planning";
import { Action, Icon, SectionTitle } from "./ui";

/** The keystroke that opens the chart full window, and closes it again. */
export const OPEN_CHART = "mod+shift+m";

/** What the chart and the lists below it share: the place whose field notes are open. */
export type ChartState = {
	/** A question id, "fog:<id>", "home", "harbor" or "dest"; null when no field notes are open. */
	selected: Signal<string | null>;
	/** The chart's frame, so a list row can bring it into view. */
	frame: { ref?: ViewRef };
};

/** View state of one mission's chart. Selecting reads nothing and sends nothing. */
export function chartState(): ChartState {
	return { selected: signal<string | null>(null), frame: {} };
}

// ---------- colours: theme tokens only ----------

type Ink = {
	paper: string;
	ink: string;
	faint: string;
	land: string;
	hatch: string;
	contour: string;
	fog: string;
	route: string;
	needs: string;
	needsSoft: string;
	progress: string;
	primary: string;
};

/** The chart's colours in the appearance shown. Reading them in a draw redraws on an appearance change. */
function inks(): Ink {
	return {
		paper: token("map-paper"),
		ink: token("map-ink"),
		faint: token("map-faint"),
		land: token("map-land"),
		hatch: token("map-hatch"),
		contour: token("map-contour"),
		fog: token("map-fog"),
		route: token("map-route"),
		needs: token("needs"),
		needsSoft: token("needs-soft"),
		progress: token("progress"),
		primary: token("primary"),
	};
}

// ---------- glyphs: drawn on a 24-point grid, the prototype's marks ----------

type Paths = Record<string, Path2D>;
let glyphPaths: Paths | null = null;

function paths(): Paths {
	if (glyphPaths) return glyphPaths;
	const dot = new Path2D();
	dot.arc(12, 14, 1.8, 0, Math.PI * 2);
	const ring = new Path2D();
	ring.arc(12, 5, 2, 0, Math.PI * 2);
	const crate = new Path2D();
	crate.roundRect(4, 6, 16, 13, 1.2);
	glyphPaths = {
		pole: new Path2D("M7 21V3.5"),
		flag: new Path2D("M7.6 4h10.6l-2.9 3.7 2.9 3.7H7.6Z"),
		post: new Path2D("M12 21.5V3"),
		boardRight: new Path2D("M12.6 4.5h6.4l2.4 2.6-2.4 2.6h-6.4Z"),
		boardLeft: new Path2D("M11.4 11.5H5l-2.4 2.6L5 16.7h6.4Z"),
		trig: new Path2D("M12 3.5 20.5 19.5h-17Z"),
		dot,
		tent: new Path2D("M12 6.5 3 20h18Z"),
		tentDoor: new Path2D("M12 12.5 9.8 20h4.4Z"),
		tentFlag: new Path2D("M12 6.5V2.5l3.4 1.3L12 5.1"),
		flaskFill: new Path2D("M7.2 15h9.6l1.9 3.4a1.3 1.3 0 0 1-1.2 1.9H6.5a1.3 1.3 0 0 1-1.2-1.9Z"),
		flask: new Path2D(
			"M9.3 3.5h5.4M10.4 3.5v5.2L5.3 18.4a1.3 1.3 0 0 0 1.2 1.9h11a1.3 1.3 0 0 0 1.2-1.9L13.6 8.7V3.5",
		),
		gate: new Path2D("M5 5v15M19 5v15M5 9.5h14M5 14.5h14"),
		ring,
		anchor: new Path2D(
			"M12 7v13.5M8 10.5h8M4.5 14a7.5 7 0 0 0 15 0M4.5 14l-1.3 1.8M4.5 14l2 .9M19.5 14l1.3 1.8M19.5 14l-2 .9",
		),
		crate,
		crateX: new Path2D("M4 6l16 13M20 6 4 19"),
		cloud: new Path2D("M6 17.5h11a3.6 3.6 0 0 0 .4-7.2A5 5 0 0 0 7.8 9.4 4.1 4.1 0 0 0 6 17.5Z"),
		mountain: new Path2D("M-52 10 -20 -32 -6 -15 12 -44 52 10Z"),
		scree: new Path2D("M16 -36 24 -18M21 -28 33 -6M27 -16 39 4M-17 -26 -12 -12M-14 -20 -6 -2"),
		summitPole: new Path2D("M12 -44V-70"),
		summitFlag: new Path2D("M12.6 -70h19l-5 6 5 6h-19Z"),
		serpent: new Path2D("M-6 3q2 4 6 5q5-11 10 0q5-11 10 0q5-11 10 0"),
		serpentEye: new Path2D("M36.6 4.2q1.7 1.6 3.4 0"),
		rose: new Path2D("M0 -40 4.5 -4.5 40 0 4.5 4.5 0 40 -4.5 4.5 -40 0 -4.5 -4.5Z"),
		needleNorth: new Path2D("M0 -4.6 36 0 0 4.6Z"),
		needleSouth: new Path2D("M0 -4.6 -36 0 0 4.6Z"),
	};
	return glyphPaths;
}

function stroke(
	cx: CanvasRenderingContext2D,
	p: Path2D,
	color: string,
	width: number | AnimatedNode,
	alpha: number | AnimatedNode = 1,
) {
	cx.globalAlpha = alpha;
	cx.strokeStyle = color;
	cx.lineWidth = width;
	cx.stroke(p);
	cx.globalAlpha = 1;
}

function fill(cx: CanvasRenderingContext2D, p: Path2D, color: string, alpha: number | AnimatedNode = 1) {
	cx.globalAlpha = alpha;
	cx.fillStyle = color;
	cx.fill(p);
	cx.globalAlpha = 1;
}

function circle(x: number, y: number, r: number): Path2D {
	const p = new Path2D();
	p.arc(x, y, r, 0, Math.PI * 2);
	return p;
}

/** One mark on its 24-point grid. */
function drawMark(cx: CanvasRenderingContext2D, k: GlyphKind, c: Ink) {
	const g = paths();
	cx.lineCap = "round";
	cx.lineJoin = "round";
	switch (k) {
		case "flag":
		case "flag-changed":
			stroke(cx, g.pole, c.ink, 1.8);
			fill(cx, g.flag, k === "flag" ? c.ink : c.needs);
			return;
		case "signpost":
		case "signpost-ready":
			stroke(cx, g.post, c.ink, 1.7);
			for (const b of [g.boardRight, g.boardLeft]) {
				if (k === "signpost") fill(cx, b, c.needs);
				stroke(cx, b, c.ink, 1.3);
			}
			return;
		case "trig":
			stroke(cx, g.trig, c.ink, 1.6);
			fill(cx, g.dot, c.ink);
			return;
		case "tent":
			fill(cx, g.tent, c.progress, 0.22);
			stroke(cx, g.tent, c.progress, 1.6);
			fill(cx, g.tentDoor, c.progress);
			stroke(cx, g.tentFlag, c.progress, 1.4);
			return;
		case "tent-done":
			// The research chat finished: its findings wait for Pilot. Calm ink, not the working blue.
			fill(cx, g.tent, c.ink, 0.1);
			stroke(cx, g.tent, c.ink, 1.6);
			fill(cx, g.tentDoor, c.ink);
			stroke(cx, g.tentFlag, c.ink, 1.4);
			return;
		case "flask":
		case "flask-run":
			if (k === "flask-run") fill(cx, g.flaskFill, c.progress);
			stroke(cx, g.flask, k === "flask-run" ? c.progress : c.ink, 1.6);
			return;
		case "gate":
			stroke(cx, g.gate, c.faint, 1.7);
			return;
		case "anchor":
			stroke(cx, g.ring, c.ink, 1.6);
			stroke(cx, g.anchor, c.ink, 1.6);
			return;
		case "crate":
			stroke(cx, g.crate, c.ink, 1.5);
			stroke(cx, g.crateX, c.ink, 1.1, 0.6);
			return;
		case "fog":
			fill(cx, g.cloud, c.fog);
			stroke(cx, g.cloud, c.faint, 1.4);
			return;
	}
}

/** How a mark's disc looks: settled land, needs you, at work, waiting or plain. */
export type Tone = "done" | "needs" | "run" | "wait" | "plain" | "fog";

/** A place's mark in its disc, 32 points square. Screen readers skip it; the label says what it is. */
export function Glyph(props: { kind: GlyphKind; tone: Tone; selected?: boolean }) {
	return (
		<Canvas
			accessible={false}
			accessibilityElementsHidden
			style={{ width: 32, height: 32 }}
			draw={(cx) => {
				const c = inks();
				if (props.tone === "needs") stroke(cx, circle(16, 16, 13.5), c.needs, 5, 0.22);
				const disc = circle(16, 16, 11);
				fill(cx, disc, props.tone === "done" ? c.land : props.tone === "needs" ? c.needsSoft : c.paper);
				if (props.tone === "wait") cx.setLineDash([2, 2]);
				stroke(
					cx,
					disc,
					props.tone === "needs"
						? c.needs
						: props.tone === "run"
							? c.progress
							: props.tone === "fog"
								? c.faint
								: c.ink,
					1,
					props.tone === "needs" || props.tone === "run" ? 1 : 0.4,
				);
				cx.setLineDash([]);
				if (props.selected) stroke(cx, circle(16, 16, 14.5), c.primary, 2);
				cx.save();
				cx.translate(16 - 8.6, 16 - 8.6);
				cx.scale(17.2 / 24, 17.2 / 24);
				drawMark(cx, props.kind, c);
				cx.restore();
			}}
		/>
	);
}

function toneOf(e: Exploration): Tone {
	if (e.state === "resolved") return "done";
	if (e.state === "asking") return "needs";
	if (e.state === "running") return e.findingsWaiting ? "plain" : "run";
	if (e.state === "waiting") return "wait";
	return "plain";
}

// ---------- words ----------

function kindName(kind: ExploreKind): string {
	return kind === "grilling" ? "Interview" : kind === "research" ? "Research" : "Prototype";
}

function stateName(e: Exploration): string {
	switch (e.state) {
		case "resolved":
			return itemWord(e);
		case "asking":
			return "Needs you";
		case "running":
			return e.findingsWaiting ? "Findings ready" : "At work";
		case "ready":
			return "Ready";
		case "waiting":
			return "Waiting";
	}
}

/** How a settled question was settled, in a few words. */
function settledHow(page: PlanPage, e: Exploration): string {
	if (e.changed.length > 0) return "Its source changed";
	const round = e.round ? page.rounds.find((r) => r.id === e.round) : null;
	if (round) {
		const n = /round (\d+)/i.exec(round.title)?.[1];
		return n ? `Your answers, round ${n}` : "Your answers";
	}
	const src = e.sourceRefs[0];
	if (src?.kind === "knowledge") return /not checked/i.test(e.result) ? "Knowledge, not checked" : "Knowledge";
	if (src?.kind === "decision") return src.label.replace(/ \(.*\)$/, "");
	return "Settled";
}

/** A place's second line on the chart. */
export function placeLine(page: PlanPage, e: Exploration): string {
	switch (e.state) {
		case "resolved":
			return settledHow(page, e);
		case "asking":
			return "Needs your answers";
		case "running":
			if (e.findingsWaiting) return "Findings wait for Pilot";
			return e.kind === "prototype" ? "A prototype chat is working" : "A research chat is working";
		case "ready":
			return e.kind === "research"
				? "Ready for research"
				: e.kind === "prototype"
					? "Ready to make"
					: "Ready to ask";
		case "waiting":
			if (e.after.length > TRAILS_IN) return `Waits for ${e.after.length} questions`;
			return e.after.length > 0 ? `Waits for ${e.after.join(", ")}` : "Waiting";
	}
}

/** The region's counts, such as "1 needs you · 3 settled · 3 open · 1 waiting · 2 in fog". */
function regionCounts(page: PlanPage): { needs: number; rest: string } {
	const n = (states: Exploration["state"][]) => page.explorations.filter((e) => states.includes(e.state)).length;
	const fog = page.fog.filter((f) => f.active).length;
	return {
		needs: n(["asking"]),
		rest: [
			`${n(["resolved"])} settled`,
			`${n(["ready", "running"])} open`,
			n(["waiting"]) ? `${n(["waiting"])} waiting` : "",
			fog ? `${fog} in fog` : "",
		]
			.filter(Boolean)
			.join(" · "),
	};
}

function stageName(page: PlanPage): string {
	switch (page.stage) {
		case "questions":
			return "Questions for you";
		case "review":
			return "Plan ready for your review";
		case "approved":
			return "Approved, not published";
		case "published":
			return "Published";
		case "submitted":
			return "Submitted, waiting to continue";
		case "unknown":
			return "Not confirmed";
		default:
			return "Pilot is planning";
	}
}

// ---------- the land, fog, trails and route ----------

/** Union of many circles, grown by `pad`: one island layer. */
function circles(sets: [number, number, number][][], pad: number): Path2D {
	const p = new Path2D();
	for (const set of sets)
		for (const [x, y, r] of set) {
			p.moveTo(x + r + pad, y);
			p.arc(x, y, r + pad, 0, Math.PI * 2);
		}
	return p;
}

/** A polyline with rounded corners. */
function rounded(pts: Pt[], r: number): Path2D {
	const p = new Path2D();
	p.moveTo(pts[0].x, pts[0].y);
	for (let i = 1; i < pts.length - 1; i++) p.arcTo(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, r);
	p.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
	return p;
}

/** One change shown once on the chart: its progress runs from 0 to 1 on the UI thread. */
type Motion = { key: string; kind: "ink" | "lift" | "camp"; id: string; at: Pt; p: AnimatedValue; leg: number | null };

/** The changes playing now, by what they move. */
type Fx = {
	ink: Map<string, AnimatedNode>;
	lift: Map<string, AnimatedNode>;
	leg: { index: number; p: AnimatedNode } | null;
};

function fxOf(motions: Motion[]): Fx {
	const fx: Fx = { ink: new Map(), lift: new Map(), leg: null };
	for (const m of motions) {
		if (m.kind === "ink") fx.ink.set(m.id, m.p);
		else if (m.kind === "lift") fx.lift.set(m.id, m.p);
		else if (m.leg !== null) fx.leg = { index: m.leg, p: m.p };
	}
	return fx;
}

/** Runs `paint` with the drawing scaled by `k` around `at`. */
function around(cx: CanvasRenderingContext2D, at: Pt, k: AnimatedNode, paint: () => void) {
	cx.save();
	cx.translate(at.x, at.y);
	cx.scale(k, k);
	cx.translate(-at.x, -at.y);
	paint();
	cx.restore();
}

/**
 * Draws everything that zooms with the land, in chart points. `unit` is one
 * screen point, so lines keep their width while the land zooms. `fx` names
 * the changes playing now; each moves only through its animated progress,
 * so the drawing is recorded once and the platform plays it.
 */
function drawLand(
	cx: CanvasRenderingContext2D,
	chart: Chart,
	c: Ink,
	unit: AnimatedNode,
	fx: Fx,
	focus: string | null,
) {
	const g = paths();
	const w = (n: number) => unit.mul(n);
	cx.lineCap = "round";
	cx.lineJoin = "round";
	// A faint graticule and the region's dashed edge.
	const grid = new Path2D();
	for (let x = 100; x < chart.width; x += 100) {
		grid.moveTo(x, 0);
		grid.lineTo(x, chart.height);
	}
	for (let y = 100; y < chart.height; y += 100) {
		grid.moveTo(0, y);
		grid.lineTo(chart.width, y);
	}
	stroke(cx, grid, c.contour, w(0.6), 0.5);
	const R = chart.region;
	const region = new Path2D();
	region.roundRect(R.x, R.y, R.w, R.h, 22);
	cx.setLineDash([3, 5]);
	stroke(cx, region, c.ink, w(1.2), 0.3);
	// The channel from the home port to the destination.
	const lane = new Path2D();
	lane.moveTo(chart.home.x, chart.lane);
	lane.lineTo(chart.dest.x, chart.lane);
	cx.setLineDash([2, 7]);
	stroke(cx, lane, c.contour, w(1.2));
	cx.setLineDash([]);

	// Inked land: the home port and every settled question, with contour lines around them.
	// A question settled just now inks its ground once: it grows in from its centre. Each
	// layer of it follows the same layer of the other islands, so where they meet they join.
	const islands = [puffs("home", chart.home.x, chart.home.y, 34, 4)];
	const fresh: { at: Pt; pts: [number, number, number][]; p: AnimatedNode }[] = [];
	for (const p of chart.places) {
		if (p.item.state !== "resolved") continue;
		const pts = puffs(p.id, p.at.x, p.at.y, ISLAND.r, 4);
		const grow = fx.ink.get(p.id);
		if (grow) fresh.push({ at: p.at, pts, p: grow });
		else islands.push(pts);
	}
	const growth = (f: (typeof fresh)[number]) => f.p.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
	const layer = (pad: number, color: string) => {
		fill(cx, circles(islands, pad), color);
		for (const f of fresh) around(cx, f.at, growth(f), () => fill(cx, circles([f.pts], pad), color, f.p));
	};
	layer(ISLAND.pad, c.contour);
	layer(ISLAND.pad - 1.4, c.paper);
	layer(ISLAND.pad / 2, c.contour);
	layer(ISLAND.pad / 2 - 1.4, c.paper);
	layer(2.2, c.ink);
	const hatch = new Path2D();
	for (let d = -chart.height; d < chart.width; d += 6) {
		hatch.moveTo(d, chart.height);
		hatch.lineTo(d + chart.height, 0);
	}
	const land = circles(islands, 0);
	fill(cx, land, c.land);
	cx.save();
	cx.clip(land);
	stroke(cx, hatch, c.hatch, 1.3);
	cx.restore();
	for (const f of fresh)
		around(cx, f.at, growth(f), () => {
			const ground = circles([f.pts], 0);
			fill(cx, ground, c.land, f.p);
			cx.save();
			cx.clip(ground);
			stroke(cx, hatch, c.hatch, 1.3, f.p);
			cx.restore();
		});

	// Fog that lifted leaves a dashed ring where it was. Fog lifted just now fades and
	// drifts away once, while its ring comes in.
	cx.setLineDash([1.5, 6]);
	for (const f of chart.fogs)
		if (!f.fog.active) stroke(cx, circle(f.at.x, f.at.y, 40), c.faint, w(1.5), fx.lift.get(f.id) ?? 1);
	cx.setLineDash([]);
	for (const f of chart.fogs) {
		const q = fx.lift.get(f.id);
		if (!q || f.fog.active) continue;
		const cloud = [puffs(`fog-${f.id}`, f.at.x, f.at.y, 46, 7)];
		const fade = q.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
		cx.save();
		cx.translate(
			q.interpolate({ inputRange: [0, 1], outputRange: [0, 36] }),
			q.interpolate({ inputRange: [0, 1], outputRange: [0, -18] }),
		);
		around(cx, f.at, q.interpolate({ inputRange: [0, 1], outputRange: [1, 1.2] }), () => {
			fill(cx, circles(cloud, 1.6), c.faint, fade.mul(0.55));
			fill(cx, circles(cloud, 0), c.fog, fade);
		});
		cx.restore();
	}
	// Fog of war: soft clouds, stippled.
	let serpent: Pt | null = null;
	for (const f of chart.fogs) {
		if (!f.fog.active) continue;
		const cloud = [puffs(`fog-${f.id}`, f.at.x, f.at.y, 46, 7)];
		fill(cx, circles(cloud, 1.6), c.faint, 0.55);
		const body = circles(cloud, 0);
		fill(cx, body, c.fog);
		cx.save();
		cx.clip(body);
		const a = new Path2D();
		const b = new Path2D();
		for (let x = f.at.x - 80; x < f.at.x + 80; x += 10)
			for (let y = f.at.y - 60; y < f.at.y + 60; y += 10) {
				a.moveTo(x + 2.5 + 0.95, y + 2.5);
				a.arc(x + 2.5, y + 2.5, 0.95, 0, Math.PI * 2);
				b.moveTo(x + 7.5 + 0.75, y + 7.5);
				b.arc(x + 7.5, y + 7.5, 0.75, 0, Math.PI * 2);
			}
		fill(cx, a, c.faint, 0.45);
		fill(cx, b, c.faint, 0.35);
		cx.restore();
		serpent ??= { x: f.at.x - 24, y: f.at.y + 54 };
	}
	// A sea serpent, asleep: fog of war is not danger, and it blocks nothing.
	if (serpent) {
		cx.save();
		cx.translate(serpent.x, serpent.y);
		stroke(cx, g.serpent, c.ink, 1.7);
		const head = new Path2D();
		head.ellipse(36, 5, 6.6, 4.6, 0, 0, Math.PI * 2);
		fill(cx, head, c.fog);
		stroke(cx, head, c.ink, 1.5);
		stroke(cx, g.serpentEye, c.ink, 1.2);
		cx.fillStyle = c.faint;
		cx.font = "italic 600 12px serif";
		cx.fillText("z", 46, -3);
		cx.font = "italic 600 9px serif";
		cx.fillText("z", 53, -11);
		cx.restore();
	}

	// Trails: what waits for what. Dotted until the first is settled. A place that waits for
	// many shows its trails only while selected; a selected place's trails show strong and the
	// others step back.
	for (const t of chart.trails) {
		const mine = focus !== null && (t.from === focus || t.to === focus);
		if (t.fan && !mine) continue;
		const p = new Path2D();
		p.moveTo(t.s.x, t.s.y);
		p.quadraticCurveTo(t.c.x, t.c.y, t.e.x, t.e.y);
		const color = t.kind === "fog" ? c.faint : c.ink;
		const alpha = (t.kind === "open" ? 0.6 : 0.75) * (focus === null || mine ? 1 : 0.3);
		if (t.kind !== "open") cx.setLineDash([0.5, 6]);
		stroke(cx, p, color, w((t.kind === "open" ? 1.6 : 2.3) * (mine ? 1.3 : 1)), alpha);
		cx.setLineDash([]);
		const dx = t.e.x - t.c.x;
		const dy = t.e.y - t.c.y;
		const len = Math.hypot(dx, dy) || 1;
		const ux = dx / len;
		const uy = dy / len;
		const head = new Path2D();
		head.moveTo(t.e.x - ux * 6 - uy * 3.5, t.e.y - uy * 6 + ux * 3.5);
		head.lineTo(t.e.x, t.e.y);
		head.lineTo(t.e.x - ux * 6 + uy * 3.5, t.e.y - uy * 6 - ux * 3.5);
		stroke(cx, head, color, w(1.6), alpha);
	}

	// Pilot's route between harbors: older legs faint, the latest strong. A leg sailed
	// just now draws in once from its start.
	chart.legs.forEach((l, i) => {
		const p = rounded(l.pts, 10);
		const sail = fx.leg?.index === i ? fx.leg.p : null;
		if (sail) {
			let length = 20;
			for (let k = 1; k < l.pts.length; k++)
				length += Math.hypot(l.pts[k].x - l.pts[k - 1].x, l.pts[k].y - l.pts[k - 1].y);
			cx.setLineDash([length, length]);
			cx.lineDashOffset = sail.interpolate({ inputRange: [0, 1], outputRange: [length, 0] });
		}
		if (!l.strong) stroke(cx, p, c.route, w(1.6), 0.3);
		else stroke(cx, p, c.route, w(2.6), l.latest ? 0.95 : 0.4);
		if (sail) {
			cx.setLineDash([]);
			cx.lineDashOffset = 0;
		}
	});

	// The destination: a mountain with a flag on its summit.
	cx.save();
	cx.translate(chart.dest.x, chart.lane - 48);
	fill(cx, g.mountain, c.paper);
	stroke(cx, g.mountain, c.ink, 1.5);
	stroke(cx, g.scree, c.ink, 1, 0.5);
	stroke(cx, g.summitPole, c.ink, 1.6);
	fill(cx, g.summitFlag, c.route);
	cx.restore();
}

/** The compass: a rose and a needle turned by `angle` (radians). */
function drawCompass(cx: CanvasRenderingContext2D, c: Ink, angle: AnimatedNode) {
	const g = paths();
	cx.save();
	cx.translate(46, 46);
	cx.scale(0.92, 0.92);
	const rim = circle(0, 0, 46);
	fill(cx, rim, c.paper);
	stroke(cx, rim, c.ink, 1, 0.55);
	cx.setLineDash([1, 4]);
	cx.lineCap = "round";
	stroke(cx, circle(0, 0, 39), c.ink, 1, 0.35);
	cx.setLineDash([]);
	fill(cx, g.rose, c.contour, 0.7);
	cx.save();
	cx.rotate(angle);
	fill(cx, g.needleNorth, c.route);
	fill(cx, g.needleSouth, c.ink);
	cx.restore();
	const hub = circle(0, 0, 3.2);
	fill(cx, hub, c.paper);
	stroke(cx, hub, c.ink, 1.2);
	cx.restore();
}

// ---------- the chart ----------

/** Where the compass sits: the frame's bottom right corner, clear of the home port. */
const COMPASS = { right: 14, size: 92, below: 34 };

/** A label over the chart: a soft halo of paper keeps it readable over land and trails. */
function halo() {
	const paper = token("map-paper");
	return [
		{ x: 0, y: 0, blur: 2, color: paper },
		{ x: 0, y: 0, blur: 4, color: paper },
	];
}

/**
 * The expedition chart of one Wayfinder mission. On the planning page
 * ("inline") it is the whole chart, fitted and still: a scroll over it
 * scrolls the page. Full window ("full") a drag or scroll moves it, and
 * pinch, Command-scroll, the − and + buttons or keys zoom. In both, a click
 * on a place opens its field notes; Escape closes them first.
 */
export function ExpeditionChart(props: {
	plans: Plans;
	page: PlanPage;
	state: ChartState;
	mode: "inline" | "full";
	/** The full view's frame, in points. */
	frame?: Frame;
	/** Inline: opens the full view. It gets the button, to give it the focus again on return. */
	onOpenFull?: (button: ViewRef | undefined) => void;
	/** Full: leaves the full view. */
	onClose?: () => void;
	onOpenTasks?: () => void;
}) {
	// A chart keeps its mode for its life: the full view is its own chart.
	const full = untracked(() => props.mode === "full");
	const chart = computed(() => chartOf(props.page));
	// What the land layer draws, as one string: the canvas draws again only when it changes,
	// not when the planning agent's activity or a label changes.
	const land = computed(() => {
		const ch = chart();
		return JSON.stringify([
			ch.width,
			ch.height,
			ch.region,
			ch.places.map((p) => [p.id, p.at.x, p.at.y, p.item.state]),
			ch.fogs.map((f) => [f.id, f.fog.active]),
			ch.trails.map((t) => `${t.key}:${t.kind}`),
			ch.legs,
		]);
	});
	const width = computed(() =>
		full ? (props.frame?.w ?? 800) : Math.max(320, Math.min(windowSize().width - 48, 1120)),
	);
	const height = computed(() => (full ? (props.frame?.h ?? 600) : fitHeight(chart(), width())));
	/** The whole chart: fitted and still inline, readable and movable full window. */
	const homeOf = (ch: Chart, f: Frame) => (full ? homeCam(ch, f) : fitCam(ch, f));
	const frame = (): Frame => ({ w: width(), h: height() });
	const selected = props.state.selected;

	// The camera, as animated values the native side reads while it draws.
	// Idle, the translation lives in the values' offsets, so a drag moves
	// the values from 0 and the chart follows on the UI thread.
	const S: AnimatedValue = createAnimatedValue(1);
	const TX: AnimatedValue = createAnimatedValue(0);
	const TY: AnimatedValue = createAnimatedValue(0);
	const ANGLE: AnimatedValue = createAnimatedValue(0);
	// A trackpad pinch scales the land natively around its middle while the fingers move;
	// when they lift, the camera takes the zoom and this goes back to 1.
	const PINCH: AnimatedValue = createAnimatedValue(1);
	const unit = createAnimatedValue(1).div(S);
	const at: At = (x, y, dx = 0, dy = 0) => [
		{ translateX: S.mul(x).add(TX).add(dx) },
		{ translateY: S.mul(y).add(TY).add(dy) },
	];
	let cam: Cam = untracked(() => homeOf(chart(), frame()));
	let needle = 0;
	let motion = 0;
	const moved = signal(false);
	const atMin = signal(false);
	const atMax = signal(false);
	// Inline the labels always show; full window they fade out only when zoomed far out.
	const labelAlpha = computed((): number | AnimatedNode => {
		if (!full) return 1;
		const z = labelZoom(chart(), frame());
		return S.interpolate({ inputRange: [z * 0.94, z], outputRange: [0, 1] });
	});

	const needleTo = (c: Cam): number => {
		const ch = untracked(chart);
		const t = pointOf(ch, ch.target ?? "dest") ?? ch.dest;
		const x = untracked(width) - COMPASS.right - COMPASS.size / 2;
		const y = untracked(height) - COMPASS.below - COMPASS.size / 2;
		return Math.atan2(t.y * c.s + c.ty - y, t.x * c.s + c.tx - x);
	};
	const turn = (to: number, animate: boolean) => {
		let a = to;
		while (a - needle > Math.PI) a -= Math.PI * 2;
		while (needle - a > Math.PI) a += Math.PI * 2;
		if (Math.abs(a - needle) < 1e-4) return;
		needle = a;
		if (animate && !reduceMotion()) void ANGLE.timing(a, { duration: 600 });
		else ANGLE.set(a);
	};
	/** Shows camera `c`. Only the animated values change: no layout, no drawing in TSX. */
	const show = (c: Cam, animate = false, swing = animate) => {
		const ch = untracked(chart);
		const f = untracked(frame);
		cam = c;
		moved.set(!sameCam(c, homeOf(ch, f)));
		const lim = zoomLimits(ch, f);
		atMin.set(c.s <= lim.min + 1e-3);
		atMax.set(c.s >= lim.max - 1e-3);
		const run = ++motion;
		if (animate && !reduceMotion()) {
			TX.flattenOffset();
			TY.flattenOffset();
			void Promise.all([
				S.timing(c.s, { duration: 260 }),
				TX.timing(c.tx, { duration: 260 }),
				TY.timing(c.ty, { duration: 260 }),
			]).then(() => {
				if (run !== motion) return;
				TX.extractOffset();
				TY.extractOffset();
			});
		} else {
			S.set(c.s);
			TX.set(0);
			TX.setOffset(c.tx);
			TY.set(0);
			TY.setOffset(c.ty);
		}
		turn(needleTo(c), swing);
	};
	// A new frame, a bigger chart or a new target keep your view where they can; the whole
	// chart follows the frame. Other record changes leave the camera alone.
	const geometry = computed(() => {
		const ch = chart();
		return `${ch.width}x${ch.height} ${width()}x${height()} ${ch.target ?? "dest"}`;
	});
	let seen = "";
	effect(() => {
		geometry();
		untracked(() => {
			const ch = chart();
			const f = frame();
			const was = seen;
			seen = ch.target ?? "dest";
			show(moved() ? clampCam(cam, ch, f) : homeOf(ch, f), false, was !== "" && was !== seen);
		});
	});

	const home = () => show(homeOf(untracked(chart), untracked(frame)), true);
	const zoomBy = (k: number) => {
		const f = untracked(frame);
		show(zoomAt(cam, k, f.w / 2, f.h / 2, untracked(chart), f), true);
	};
	let openButton: ViewRef | undefined;
	if (full) {
		keymap.bind(
			{ minus: () => zoomBy(1 / 1.45), plus: () => zoomBy(1.45), "shift+plus": () => zoomBy(1.45) },
			{ when: "notEditing" },
		);
		keymap.bind(OPEN_CHART, () => props.onClose?.());
	} else keymap.bind(OPEN_CHART, () => props.onOpenFull?.(openButton));
	// Escape closes the field notes first. Then full window it leaves the full view;
	// inline the page has it.
	const holds = computed(() => full || selected() !== null);
	effect(() => {
		if (!holds()) return;
		cleanup(
			keymap.bind("escape", () => {
				if (selected() !== null) selected.set(null);
				else props.onClose?.();
			}),
		);
	});

	// Wheel: one camera change per frame, however many events arrive.
	let wheel = { dx: 0, dy: 0, zoom: 0, x: 0, y: 0 };
	let queued = false;
	const flush = () => {
		queued = false;
		const p = wheel;
		wheel = { dx: 0, dy: 0, zoom: 0, x: 0, y: 0 };
		const ch = untracked(chart);
		const f = untracked(frame);
		let c = cam;
		if (p.zoom !== 0) c = zoomAt(c, Math.exp(-Math.max(-60, Math.min(60, p.zoom)) * 0.01), p.x, p.y, ch, f);
		if (p.dx !== 0 || p.dy !== 0) c = clampCam({ s: c.s, tx: c.tx - p.dx, ty: c.ty - p.dy }, ch, f);
		if (!sameCam(c, cam)) show(c);
	};
	cleanup(() => {
		motion++;
	});

	const side = signal<"left" | "right">("right");
	const select = (id: string) => {
		if (selected() === id) {
			selected.set(null);
			return;
		}
		const p = pointOf(untracked(chart), id);
		side.set(p && p.x * cam.s + cam.tx > untracked(width) / 2 ? "left" : "right");
		selected.set(id);
	};
	// Data changes seen while this chart is open play once: an answer inks ground, fog lifts,
	// a new camp's leg draws in. The first look plays nothing, and neither do scrolls or camera
	// moves. With reduced motion the chart shows the end state at once. Each change animates
	// one progress value natively; it leaves the list when it ends, and nothing keeps running.
	const motions = signal<Motion[]>([]);
	let looked: Snapshot | null = null;
	effect(() => {
		const ch = chart();
		untracked(() => {
			const next = snapshotOf(ch);
			const change = changesOf(looked, next);
			looked = next;
			if (reduceMotion()) return;
			const add: Motion[] = [];
			const play = (kind: Motion["kind"], id: string, at: Pt | null, leg: number | null = null) => {
				if (at) add.push({ key: `${kind}:${id}`, kind, id, at, p: createAnimatedValue(0), leg });
			};
			for (const id of change.ink) play("ink", id, pointOf(ch, id));
			for (const id of change.lift) play("lift", id, pointOf(ch, `fog:${id}`));
			if (change.camp !== null) {
				const harbor = ch.camps[ch.camps.length - 1].harbor;
				play(
					"camp",
					String(change.camp),
					harbor === "region" ? ch.harbor : harbor === "home" ? ch.home : ch.dest,
					change.leg,
				);
			}
			if (add.length === 0) return;
			motions.update((list) => [...list.filter((m) => !add.some((a) => a.key === m.key)), ...add]);
			for (const m of add)
				void m.p.timing(1, { duration: m.kind === "camp" ? 900 : 1200 }).then(() => {
					motions.update((list) => list.filter((x) => x !== m));
				});
		});
	});

	// Only the full view moves: a drag pans, the wheel pans or zooms. The still chart has
	// no such listeners, so a scroll or drag over it reaches the page around it.
	const moves: Partial<ViewProps> = full
		? {
				pan: { x: TX, y: TY },
				onPanEnd: (e) => {
					const raw = { s: cam.s, tx: cam.tx + e.translation.x, ty: cam.ty + e.translation.y };
					TX.set(0);
					TX.setOffset(raw.tx);
					TY.set(0);
					TY.setOffset(raw.ty);
					cam = raw;
					const c = clampCam(raw, untracked(chart), untracked(frame));
					show(c, !sameCam(c, raw));
				},
				pinch: { scale: PINCH },
				onPinchEnd: (e) => {
					const f = untracked(frame);
					const c = zoomAt(cam, e.scale, f.w / 2, f.h / 2, untracked(chart), f);
					PINCH.set(1);
					show(c);
				},
				onWheel: (e) => {
					const k = e.deltaMode === "lines" ? 16 : 1;
					if (e.modifiers.control || e.modifiers.platform) {
						wheel.zoom += e.delta.y * k;
						wheel.x = e.position.x;
						wheel.y = e.position.y;
					} else {
						let dx = e.delta.x * k;
						let dy = e.delta.y * k;
						if (e.modifiers.shift && dx === 0) {
							dx = dy;
							dy = 0;
						}
						wheel.dx += dx;
						wheel.dy += dy;
					}
					if (!queued) {
						queued = true;
						requestAnimationFrame(flush);
					}
				},
			}
		: {};
	const counts = () => regionCounts(props.page);
	const target = () => {
		const id = chart().target;
		if (!id) return null;
		if (id === "dest") return { id, title: "Read the plan" };
		return { id, title: props.page.explorations.find((e) => e.id === id)?.title ?? "" };
	};

	return (
		<View
			testID={full ? "chart-full-frame" : "chart"}
			ref={(node) => {
				props.state.frame.ref = node;
			}}
			accessibilityLabel={
				full
					? "Expedition chart. Drag or scroll to look around; zoom with the buttons."
					: "Expedition chart. Every place on it is also listed below."
			}
			class="self-center overflow-hidden rounded-2xl border border-map-ink/20 bg-map-paper"
			style={{ width: width(), height: height() }}
		>
			<View class="absolute inset-0" style={full ? { transform: [{ scale: PINCH }] } : undefined} {...moves}>
				<Canvas
					accessible={false}
					accessibilityElementsHidden
					class="absolute inset-0"
					draw={(cx) => {
						const c = inks();
						land();
						const fx = fxOf(motions());
						// Selecting a place draws its trails strong, so the land draws again then.
						const focus = selected();
						const ch = untracked(chart);
						cx.save();
						cx.translate(TX, TY);
						cx.scale(S, S);
						drawLand(cx, ch, c, unit, fx, focus);
						cx.restore();
					}}
				/>
				<RegionLabel page={props.page} chart={chart()} at={at} counts={counts()} />
				<Each of={chart().places} key={(p) => p.id}>
					{(p) => (
						<PlaceMark
							testID={`place-${p().id}`}
							style={at(p().at.x, p().at.y, -16, -16)}
							kind={p().glyph}
							tone={toneOf(p().item)}
							title={p().item.title}
							line={placeLine(props.page, p().item)}
							lineTone={p().item.state === "asking" || p().item.changed.length > 0 ? "needs" : "faint"}
							faint={p().item.state === "waiting"}
							strong={p().item.state !== "resolved"}
							label={`${kindName(p().item.kind)}: ${p().item.title}. ${placeLine(props.page, p().item)}`}
							selected={selected() === p().id}
							labelAlpha={labelAlpha()}
							onPress={() => select(p().id)}
						/>
					)}
				</Each>
				<PlaceMark
					testID="place-home"
					style={at(chart().home.x, chart().home.y, -16, -16)}
					kind="anchor"
					tone="done"
					title="Home port"
					line="Your brief"
					lineTone="faint"
					strong
					label="Home port: your brief"
					selected={selected() === "home"}
					labelAlpha={labelAlpha()}
					onPress={() => select("home")}
				/>
				<Each of={chart().fogs} key={(f) => f.id}>
					{(f) => (
						<FogMark
							style={at(f().at.x, f().at.y, -95, f().fog.active ? -30 : -56)}
							chart={chart()}
							fog={f().fog}
							selected={selected() === `fog:${f().id}`}
							labelAlpha={labelAlpha()}
							onPress={() => select(`fog:${f().id}`)}
						/>
					)}
				</Each>
				<Each of={motions()} key={(m) => m.key}>
					{(m) => <MotionMark motion={m()} at={at} />}
				</Each>
				<Harbor chart={chart()} at={at} selected={selected()} onPress={select} />
				<HereLabel chart={chart()} at={at} />
				<Destination
					page={props.page}
					style={at(chart().destBox.x, chart().destBox.y, -200)}
					selected={selected() === "dest"}
					onPress={() => select("dest")}
				/>
			</View>
			<Compass
				angle={ANGLE}
				target={target()}
				onPress={() => {
					const t = target();
					select(t ? t.id : "dest");
				}}
			/>
			<If when={!full}>
				<View class="absolute right-3 top-3">
					<Button
						ref={(node) => {
							openButton = node;
						}}
						testID="open-chart"
						accessibilityLabel={`Open chart (${keymap.label(OPEN_CHART)})`}
						tooltip={`Open chart (${keymap.label(OPEN_CHART)})`}
						onPress={() => props.onOpenFull?.(openButton)}
						class="size-8 items-center justify-center rounded-lg border border-map-ink/30 bg-map-paper hover:bg-map-ink/10 focus-visible:ring-2 focus-visible:ring-ring/40"
					>
						<Icon name="fullscreen" tint="tint-map-ink" />
					</Button>
				</View>
			</If>
			<If when={full}>
				<View class="absolute right-3 top-3 flex-row items-center gap-2">
					<If when={moved()}>
						<ChartButton
							testID="whole-chart"
							label="Whole chart"
							hint="Back to the whole chart"
							onPress={home}
							wide
						/>
					</If>
					<View class="flex-row rounded-lg border border-map-ink/30 bg-map-paper">
						<ChartButton
							label="−"
							accessibilityLabel="Zoom out"
							hint="Zoom out  −"
							disabled={atMin()}
							onPress={() => zoomBy(1 / 1.45)}
						/>
						<ChartButton
							label="+"
							accessibilityLabel="Zoom in"
							hint="Zoom in  +"
							disabled={atMax()}
							onPress={() => zoomBy(1.45)}
						/>
					</View>
				</View>
			</If>
			<FieldNotes
				plans={props.plans}
				page={props.page}
				chart={chart()}
				id={selected()}
				side={side()}
				onClose={() => selected.set(null)}
				onOpenTasks={props.onOpenTasks}
			/>
		</View>
	);
}

/**
 * The chart full window, over the planning page. The page stays where it was
 * underneath, scroll position and drafts included. Escape closes the field
 * notes first, then this view.
 */
export function FullChart(props: { plans: Plans; page: PlanPage; onClose: () => void; onOpenTasks?: () => void }) {
	const state = chartState();
	const frame = signal<Frame | null>(null);
	return (
		<View testID="chart-full" class="absolute inset-0 bg-background">
			<View class="flex-row items-center gap-4 border-b border-border px-6 py-2.5">
				<Text role="header" class="text-sm font-semibold text-foreground">
					{`Expedition chart · ${props.page.title || "This mission"}`}
				</Text>
				<Text class="flex-1 text-xs text-faint">
					Drag or scroll to look around. Pinch, ⌘-scroll or − and + zoom. Esc closes the notes, then the chart.
				</Text>
				<Action
					label="Close chart (Esc)"
					icon="fullscreenExit"
					iconOnly
					testID="chart-close"
					onPress={props.onClose}
				/>
			</View>
			<View
				class="flex-1 p-4"
				onLayout={({ bounds }) =>
					frame.set({ w: Math.max(320, bounds.size.width - 32), h: Math.max(240, bounds.size.height - 32) })
				}
			>
				<If when={frame()}>
					<ExpeditionChart
						plans={props.plans}
						page={props.page}
						state={state}
						mode="full"
						frame={frame() ?? undefined}
						onClose={props.onClose}
						onOpenTasks={props.onOpenTasks}
					/>
				</If>
			</View>
		</View>
	);
}

/**
 * The visible trace of one change while it plays: ink spreading, mist drifting off,
 * or a ring around the new camp. It goes when the change has played.
 */
function MotionMark(props: { motion: Motion; at: At }) {
	const m = () => props.motion;
	const size = () => (m().kind === "lift" ? 112 : m().kind === "ink" ? 96 : 48);
	const range = (from: number, to: number) => m().p.interpolate({ inputRange: [0, 1], outputRange: [from, to] });
	return (
		<View
			testID={`motion-${m().kind}-${m().id}`}
			accessible={false}
			accessibilityElementsHidden
			class="absolute left-0 top-0 rounded-full"
			classList={{
				"border-2 border-map-ink": m().kind === "ink",
				"bg-map-fog": m().kind === "lift",
				"border-2 border-map-route": m().kind === "camp",
			}}
			style={{
				width: size(),
				height: size(),
				pointerEvents: "none",
				opacity: m().kind === "lift" ? range(0.7, 0) : range(m().kind === "camp" ? 0.9 : 0.45, 0),
				transform: [
					...props.at(m().at.x, m().at.y, -size() / 2, -size() / 2),
					{ scale: m().kind === "lift" ? range(1, 1.6) : m().kind === "ink" ? range(0.3, 1.5) : range(0.5, 1.8) },
				],
			}}
		/>
	);
}

function ChartButton(props: {
	label: string;
	accessibilityLabel?: string;
	hint: string;
	testID?: string;
	disabled?: boolean;
	wide?: boolean;
	onPress: () => void;
}) {
	return (
		<Button
			testID={props.testID}
			accessibilityLabel={props.accessibilityLabel ?? null}
			tooltip={props.hint}
			disabled={props.disabled}
			onPress={props.onPress}
			class="h-8 min-w-8 items-center justify-center rounded-lg px-2 hover:bg-map-ink/10 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring/40"
			classList={{ "border border-map-ink/30 bg-map-paper px-3": props.wide === true }}
		>
			<Text class={props.wide ? "text-sm text-map-ink" : "text-base text-map-ink"}>{props.label}</Text>
		</Button>
	);
}

/** Moves a view to a chart point, offset by (dx, dy) screen points. */
type At = (x: number, y: number, dx?: number, dy?: number) => TransformStep[];

/** One place: its mark and, close enough, its label. The whole place is one button. */
function PlaceMark(props: {
	testID: string;
	style: TransformStep[];
	kind: GlyphKind;
	tone: Tone;
	title: string;
	line: string;
	lineTone: "needs" | "faint";
	faint?: boolean;
	strong?: boolean;
	label: string;
	selected: boolean;
	labelAlpha: number | AnimatedNode;
	onPress: () => void;
}) {
	return (
		<View
			testID={props.testID}
			role="button"
			accessibilityLabel={props.label}
			accessibilityState={{ selected: props.selected }}
			onPress={props.onPress}
			class="group absolute left-0 top-0 flex-row items-start gap-1 rounded-md focus-visible:ring-2 focus-visible:ring-ring/40"
			style={{ transform: props.style }}
		>
			<Glyph kind={props.kind} tone={props.tone} selected={props.selected} />
			<View class="max-w-40 pt-1" style={{ opacity: props.labelAlpha }}>
				<Text
					class="line-clamp-2 text-sm leading-tight group-hover:underline"
					classList={{
						"font-semibold": props.strong === true && !props.faint,
						"font-medium": props.strong !== true || props.faint === true,
						"text-primary": props.selected,
						"text-map-faint": !props.selected && props.faint === true,
						"text-map-ink": !props.selected && props.faint !== true,
					}}
					style={{ textShadow: halo() }}
				>
					{props.title}
				</Text>
				<Text
					class="line-clamp-1 text-xs"
					classList={{
						"text-needs-ink": props.lineTone === "needs",
						"text-map-faint": props.lineTone === "faint",
					}}
					style={{ textShadow: halo() }}
				>
					{props.line}
				</Text>
			</View>
		</View>
	);
}

function FogMark(props: {
	style: TransformStep[];
	chart: Chart;
	fog: PlanPage["fog"][number];
	selected: boolean;
	labelAlpha: number | AnimatedNode;
	onPress: () => void;
}) {
	const f = () => props.fog;
	const line = () => (f().after.length > 0 ? `After ${f().after.join(", ")}` : "Ready to explore");
	return (
		<View
			testID={`place-fog-${f().id}`}
			role="button"
			accessibilityLabel={
				f().active
					? `Fog of war: ${f().area}. ${line()}`
					: `Fog lifted: ${f().area}. It became ${f().became.join(", ")}`
			}
			accessibilityState={{ selected: props.selected }}
			onPress={props.onPress}
			class="group absolute left-0 top-0 w-[190px] items-center rounded-lg px-1 py-1 focus-visible:ring-2 focus-visible:ring-ring/40"
			style={{ transform: props.style, opacity: props.labelAlpha }}
		>
			<If
				when={f().active}
				else={
					<Text
						class="font-serif text-xs italic group-hover:underline"
						classList={{ "text-primary": props.selected, "text-map-faint": !props.selected }}
						style={{ textShadow: halo() }}
					>
						{`Fog lifted: ${f().area}`}
					</Text>
				}
			>
				<Text class="font-serif text-xs italic text-map-faint">Fog of war</Text>
				<Text
					class="line-clamp-2 text-center font-serif text-base italic leading-tight group-hover:underline"
					classList={{ "text-primary": props.selected, "text-map-ink": !props.selected }}
				>
					{f().area}
				</Text>
				<Text class="line-clamp-1 text-xs text-map-faint">{line()}</Text>
			</If>
		</View>
	);
}

function RegionLabel(props: { page: PlanPage; chart: Chart; at: At; counts: { needs: number; rest: string } }) {
	return (
		<View
			class="absolute left-0 top-0 gap-0.5"
			style={{ transform: props.at(props.chart.region.x + 16, props.chart.region.y + 12) }}
		>
			<Text class="font-serif text-lg italic text-map-ink" style={{ textShadow: halo() }}>
				{props.page.title || "This mission"}
			</Text>
			<Text class="text-xs text-map-faint" style={{ textShadow: halo() }}>
				<If when={props.counts.needs > 0}>
					<Text class="font-semibold text-needs-ink">{`${props.counts.needs} ${props.counts.needs === 1 ? "needs" : "need"} you · `}</Text>
				</If>
				{props.counts.rest}
			</Text>
		</View>
	);
}

/** The region's harbor: how many planning rounds Pilot spent there, and whether it is there now. */
function Harbor(props: { chart: Chart; at: At; selected: string | null; onPress: (id: string) => void }) {
	const here = () => props.chart.here;
	const last = () => props.chart.camps.length;
	return (
		<If when={props.chart.regionRounds > 0}>
			<View
				testID="place-harbor"
				role="button"
				accessibilityLabel={`${props.chart.regionRounds} planning ${props.chart.regionRounds === 1 ? "round" : "rounds"} in this region${here() === "region" ? ". Pilot is here." : ""}`}
				accessibilityState={{ selected: props.selected === "harbor" }}
				onPress={() => props.onPress("harbor")}
				class="absolute left-0 top-0 flex-row items-center gap-1.5"
				style={{ transform: props.at(props.chart.harbor.x, props.chart.harbor.y, -34, -12) }}
			>
				<View
					class="h-6 items-center justify-center rounded-full border-2 border-map-route px-2"
					classList={{
						"bg-map-route": here() === "region",
						"bg-map-paper": here() !== "region",
						"ring-2 ring-primary": props.selected === "harbor",
					}}
				>
					<Text
						class="font-serif text-xs font-semibold"
						classList={{ "text-map-paper": here() === "region", "text-map-route": here() !== "region" }}
					>
						{`${props.chart.regionRounds} ${props.chart.regionRounds === 1 ? "round" : "rounds"}`}
					</Text>
				</View>
				<If when={here() === "region"}>
					<Text class="font-serif text-xs italic text-map-route" style={{ textShadow: halo() }}>
						{`Pilot is here, round ${last()}`}
					</Text>
				</If>
			</View>
		</If>
	);
}

/** Where Pilot is, when that is the home port or the destination. */
function HereLabel(props: { chart: Chart; at: At }) {
	const here = () => props.chart.here;
	return (
		<If when={here() !== "region"}>
			<View
				class="absolute left-0 top-0"
				style={{
					transform: props.at(
						here() === "home" ? props.chart.home.x : props.chart.dest.x,
						props.chart.lane,
						here() === "home" ? -40 : -150,
						here() === "home" ? -64 : -16,
					),
				}}
			>
				<Text class="font-serif text-xs italic text-map-route" style={{ textShadow: halo() }}>
					{`Pilot is here, round ${props.chart.camps.length}`}
				</Text>
			</View>
		</If>
	);
}

/** Where the mission should end up, and the build tasks the approved plan became. */
function Destination(props: { page: PlanPage; style: TransformStep[]; selected: boolean; onPress: () => void }) {
	const tasks = () => props.page.map?.tasks ?? [];
	return (
		<View class="absolute left-0 top-0 w-50 gap-2" style={{ transform: props.style }}>
			<View
				testID="place-dest"
				role="button"
				accessibilityLabel={`Destination: ${props.page.destination}. ${stageName(props.page)}`}
				accessibilityState={{ selected: props.selected }}
				onPress={props.onPress}
				class="group gap-1 rounded-lg focus-visible:ring-2 focus-visible:ring-ring/40"
			>
				<Text
					class="font-serif text-lg italic group-hover:underline"
					classList={{ "text-primary": props.selected, "text-map-ink": !props.selected }}
				>
					Destination
				</Text>
				<Text class="text-sm text-map-ink">{props.page.destination || "Not written yet"}</Text>
				<Text class="text-xs text-map-faint">{stageName(props.page)}</Text>
			</View>
			<View class="gap-1 border-t border-map-ink/25 pt-2">
				<Text class="font-serif text-sm italic text-map-faint">Build tasks</Text>
				<If
					when={tasks().length > 0}
					else={
						<Text class="text-xs text-map-faint">
							None yet. They come from the plan you approve, and start only when you start them.
						</Text>
					}
				>
					<Each of={tasks()} key={(t) => t.id}>
						{(t) => (
							<View class="flex-row items-center gap-1">
								<Glyph kind="crate" tone="plain" />
								<View class="flex-1">
									<Text class="line-clamp-1 text-xs text-map-ink">
										{t().number > 0 ? `#${t().number} ${t().title}` : t().title}
									</Text>
									<Text class="text-xs text-map-faint">{t().status}</Text>
								</View>
							</View>
						)}
					</Each>
				</If>
			</View>
		</View>
	);
}

function Compass(props: { angle: AnimatedValue; target: { id: string; title: string } | null; onPress: () => void }) {
	return (
		<View
			testID="compass"
			role="button"
			accessibilityLabel={
				props.target
					? `Compass. It points at what needs you: ${props.target.title}`
					: "Compass. Nothing needs you, so it points ahead to the destination."
			}
			onPress={props.onPress}
			class="absolute items-center gap-0.5 rounded-full focus-visible:ring-2 focus-visible:ring-ring/40"
			style={{ right: COMPASS.right, bottom: 8, width: COMPASS.size }}
		>
			<Canvas
				accessible={false}
				accessibilityElementsHidden
				style={{ width: COMPASS.size, height: COMPASS.size }}
				draw={(cx) => drawCompass(cx, inks(), props.angle)}
			/>
			<Text
				class="text-center font-serif text-xs italic leading-tight text-map-faint"
				style={{ textShadow: halo() }}
			>
				{props.target ? "points at what needs you" : "nothing needs you"}
			</Text>
		</View>
	);
}

/** The field notes of the selected place: the same records the outline shows, beside the chart. */
function FieldNotes(props: {
	plans: Plans;
	page: PlanPage;
	chart: Chart;
	id: string | null;
	side: "left" | "right";
	onClose: () => void;
	onOpenTasks?: () => void;
}) {
	const item = () => props.page.explorations.find((e) => e.id === props.id) ?? null;
	const fog = () =>
		props.id?.startsWith("fog:") ? (props.page.fog.find((f) => `fog:${f.id}` === props.id) ?? null) : null;
	const shown = () =>
		item() !== null || fog() !== null || props.id === "home" || props.id === "dest" || props.id === "harbor";
	const kind = () => {
		const e = item();
		if (e) return `${kindName(e.kind)} · ${stateName(e)}`;
		const f = fog();
		if (f) return f.active ? "Fog of war" : "Fog lifted";
		if (props.id === "home") return "Home port";
		if (props.id === "dest") return "Destination";
		return "Harbor";
	};
	const title = () =>
		item()?.title ??
		fog()?.area ??
		(props.id === "home" ? "Your brief" : props.id === "dest" ? props.page.destination : "Planning rounds here");
	return (
		<If when={shown()}>
			<View
				testID="field-notes"
				accessibilityLabel="Field notes"
				class="absolute top-14 w-80 overflow-hidden rounded-xl border border-border bg-popover shadow-md"
				classList={{
					"bottom-3 left-3": props.side === "left",
					// On the right the notes stop above the compass, which stays in view.
					"bottom-36 right-3": props.side === "right",
				}}
			>
				<Scroll class="flex-1">
					<View class="gap-3 p-4">
						<View class="flex-row items-center gap-2">
							<Text class="flex-1 text-xs text-faint">{kind()}</Text>
							<Button
								accessibilityLabel="Close field notes"
								tooltip="Close  Esc"
								onPress={props.onClose}
								class="size-7 items-center justify-center rounded-md hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
							>
								<Text class="text-base text-muted-foreground">×</Text>
							</Button>
						</View>
						<Text role="header" class="font-serif text-xl leading-snug text-popover-foreground">
							{title()}
						</Text>
						<If when={item()}>
							{(e) => (
								<View class="gap-3">
									<Text class="text-sm text-foreground">{exploreLine(e())}</Text>
									<Each of={e().changed} key={(c) => c}>
										{(c) => <Text class="text-xs text-needs-ink">{c()}</Text>}
									</Each>
									<ItemRecord plans={props.plans} page={props.page} item={e()} />
								</View>
							)}
						</If>
						<If when={fog()}>
							{(f) => (
								<View class="gap-2">
									<FogRecord plans={props.plans} page={props.page} fog={f()} />
									<Text class="text-xs leading-relaxed text-faint">
										Fog of war is an area Pilot does not understand well enough to ask about yet. It blocks
										nothing.
									</Text>
								</View>
							)}
						</If>
						<If when={props.id === "home"}>
							<Text class="text-sm leading-relaxed text-foreground">
								{props.page.goal || "Your brief is not shown here."}
							</Text>
							<Text class="text-xs leading-relaxed text-faint">
								Where the mission set out: your words, as you wrote them. Pilot reads them and never changes
								them.
							</Text>
						</If>
						<If when={props.id === "dest"}>
							<Text class="text-sm text-muted-foreground">{stageName(props.page)}</Text>
							<If when={props.page.map}>
								<Agreement
									info={props.page.map as NonNullable<PlanPage["map"]>}
									onOpenTasks={props.onOpenTasks}
								/>
							</If>
							<Text class="text-xs leading-relaxed text-faint">
								Approving a plan publishes build tasks. It starts nothing; each task starts only when you start
								it.
							</Text>
						</If>
						<If when={props.id === "harbor"}>
							<Each of={props.page.rounds} key={(r) => r.id}>
								{(r) => (
									<View class="gap-1 border-t border-border pt-2">
										<Text class="text-sm font-medium text-foreground">{r().title}</Text>
										<Text class="text-xs text-muted-foreground">{r().line}</Text>
										<Each of={r().answers} key={(a) => a.prompt}>
											{(a) => (
												<View class="gap-0.5 pt-1">
													<Text class="text-xs text-faint">{a().prompt}</Text>
													<Text class="text-sm text-foreground">{a().answer || "No answer"}</Text>
												</View>
											)}
										</Each>
									</View>
								)}
							</Each>
							<If when={props.chart.camps.length > props.page.rounds.length + 1}>
								<Text class="text-xs text-faint">{props.chart.camps[props.chart.camps.length - 1].line}</Text>
							</If>
							<Text class="text-xs leading-relaxed text-faint">
								Each planning round is a camp on Pilot's route. Submitting a round completes that round only; it
								is not approval to build.
							</Text>
						</If>
					</View>
				</Scroll>
			</View>
		</If>
	);
}

// ---------- the lists below the chart ----------

/** Pilot's planning rounds, oldest first. A row shows its harbor on the chart. */
export function ExpeditionLog(props: { page: PlanPage; state: ChartState }) {
	const camps = computed(() => chartOf(props.page).camps);
	return (
		<View testID="expedition-log" class="gap-1">
			<SectionTitle title="Expedition log" count={camps().length}>
				<Text class="text-xs text-faint">Oldest first</Text>
			</SectionTitle>
			<Each of={camps()} key={(c) => `${c.n}`}>
				{(c, i) => (
					<View
						testID={`log-${c().n}`}
						role="button"
						accessibilityLabel={`Planning round ${c().n}: ${c().title}. ${c().line}. Show it on the chart.`}
						onPress={() => {
							props.state.selected.set(c().harbor === "region" ? "harbor" : c().harbor);
							props.state.frame.ref?.reveal({ vertical: "nearest" });
						}}
						class="group flex-row items-start gap-3 rounded-md border-t border-border py-2 focus-visible:ring-2 focus-visible:ring-ring/40"
					>
						<View
							class="mt-0.5 size-5 items-center justify-center rounded-full border border-map-route"
							classList={{ "bg-map-route": i() === camps().length - 1 }}
						>
							<Text
								class="font-serif text-xs font-semibold"
								classList={{
									"text-map-paper": i() === camps().length - 1,
									"text-map-route": i() !== camps().length - 1,
								}}
							>
								{String(c().n)}
							</Text>
						</View>
						<View class="flex-1 gap-0.5">
							<Text class="text-sm font-medium text-foreground group-hover:underline">{c().title}</Text>
							<Text class="line-clamp-2 text-xs text-muted-foreground">{c().line}</Text>
						</View>
					</View>
				)}
			</Each>
		</View>
	);
}

/** A line sample for the key: a trail, the route or the channel. */
function Swatch(props: { kind: "trail" | "route" | "channel" }) {
	return (
		<Canvas
			accessible={false}
			accessibilityElementsHidden
			style={{ width: 32, height: 16 }}
			draw={(cx) => {
				const c = inks();
				const p = new Path2D();
				cx.lineCap = "round";
				if (props.kind === "trail") {
					p.moveTo(4, 12);
					p.quadraticCurveTo(16, 0, 28, 12);
					cx.setLineDash([0.5, 5]);
					stroke(cx, p, c.ink, 2.2);
				} else if (props.kind === "route") {
					p.moveTo(3, 11);
					p.bezierCurveTo(10, 2, 20, 14, 29, 5);
					stroke(cx, p, c.route, 2.2);
				} else {
					p.moveTo(3, 8);
					p.lineTo(29, 8);
					stroke(cx, p, c.route, 5, 0.35);
				}
			}}
		/>
	);
}

const KEY: { mark: { kind: GlyphKind; tone: Tone } | { line: "trail" | "route" | "channel" }; words: string }[] = [
	{ mark: { kind: "flag", tone: "done" }, words: "Settled. Inked ground: answered by you, a decision or Knowledge." },
	{ mark: { kind: "signpost", tone: "needs" }, words: "A fork only you choose. Pilot waits for your answers." },
	{ mark: { kind: "trig", tone: "plain" }, words: "A survey point: ready for research." },
	{ mark: { kind: "tent", tone: "run" }, words: "A research chat at work. Nothing saved yet." },
	{ mark: { kind: "tent-done", tone: "plain" }, words: "Research done. Its findings wait for Pilot to record them." },
	{ mark: { kind: "flask", tone: "plain" }, words: "A prototype. Its finding is evidence, not acceptance." },
	{ mark: { kind: "gate", tone: "wait" }, words: "Waits for something else first." },
	{ mark: { line: "trail" }, words: "A trail: what waits for what. Dotted until the first is settled." },
	{
		mark: { kind: "fog", tone: "fog" },
		words: "Fog of war: not clear enough to ask about yet. It blocks nothing; the serpent is asleep.",
	},
	{ mark: { line: "route" }, words: "Pilot's route between planning rounds. Only the latest legs stay strong." },
	{ mark: { line: "channel" }, words: "The channel from the home port to the destination." },
	{
		mark: { kind: "crate", tone: "plain" },
		words: "A build task, after you approve the plan. It starts only when you start it.",
	},
];

/** What each mark on the chart means. */
export function ChartKey() {
	return (
		<View testID="chart-key" class="gap-1">
			<SectionTitle title="Key to the chart" />
			<Each of={KEY} key={(k) => k.words}>
				{(k) => (
					<View class="flex-row items-center gap-3 py-0.5">
						<View class="w-8 items-center">
							{"line" in k().mark ? (
								<Swatch kind={(k().mark as { line: "trail" | "route" | "channel" }).line} />
							) : (
								<Glyph
									kind={(k().mark as { kind: GlyphKind; tone: Tone }).kind}
									tone={(k().mark as { kind: GlyphKind; tone: Tone }).tone}
								/>
							)}
						</View>
						<Text class="flex-1 text-sm text-muted-foreground">{k().words}</Text>
					</View>
				)}
			</Each>
		</View>
	);
}
