#!/usr/bin/env node
// Generates the app icon SVGs from a small 3D model of the plane:
// - Resources/AppIcon.svg: the full drawing, for 128 pt and up.
// - Resources/AppIconSmall.svg: a simplified drawing (flat shapes, outline, indigo fin), for 16 and 32 pt.
// AppIcon.svg also carries the flat top-down outline (#plane) that PlaneGlyph.swift draws in the menu bar.
// Everything is hard 4x4 Bayer dithering in square cells: no blur, no gradients.
// Usage: node scripts/icon-svg.mjs (scripts/icon.sh runs it before building AppIcon.icns).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const resources = join(dirname(fileURLToPath(import.meta.url)), "..", "Resources");
const { PI, sin, cos, sqrt, max, min, abs, pow, floor, hypot } = Math;

// Palette: Home's day sky, the app's indigo, and cool greys for the plane.
const SKY = ["#2F6FC6", "#4F8FD6", "#7DB9E8", "#D6E8FA"];
const WHITE = "#FFFFFF";
const PAPER = "#FAFAFA";
const STEEL = "#D4D8E2";
const GREY = "#9CA3AF";
const INDIGO = "#6366F1";
const INDIGO_LIGHT = "#818CF8";
const DUSK = "#3F3D7A";
const WINDOW = "#1F2937";
const OUTLINE = "#B6C2D4";
const OUTLINE_SMALL = "#94A3B8";

const BAYER = [
	[0, 8, 2, 10],
	[12, 4, 14, 6],
	[3, 11, 1, 9],
	[15, 7, 13, 5],
];

/** A colour from an ordered ramp, stepping to the next one by the Bayer threshold of cell (cx, cy). */
function pick(colors, t, cx, cy) {
	const v = max(0, min(1, t)) * (colors.length - 1);
	const base = floor(v);
	return colors[min(colors.length - 1, base + ((v - base) * 16 > BAYER[cy % 4][cx % 4] ? 1 : 0))];
}

// The tile: Apple's macOS icon grid, rounded to a size that divides into 16, 32 and 64 cells.
const ORIGIN = 96;
const SIZE = 832;
const RADIUS = 187;

// Model: x right, y forward (nose), z up, fuselage radius R. t runs 0 at the tail to 1 at the nose.
const R = 0.14;
const noseDrop = (t) => (t > 0.8 ? -R * 0.38 * pow((t - 0.8) / 0.2, 1.6) : 0);
function fuselageRadius(t) {
	if (t < 0.22) return R * (0.25 + 0.75 * sin((t / 0.22) * (PI / 2)));
	if (t > 0.82) {
		const u = (t - 0.82) / 0.18;
		return R * pow(max(0, 1 - u * u), 0.5) * (1 - 0.06 * u);
	}
	return R;
}
const stationY = (t) => -1.1 + 2.15 * t;

/** Heading turns the plane in the ground plane, tilt shows its side, pitch raises the nose. Degrees. */
function camera({ heading, tilt, pitch = 0, scale, cx, cy }) {
	const h = (heading * PI) / 180;
	const k = (tilt * PI) / 180;
	const p = (pitch * PI) / 180;
	return {
		heading: h,
		tilt: k,
		scale,
		p([x, y, z]) {
			const vy = y * cos(p) - z * sin(p);
			const vz = y * sin(p) + z * cos(p);
			const x1 = x * cos(h) + vy * sin(h);
			const y1 = -x * sin(h) + vy * cos(h);
			return [cx + x1 * scale, cy - (y1 * cos(k) + vz * sin(k)) * scale];
		},
	};
}

const poly = (cam, points) => ({ kind: "poly", points: points.map((point) => cam.p(point)) });
const mirror = (points) => points.map(([x, y, z]) => [-x, y, z]);

/** The plane's parts as unit-square shapes (polygons, circles and rounded squares). */
function plane(cam) {
	const body = [];
	for (let i = 0; i <= 60; i++) {
		const t = i / 60;
		const r = fuselageRadius(t) * cam.scale;
		if (r > 0.001) body.push({ kind: "circle", c: cam.p([0, stationY(t), noseDrop(t)]), r });
	}
	const wing = [
		[0.1, 0.25, -0.04],
		[1.05, -0.22, 0.02],
		[1.1, -0.3, 0.02],
		[1.06, -0.36, 0.02],
		[0.36, -0.18, -0.04],
		[0.1, -0.18, -0.04],
	];
	const winglet = [
		[1.06, -0.22, 0.02],
		[1.1, -0.3, 0.02],
		[1.12, -0.36, 0.16],
		[1.1, -0.3, 0.16],
	];
	const stabilizer = [
		[0.06, -0.78, 0.02],
		[0.44, -0.98, 0.04],
		[0.44, -1.06, 0.04],
		[0.06, -1.02, 0.02],
	];
	const engines = [];
	for (const side of [-1, 1]) {
		for (let i = 0; i <= 12; i++) {
			engines.push({ kind: "circle", c: cam.p([0.42 * side, -0.04 + (0.26 * i) / 12, -0.12]), r: 0.072 * cam.scale });
		}
	}
	// Cabin windows on the side facing the camera, stopping well before the nose.
	const windows = [];
	const a = -0.1;
	if (cos(a) * sin(cam.heading) * sin(cam.tilt) + sin(a) * cos(cam.tilt) > 0.05) {
		for (let i = 0; i < 12; i++) {
			const [x, y] = cam.p([R * cos(a), -0.66 + i * 0.105, R * sin(a) + 0.02]);
			windows.push({ kind: "rect", x: x - 0.006, y: y - 0.006, w: 0.012, h: 0.012, r: 0.004 });
		}
	}
	// An indigo cheatline low on the visible side, clipped to the body.
	const cheat = [];
	const c = -0.3;
	if (cos(c) * sin(cam.heading) * sin(cam.tilt) + sin(c) * cos(cam.tilt) > 0) {
		const front = [];
		const back = [];
		for (let i = 0; i <= 20; i++) {
			const y = -0.9 + i * 0.085;
			front.push([R * cos(c), y, R * sin(c)]);
			back.push([R * cos(c - 0.22), y, R * sin(c - 0.22)]);
		}
		cheat.push(poly(cam, [...front, ...back.reverse()]));
	}
	return {
		body,
		wings: [poly(cam, wing), poly(cam, mirror(wing))],
		winglets: [poly(cam, winglet), poly(cam, mirror(winglet))],
		stabilizers: [poly(cam, stabilizer), poly(cam, mirror(stabilizer))],
		engines,
		fin: [
			poly(cam, [
				[0, -0.62, R * 0.9],
				[0, -1.02, R * 0.7],
				[0, -1.12, 0.5],
				[0, -0.98, 0.5],
			]),
		],
		finEdge: [
			poly(cam, [
				[0, -0.62, R * 0.9],
				[0, -0.98, 0.5],
				[0, -1.03, 0.5],
				[0, -0.7, R * 0.9],
			]),
		],
		finRoot: [
			poly(cam, [
				[R * 0.55, -0.6, R * 0.8],
				[R * 0.55, -1.02, R * 0.62],
				[R * 0.85, -1.0, R * 0.4],
				[R * 0.85, -0.64, R * 0.5],
			]),
		],
		windows,
		cheat,
		axis: [cam.p([0, -1, 0]), cam.p([0, 1, 0])],
	};
}

// SVG output, in tile pixels.
const px = (u) => +(ORIGIN + u * SIZE).toFixed(1);
const len = (u) => +(u * SIZE).toFixed(1);
function element(shape) {
	switch (shape.kind) {
		case "poly":
			return '<path d="M' + shape.points.map(([x, y]) => px(x) + " " + px(y)).join("L") + 'Z"/>';
		case "circle":
			return '<circle cx="' + px(shape.c[0]) + '" cy="' + px(shape.c[1]) + '" r="' + len(shape.r) + '"/>';
		case "rect":
			return (
				'<rect x="' + px(shape.x) + '" y="' + px(shape.y) + '" width="' + len(shape.w) + '" height="' + len(shape.h) +
				'" rx="' + len(shape.r) + '"/>'
			);
	}
}
function bounds(shapes) {
	let x0 = 1;
	let y0 = 1;
	let x1 = 0;
	let y1 = 0;
	for (const shape of shapes) {
		const points =
			shape.kind === "poly"
				? shape.points
				: shape.kind === "circle"
					? [
							[shape.c[0] - shape.r, shape.c[1] - shape.r],
							[shape.c[0] + shape.r, shape.c[1] + shape.r],
						]
					: [
							[shape.x, shape.y],
							[shape.x + shape.w, shape.y + shape.h],
						];
		for (const [x, y] of points) {
			x0 = min(x0, x);
			y0 = min(y0, y);
			x1 = max(x1, x);
			y1 = max(y1, y);
		}
	}
	return { x0: max(0, x0), y0: max(0, y0), x1: min(1, x1), y1: min(1, y1) };
}

class Drawing {
	defs = [];
	body = [];
	clips = 0;

	clip(shapes) {
		const id = "c" + this.clips++;
		this.defs.push('<clipPath id="' + id + '">' + shapes.map(element).join("") + "</clipPath>");
		return id;
	}

	/** Paints cells of an n × n grid over the shapes' bounds, clipped to the shapes. shade returns a colour or null. */
	cells(shapes, n, shade, { within } = {}) {
		if (shapes.length === 0) return;
		const box = bounds(shapes);
		const cx0 = max(0, floor(box.x0 * n));
		const cy0 = max(0, floor(box.y0 * n));
		const cx1 = min(n - 1, floor(box.x1 * n));
		const cy1 = min(n - 1, floor(box.y1 * n));
		const rows = [];
		const counts = new Map();
		let empty = false;
		for (let cy = cy0; cy <= cy1; cy++) {
			const row = [];
			for (let cx = cx0; cx <= cx1; cx++) {
				const color = shade((cx + 0.5) / n, (cy + 0.5) / n, cx, cy);
				row.push(color);
				if (color === null) empty = true;
				else counts.set(color, (counts.get(color) ?? 0) + 1);
			}
			rows.push(row);
		}
		const base = empty ? null : [...counts].sort((a, b) => b[1] - a[1])[0][0];
		const cell = SIZE / n;
		const out = [];
		if (base) {
			out.push(
				'<rect x="' + (ORIGIN + cx0 * cell) + '" y="' + (ORIGIN + cy0 * cell) + '" width="' + (cx1 - cx0 + 1) * cell +
					'" height="' + (cy1 - cy0 + 1) * cell + '" fill="' + base + '"/>',
			);
		}
		const runs = new Map();
		rows.forEach((row, j) => {
			for (let i = 0; i < row.length; ) {
				const color = row[i];
				let end = i + 1;
				while (end < row.length && row[end] === color) end++;
				if (color !== null && color !== base) {
					const list = runs.get(color) ?? [];
					list.push("M" + (ORIGIN + (cx0 + i) * cell) + " " + (ORIGIN + (cy0 + j) * cell) + "h" + (end - i) * cell + "v" + cell + "h-" + (end - i) * cell + "z");
					runs.set(color, list);
				}
				i = end;
			}
		});
		for (const [color, list] of runs) out.push('<path fill="' + color + '" d="' + list.join("") + '"/>');
		let group = '<g clip-path="url(#' + this.clip(shapes) + ')">' + out.join("") + "</g>";
		if (within) group = '<g clip-path="url(#' + within + ')">' + group + "</g>";
		this.body.push(group);
	}

	fill(shapes, color) {
		if (shapes.length) this.body.push('<g fill="' + color + '">' + shapes.map(element).join("") + "</g>");
	}

	/** An outline outside the union of the shapes: a wide stroke under them, which their fills cover inside. */
	outline(shapes, color, width) {
		this.body.push(
			'<g fill="none" stroke="' + color + '" stroke-width="' + width + '" stroke-linejoin="round">' +
				shapes.map(element).join("") + "</g>",
		);
	}

	svg(extraDefs = "") {
		return (
			'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n' +
			"  <!-- Generated by scripts/icon-svg.mjs. Edit the script, not this file. -->\n" +
			"  <defs>\n" +
			'    <clipPath id="tile"><rect x="' + ORIGIN + '" y="' + ORIGIN + '" width="' + SIZE + '" height="' + SIZE + '" rx="' + RADIUS + '"/></clipPath>\n' +
			this.defs.map((def) => "    " + def + "\n").join("") +
			extraDefs +
			"  </defs>\n" +
			'  <g clip-path="url(#tile)">\n' +
			this.body.map((part) => "    " + part + "\n").join("") +
			"  </g>\n" +
			"</svg>\n"
		);
	}
}

// Heading 45° to the top right, camera tilted 35° to show the side, nose pitched up 15° (taking off).
const cam = camera({ heading: 45, tilt: 35, pitch: 15, scale: 0.4, cx: 0.5, cy: 0.52 });
const sky = (x, y, cx, cy) => pick(SKY, (x + y) * 0.62, cx, cy);

function full() {
	const d = new Drawing();
	const p = plane(cam);
	const [a, b] = p.axis;
	const ax = b[0] - a[0];
	const ay = b[1] - a[1];
	const span = hypot(ax, ay);
	// Signed distance across the fuselage axis: negative on the side away from the light.
	const across = (x, y) => ((x - a[0]) * -ay + (y - a[1]) * ax) / span;
	const tile = [{ kind: "rect", x: 0, y: 0, w: 1, h: 1, r: 0 }];
	d.cells(tile, 32, sky);
	const silhouette = [...p.body, ...p.wings, ...p.stabilizers, ...p.engines, ...p.fin];
	d.outline(silhouette, OUTLINE, 6);
	const metal = [WHITE, PAPER, STEEL];
	d.cells(p.stabilizers, 64, (x, y, cx, cy) => pick(metal, 0.3, cx, cy));
	d.cells(p.engines, 64, (x, y, cx, cy) => pick(metal, max(0, -across(x, y)) * 4 + 0.2, cx, cy));
	d.cells(p.wings, 64, (x, y, cx, cy) => pick(metal, max(0, -across(x, y)) * 0.6 + 0.15, cx, cy));
	d.fill(p.winglets, INDIGO);
	d.cells(p.body, 64, (x, y, cx, cy) => pick([WHITE, WHITE, PAPER, STEEL, GREY], (across(x, y) / 0.14 + 1) / 2, cx, cy));
	const body = d.clip(p.body);
	d.cells(p.cheat, 64, () => INDIGO, { within: body });
	d.fill(p.windows, WINDOW);
	d.cells(p.finRoot, 64, (x, y, cx, cy) => ((cx + cy) % 2 === 0 ? STEEL : null));
	d.cells(p.fin, 64, (x, y, cx, cy) => pick([INDIGO_LIGHT, INDIGO, INDIGO, DUSK], 0.15 + abs(across(x, y)) * 1.2, cx, cy));
	d.fill(p.finEdge, DUSK);
	return d;
}

function small() {
	const d = new Drawing();
	const p = plane(cam);
	d.cells([{ kind: "rect", x: 0, y: 0, w: 1, h: 1, r: 0 }], 16, sky);
	const silhouette = [...p.body, ...p.wings, ...p.stabilizers, ...p.engines];
	d.outline([...silhouette, ...p.fin], OUTLINE_SMALL, 40);
	d.fill(silhouette, WHITE);
	d.fill(p.winglets, INDIGO);
	d.fill(p.fin, INDIGO);
	return d;
}

/** The flat top-down outline for the menu bar: nose up, centred near the origin, in SVG units. */
function glyph() {
	const S = 280;
	const circles = [];
	for (let i = 0; i <= 60; i++) circles.push([stationY(i / 60), fuselageRadius(i / 60)]);
	const half = (y) => max(0, ...circles.map(([cy, r]) => (abs(y - cy) < r ? sqrt(r * r - (y - cy) ** 2) : 0)));
	const top = max(...circles.map(([cy, r]) => cy + r));
	const bottom = min(...circles.map(([cy, r]) => cy - r));
	const n = 28;
	const ys = [];
	for (let k = 0; k <= n; k++) ys.push((top + bottom) / 2 + ((top - bottom) / 2) * cos((PI * k) / n));
	const fuselage = [...ys.map((y) => [half(y), y]), ...ys.slice(1, -1).reverse().map((y) => [-half(y), y])];
	const wing = [
		[0.1, 0.25],
		[1.05, -0.22],
		[1.1, -0.3],
		[1.06, -0.36],
		[0.36, -0.18],
		[0.1, -0.18],
	];
	const stabilizer = [
		[0.06, -0.78],
		[0.44, -0.98],
		[0.44, -1.06],
		[0.06, -1.02],
	];
	const flip = (points) => points.map(([x, y]) => [-x, y]).reverse();
	const area = (points) => points.reduce((sum, [x, y], i) => {
		const [nx, ny] = points[(i + 1) % points.length];
		return sum + x * ny - nx * y;
	}, 0);
	const parts = [fuselage, wing, flip(wing), stabilizer, flip(stabilizer)].map((points) => {
		const svg = points.map(([x, y]) => [Math.round(x * S), Math.round(-y * S)]);
		const unique = svg.filter(([x, y], i) => i === 0 || x !== svg[i - 1][0] || y !== svg[i - 1][1]);
		// Drop points in the middle of straight runs (the fuselage's parallel sides).
		const corners = unique.filter(([x, y], i) => {
			const [px, py] = unique[(i + unique.length - 1) % unique.length];
			const [nx, ny] = unique[(i + 1) % unique.length];
			return (x - px) * (ny - y) - (y - py) * (nx - x) !== 0;
		});
		// One winding for every part, so the nonzero fill joins overlaps instead of cutting holes.
		return area(corners) < 0 ? corners.reverse() : corners;
	});
	return parts.map((points) => "M " + points.map(([x, y]) => x + " " + y).join(" L ") + " Z").join(" ");
}

const planePath = glyph();
writeFileSync(join(resources, "AppIcon.svg"), full().svg('    <path id="plane" d="' + planePath + '"/>\n'));
writeFileSync(join(resources, "AppIconSmall.svg"), small().svg());
console.log(planePath);
