// Layout for FlowDiagram: steps placed in ranks along the flow's direction,
// links drawn between them. The layout is a pure function of the data and the
// text scale, so the same data always gives the same picture.
import { attempt, choice, flag, type Laid, list, optionalText, Problem, record, text } from "./check";
import { wrap } from "./text";

/** How a step stands out. Words carry the meaning; a tone only supports them. */
export type Tone = "default" | "accent" | "muted" | "danger";
export const TONES: readonly Tone[] = ["default", "accent", "muted", "danger"];

export interface FlowNode {
	id: string;
	label: string;
	detail?: string;
	tone?: Tone;
}

export interface FlowEdge {
	from: string;
	to: string;
	label?: string;
	dashed?: boolean;
}

export interface FlowSpec {
	/** The way the flow reads: "right" (default) or "down". */
	direction?: "right" | "down";
	nodes: readonly FlowNode[];
	edges?: readonly FlowEdge[];
}

/** The most a flow may hold. Larger data is refused, never cut. */
export const FLOW_LIMITS = { nodes: 40, edges: 80, id: 40, label: 80, detail: 160, edgeLabel: 40 } as const;

export interface Point {
	x: number;
	y: number;
}

export interface PlacedNode {
	id: string;
	label: string;
	detail?: string;
	tone: Tone;
	rank: number;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Lines the label and detail get; text past them ends with an ellipsis. */
	labelLines: number;
	detailLines: number;
	clipped: boolean;
}

export interface PlacedEdge {
	from: string;
	to: string;
	label?: string;
	dashed: boolean;
	/** A link that goes back against the flow (a loop), routed below the steps. */
	back: boolean;
	/** "curve": one cubic Bézier (start, two controls, end). "route": straight segments around the steps (loops, and links that skip ranks past steps in their way). */
	kind: "curve" | "route";
	path: Point[];
	/** The arrow's tip and the angle it points at, in radians. */
	tip: Point;
	angle: number;
	labelAt?: Point;
}

export interface FlowLayout {
	direction: "right" | "down";
	width: number;
	height: number;
	nodes: PlacedNode[];
	edges: PlacedEdge[];
	/** The flow in words, for screen readers. */
	summary: string;
}

/** Sizes in points at text scale 1. Text sizes match `text-sm` and `text-xs`. */
export const FLOW_METRICS = {
	width: 176,
	padX: 12,
	padY: 10,
	label: 14,
	labelLine: 20,
	labelLines: 3,
	detail: 12,
	detailLine: 16,
	detailLines: 2,
	detailGap: 2,
	minHeight: 44,
	gapRank: 72,
	gapNode: 20,
	lane: 16,
	margin: 16,
} as const;

interface Read {
	direction: "right" | "down";
	nodes: FlowNode[];
	edges: FlowEdge[];
}

function read(spec: unknown): Read {
	const data = record(spec, "The flow");
	const direction = choice(data.direction, "direction", ["right", "down"] as const, "right");
	const ids = new Set<string>();
	const nodes = list(data.nodes, "nodes", 1, FLOW_LIMITS.nodes).map((value, i) => {
		const node = record(value, `nodes[${i}]`);
		const id = text(node.id, `nodes[${i}].id`, FLOW_LIMITS.id);
		if (ids.has(id)) throw new Problem(`Two steps use the id "${id}".`);
		ids.add(id);
		return {
			id,
			label: text(node.label, `Step "${id}" label`, FLOW_LIMITS.label),
			detail: optionalText(node.detail, `Step "${id}" detail`, FLOW_LIMITS.detail),
			tone: choice(node.tone, `Step "${id}" tone`, TONES, "default"),
		};
	});
	const edges = (data.edges === undefined ? [] : list(data.edges, "edges", 0, FLOW_LIMITS.edges)).map((value, i) => {
		const edge = record(value, `edges[${i}]`);
		const from = text(edge.from, `edges[${i}].from`, FLOW_LIMITS.id);
		const to = text(edge.to, `edges[${i}].to`, FLOW_LIMITS.id);
		for (const end of [from, to]) if (!ids.has(end)) throw new Problem(`A link names "${end}", which is not a step.`);
		if (from === to)
			throw new Problem(`A link from "${from}" to itself cannot be drawn; describe it in the step's detail.`);
		return {
			from,
			to,
			label: optionalText(edge.label, `Link "${from}" to "${to}" label`, FLOW_LIMITS.edgeLabel),
			dashed: flag(edge.dashed, `Link "${from}" to "${to}" dashed`),
		};
	});
	return { direction, nodes, edges };
}

/** Which links run back against the flow: those closing a loop in a depth-first walk in data order. */
function backLinks(count: number, edges: readonly { a: number; b: number }[]): Set<number> {
	const out: number[][] = Array.from({ length: count }, () => []);
	edges.forEach((edge, i) => {
		out[edge.a].push(i);
	});
	const state = new Array<number>(count).fill(0);
	const back = new Set<number>();
	const visit = (node: number) => {
		state[node] = 1;
		for (const i of out[node]) {
			const next = edges[i].b;
			if (state[next] === 1) back.add(i);
			else if (state[next] === 0) visit(next);
		}
		state[node] = 2;
	};
	for (let node = 0; node < count; node++) if (state[node] === 0) visit(node);
	return back;
}

/** Lays out `spec` at text scale `scale` (the reader's text size), or says why it cannot. */
export function layoutFlow(spec: FlowSpec, scale = 1): Laid<FlowLayout> {
	return attempt(() => place(read(spec), scale));
}

function place({ direction, nodes, edges }: Read, scale: number): FlowLayout {
	const m = FLOW_METRICS;
	const index = new Map(nodes.map((node, i) => [node.id, i]));
	const links = edges.map((edge) => ({ a: index.get(edge.from)!, b: index.get(edge.to)! }));
	const back = backLinks(nodes.length, links);

	// Rank: the longest chain of forward links that reaches a step.
	const rank = new Array<number>(nodes.length).fill(0);
	const indegree = new Array<number>(nodes.length).fill(0);
	links.forEach((link, i) => {
		if (!back.has(i)) indegree[link.b] += 1;
	});
	const ready = nodes.map((_, i) => i).filter((i) => indegree[i] === 0);
	while (ready.length > 0) {
		ready.sort((a, b) => a - b);
		const node = ready.shift()!;
		links.forEach((link, i) => {
			if (back.has(i) || link.a !== node) return;
			rank[link.b] = Math.max(rank[link.b], rank[node] + 1);
			indegree[link.b] -= 1;
			if (indegree[link.b] === 0) ready.push(link.b);
		});
	}
	const ranks = Math.max(...rank) + 1;

	// Order inside a rank: data order, then one pass toward the average place of each step's sources.
	const layers: number[][] = Array.from({ length: ranks }, () => []);
	nodes.forEach((_, i) => {
		layers[rank[i]].push(i);
	});
	const position = new Array<number>(nodes.length).fill(0);
	for (const layer of layers) {
		const keyed = layer.map((node, at) => {
			const sources = links.filter((link, i) => !back.has(i) && link.b === node).map((link) => position[link.a]);
			const key = sources.length > 0 ? sources.reduce((a, b) => a + b, 0) / sources.length : at;
			return { node, key };
		});
		keyed.sort((a, b) => a.key - b.key || a.node - b.node);
		keyed.forEach((entry, at) => {
			position[entry.node] = at;
			layer[at] = entry.node;
		});
	}

	// Box sizes from the estimated text wrap.
	const width = Math.round(m.width * scale);
	const inner = width - 2 * m.padX;
	const boxes = nodes.map((node) => {
		const label = wrap(node.label, inner, m.label * scale, m.labelLines);
		const detail = node.detail
			? wrap(node.detail, inner, m.detail * scale, m.detailLines)
			: { lines: 0, clipped: false };
		const height = Math.max(
			m.minHeight,
			Math.ceil(
				2 * m.padY +
					label.lines * m.labelLine * scale +
					(detail.lines > 0 ? m.detailGap + detail.lines * m.detailLine * scale : 0),
			),
		);
		return {
			width,
			height,
			labelLines: label.lines,
			detailLines: detail.lines,
			clipped: label.clipped || detail.clipped,
		};
	});

	// Positions along the flow ("main") and across it ("cross"), mapped to x and y at the end.
	const right = direction === "right";
	const mainSize = (i: number) => (right ? boxes[i].width : boxes[i].height);
	const crossSize = (i: number) => (right ? boxes[i].height : boxes[i].width);
	const rankMain = layers.map((layer) => Math.max(...layer.map(mainSize)));
	// Loops run through the gaps before and after ranks, so the ends get a gap's room too.
	const ends = back.size > 0 ? m.gapRank / 2 : 0;
	const rankStart: number[] = [];
	let cursor = ends;
	for (let r = 0; r < ranks; r++) {
		rankStart.push(cursor);
		cursor += rankMain[r] + m.gapRank;
	}
	const mainTotal = cursor - m.gapRank + ends;
	const rankCross = layers.map(
		(layer) => layer.reduce((sum, i) => sum + crossSize(i), 0) + (layer.length - 1) * m.gapNode,
	);
	const crossContent = Math.max(...rankCross);
	const main = new Array<number>(nodes.length).fill(0);
	const cross = new Array<number>(nodes.length).fill(0);
	layers.forEach((layer, r) => {
		let at = (crossContent - rankCross[r]) / 2;
		for (const i of layer) {
			main[i] = rankStart[r] + (rankMain[r] - mainSize(i)) / 2;
			cross[i] = at;
			at += crossSize(i) + m.gapNode;
		}
	});

	// A forward link that skips ranks would cross the steps between; it goes around them instead.
	const blocked = (a: number, b: number) => {
		const from = cross[a] + crossSize(a) / 2;
		const to = cross[b] + crossSize(b) / 2;
		const low = Math.min(from, to) - 4;
		const high = Math.max(from, to) + 4;
		return nodes.some(
			(_, i) => rank[i] > rank[a] && rank[i] < rank[b] && cross[i] < high && cross[i] + crossSize(i) > low,
		);
	};
	const around = links.map((link, i) => !back.has(i) && rank[link.b] - rank[link.a] > 1 && blocked(link.a, link.b));
	const aboveCount = around.filter(Boolean).length;
	const shift = aboveCount > 0 ? m.lane * (aboveCount + 1) : 0;

	const map = (p: Point): Point =>
		right ? { x: m.margin + p.x, y: m.margin + shift + p.y } : { x: m.margin + shift + p.y, y: m.margin + p.x };
	const angle = right ? 0 : Math.PI / 2;
	let backCount = 0;
	let aboveIndex = 0;
	const placedEdges = edges.map((edge, i): PlacedEdge => {
		const { a, b } = links[i];
		const start = { x: main[a] + mainSize(a), y: cross[a] + crossSize(a) / 2 };
		const end = { x: main[b], y: cross[b] + crossSize(b) / 2 };
		if (!back.has(i) && !around[i]) {
			const half = (end.x - start.x) / 2;
			const path = [start, { x: start.x + half, y: start.y }, { x: end.x - half, y: end.y }, end];
			const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
			return {
				...edge,
				dashed: edge.dashed ?? false,
				back: false,
				kind: "curve",
				path: path.map(map),
				tip: map(end),
				angle,
				labelAt: edge.label ? map(mid) : undefined,
			};
		}
		// The link leaves into the gap after its source, runs in its own lane outside every step
		// (a loop below, a skipping link above), and comes in through the gap before its target.
		let lane: number;
		let nth: number;
		if (back.has(i)) {
			backCount += 1;
			nth = backCount;
			lane = crossContent + m.lane * backCount;
		} else {
			aboveIndex += 1;
			nth = aboveIndex;
			lane = -m.lane * aboveIndex;
		}
		const offset = Math.min((nth - 1) * 6, m.gapRank / 2 - 8);
		const out = rankStart[rank[a]] + rankMain[rank[a]] + m.gapRank / 2 - offset;
		const into = rankStart[rank[b]] - m.gapRank / 2 + offset;
		const path = [
			start,
			{ x: out, y: start.y },
			{ x: out, y: lane },
			{ x: into, y: lane },
			{ x: into, y: end.y },
			end,
		];
		return {
			...edge,
			dashed: edge.dashed ?? false,
			back: back.has(i),
			kind: "route",
			path: path.map(map),
			tip: map(end),
			angle,
			labelAt: edge.label ? map({ x: (out + into) / 2, y: lane }) : undefined,
		};
	});
	const crossTotal = shift + crossContent + (backCount > 0 ? m.lane * (backCount + 1) : 0);

	const placedNodes = nodes.map((node, i): PlacedNode => {
		const at = map({ x: main[i], y: cross[i] });
		return {
			id: node.id,
			label: node.label,
			detail: node.detail,
			tone: node.tone ?? "default",
			rank: rank[i],
			x: at.x,
			y: at.y,
			width: boxes[i].width,
			height: boxes[i].height,
			labelLines: boxes[i].labelLines,
			detailLines: boxes[i].detailLines,
			clipped: boxes[i].clipped,
		};
	});
	const words = edges.map((edge) => {
		const from = nodes[index.get(edge.from)!].label;
		const to = nodes[index.get(edge.to)!].label;
		return `${from} to ${to}${edge.label ? ` (${edge.label})` : ""}`;
	});
	const summary = `Flow of ${nodes.length} ${nodes.length === 1 ? "step" : "steps"}.${words.length > 0 ? ` ${words.join("; ")}.` : ""}`;
	return {
		direction,
		width: Math.ceil(2 * m.margin + (right ? mainTotal : crossTotal)),
		height: Math.ceil(2 * m.margin + (right ? crossTotal : mainTotal)),
		nodes: placedNodes,
		edges: placedEdges,
		summary,
	};
}
