// Pure layout checks: deterministic, inside their bounds, and refusing what
// they cannot draw. Headless; no window or GPU.
import { expect, test } from "nsh/test";
import { FLOW_METRICS, type FlowLayout, type FlowSpec, layoutFlow } from "../kit/flow";
import { layoutSequence, type SequenceLayout, type SequenceSpec } from "../kit/sequence";
import { wrap } from "../kit/text";

const SHIP: FlowSpec = {
	nodes: [
		{ id: "ask", label: "Request", detail: "From Today or a mission" },
		{ id: "plan", label: "Plan" },
		{ id: "build", label: "Build in a workspace", tone: "accent" },
		{ id: "check", label: "Checks", detail: "Lint and affected tests" },
		{ id: "review", label: "Ready for you to check" },
	],
	edges: [
		{ from: "ask", to: "plan" },
		{ from: "plan", to: "build" },
		{ from: "build", to: "check" },
		{ from: "check", to: "review", label: "pass" },
		{ from: "check", to: "build", label: "fix", dashed: true },
	],
};

const BRANCHES: FlowSpec = {
	direction: "down",
	nodes: [
		{ id: "app", label: "Pilot app" },
		{ id: "daemon", label: "Background service" },
		{ id: "a", label: "Worker A" },
		{ id: "b", label: "Worker B" },
		{ id: "store", label: "Session storage" },
	],
	edges: [
		{ from: "app", to: "daemon" },
		{ from: "daemon", to: "a" },
		{ from: "daemon", to: "b" },
		{ from: "a", to: "store" },
		{ from: "b", to: "store" },
		{ from: "app", to: "store", label: "reads" },
	],
};

function laid(spec: FlowSpec, scale = 1): FlowLayout {
	const result = layoutFlow(spec, scale);
	if (!result.ok) throw new Error(result.problem);
	return result.layout;
}

function refusal(spec: unknown): string {
	const result = layoutFlow(spec as FlowSpec);
	if (result.ok) throw new Error("expected a refusal");
	return result.problem;
}

function inside(layout: { width: number; height: number }, x: number, y: number) {
	expect(x >= 0 && x <= layout.width).toBe(true);
	expect(y >= 0 && y <= layout.height).toBe(true);
}

function boxesApart(boxes: readonly { x: number; y: number; width: number; height: number }[]) {
	for (let i = 0; i < boxes.length; i++)
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i];
			const b = boxes[j];
			const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
			expect(overlap).toBe(false);
		}
}

function flowInside(layout: FlowLayout) {
	for (const node of layout.nodes) {
		inside(layout, node.x, node.y);
		inside(layout, node.x + node.width, node.y + node.height);
	}
	for (const edge of layout.edges) {
		for (const p of edge.path) inside(layout, p.x, p.y);
		if (!edge.labelAt) continue;
		const at = edge.labelAt;
		inside(layout, at.x, at.y);
		// A link label never sits on a step.
		expect(layout.nodes.some((n) => at.x > n.x && at.x < n.x + n.width && at.y > n.y && at.y < n.y + n.height)).toBe(
			false,
		);
	}
	boxesApart(layout.nodes);
}

test("the same flow always gets the same layout", () => {
	expect(JSON.stringify(laid(SHIP))).toBe(JSON.stringify(laid(SHIP)));
	expect(JSON.stringify(laid(BRANCHES))).toBe(JSON.stringify(laid(BRANCHES)));
});

test("a flow stays inside its bounds without overlapping steps", () => {
	for (const spec of [SHIP, BRANCHES]) for (const scale of [0.85, 1, 1.6]) flowInside(laid(spec, scale));
});

test("ranks follow the flow and a loop is routed back around the steps", () => {
	const layout = laid(SHIP);
	const rank = new Map(layout.nodes.map((n) => [n.id, n.rank]));
	expect([...rank.values()]).toEqual([0, 1, 2, 3, 4]);
	const loop = layout.edges.find((e) => e.from === "check" && e.to === "build")!;
	expect(loop.back).toBe(true);
	expect(loop.kind).toBe("route");
	expect(loop.dashed).toBe(true);
	// The loop's lane runs below every step.
	const lowest = Math.max(...layout.nodes.map((n) => n.y + n.height));
	expect(Math.max(...loop.path.map((p) => p.y)) > lowest).toBe(true);
	expect(layout.edges.filter((e) => e.back).length).toBe(1);
	expect(layout.summary).toContain("Checks to Build in a workspace (fix)");
});

test("a downward flow places later ranks lower", () => {
	const layout = laid(BRANCHES);
	const node = (id: string) => layout.nodes.find((n) => n.id === id)!;
	expect(node("daemon").y > node("app").y).toBe(true);
	expect(node("a").y).toBe(node("b").y);
	expect(node("store").rank).toBe(3);
	expect(layout.edges.every((e) => !e.back)).toBe(true);
	// The link from the app to storage skips two ranks with steps in its way, so it goes around them.
	const skip = layout.edges.find((e) => e.from === "app" && e.to === "store")!;
	expect(skip.kind).toBe("route");
	expect(Math.min(...skip.path.map((p) => p.x)) < Math.min(...layout.nodes.map((n) => n.x))).toBe(true);
	expect(layout.edges.filter((e) => e.kind === "curve").length).toBe(5);
});

test("long and wide labels wrap, grow the box and mark what is cut", () => {
	const long = "Rebuild the search index from the nightly snapshot and switch the read alias";
	const cjk = "検索インデックスを夜間スナップショットから再構築して読み取りエイリアスを切り替える".repeat(2);
	const layout = laid({
		nodes: [
			{ id: "short", label: "Start" },
			{ id: "long", label: long, detail: long },
			{ id: "cjk", label: cjk.slice(0, 80) },
		],
		edges: [
			{ from: "short", to: "long" },
			{ from: "long", to: "cjk" },
		],
	});
	const [short, wide, tall] = layout.nodes;
	expect(short.height).toBe(FLOW_METRICS.minHeight);
	expect(wide.labelLines > 1).toBe(true);
	expect(wide.height > short.height).toBe(true);
	expect(tall.labelLines).toBe(FLOW_METRICS.labelLines);
	expect(tall.clipped).toBe(true);
	flowInside(layout);
	// Larger reader text gives wider boxes, not clipped text.
	expect(laid(SHIP, 1.6).nodes[0].width > laid(SHIP).nodes[0].width).toBe(true);
});

test("malformed or oversized flows are refused with a reason", () => {
	const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `Step ${i}` }));
	expect(refusal(null)).toBe("The flow must be an object.");
	expect(refusal({ nodes: "x" })).toBe("nodes must be a list.");
	expect(refusal({ nodes: [] })).toBe("nodes needs at least 1.");
	expect(refusal({ nodes: many(41) })).toBe("nodes has 41; the limit is 40.");
	expect(
		refusal({
			nodes: [
				{ id: "a", label: "A" },
				{ id: "a", label: "B" },
			],
		}),
	).toBe('Two steps use the id "a".');
	expect(refusal({ nodes: [{ id: "a" }] })).toBe('Step "a" label must be non-empty text.');
	expect(refusal({ nodes: [{ id: "a", label: "x".repeat(81) }] })).toBe(
		'Step "a" label has 81 characters; the limit is 80.',
	);
	expect(refusal({ nodes: [{ id: "a", label: "A", tone: "red" }] })).toBe(
		'Step "a" tone must be one of: default, accent, muted, danger.',
	);
	expect(refusal({ direction: "left", nodes: many(1) })).toBe("direction must be one of: right, down.");
	expect(refusal({ nodes: many(2), edges: [{ from: "n0", to: "nope" }] })).toBe(
		'A link names "nope", which is not a step.',
	);
	expect(refusal({ nodes: many(2), edges: [{ from: "n0", to: "n0" }] })).toContain("to itself");
	const edges = Array.from({ length: 81 }, () => ({ from: "n0", to: "n1" }));
	expect(refusal({ nodes: many(2), edges })).toBe("edges has 81; the limit is 80.");
});

test("the largest allowed flow lays out inside its bounds", () => {
	const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: `Step ${i} with a longer name` }));
	const edges = Array.from({ length: 80 }, (_, i) => ({ from: `n${i % 40}`, to: `n${(i * 7 + 3) % 40}` })).filter(
		(e) => e.from !== e.to,
	);
	flowInside(laid({ nodes, edges }));
});

const SAVE: SequenceSpec = {
	participants: [
		{ id: "you", label: "You" },
		{ id: "app", label: "Pilot" },
		{ id: "daemon", label: "Background service" },
	],
	steps: [
		{ from: "you", to: "app", label: "Press Update" },
		{ from: "app", to: "app", label: "Save open drafts" },
		{ from: "app", to: "daemon", label: "Pause chats" },
		{ note: "Running tools stop at a safe point", over: ["app", "daemon"] },
		{ from: "daemon", to: "you", label: "Paused, and a long reply that has to wrap over several lines", reply: true },
	],
};

function sequence(spec: SequenceSpec, scale = 1): SequenceLayout {
	const result = layoutSequence(spec, scale);
	if (!result.ok) throw new Error(result.problem);
	return result.layout;
}

test("a sequence keeps steps in order inside its bounds", () => {
	for (const scale of [0.85, 1, 1.6]) {
		const layout = sequence(SAVE, scale);
		expect(JSON.stringify(layout)).toBe(JSON.stringify(sequence(SAVE, scale)));
		const xs = layout.participants.map((p) => p.x);
		expect(xs).toEqual([...xs].sort((a, b) => a - b));
		boxesApart(layout.participants.map((p) => p.box));
		let previous = layout.lifeline.top;
		for (const step of layout.steps) {
			const top = step.kind === "note" ? step.box.y : step.text.y;
			expect(top >= previous).toBe(true);
			if (step.kind === "note") {
				inside(layout, step.box.x, step.box.y);
				inside(layout, step.box.x + step.box.width, step.box.y + step.box.height);
				previous = step.box.y + step.box.height;
			} else {
				inside(layout, step.text.x, step.text.y);
				inside(layout, step.text.x + step.text.width, step.text.y);
				for (const p of step.path) inside(layout, p.x, p.y);
				previous = Math.max(...step.path.map((p) => p.y));
			}
		}
		expect(previous <= layout.lifeline.bottom).toBe(true);
	}
});

test("self messages loop, replies are dashed and notes span their participants", () => {
	const layout = sequence(SAVE);
	const [, self, , note, reply] = layout.steps;
	if (self.kind !== "message" || note.kind !== "note" || reply.kind !== "message") throw new Error("step kinds");
	expect(self.self).toBe(true);
	expect(self.path.length).toBe(4);
	expect(reply.dashed).toBe(true);
	expect(reply.angle).toBe(Math.PI);
	expect(reply.text.lines > 1).toBe(true);
	const [, app, daemon] = layout.participants;
	expect(note.box.x <= app.box.x).toBe(true);
	expect(note.box.x + note.box.width >= daemon.box.x + daemon.box.width).toBe(true);
	expect(layout.summary).toContain("Pilot to itself: Save open drafts");
});

test("malformed or oversized sequences are refused with a reason", () => {
	const refuse = (spec: unknown) => {
		const result = layoutSequence(spec as SequenceSpec);
		if (result.ok) throw new Error("expected a refusal");
		return result.problem;
	};
	const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `P${i}` }));
	const say = { from: "p0", to: "p1", label: "hi" };
	expect(refuse({ participants: people(11), steps: [say] })).toBe("participants has 11; the limit is 10.");
	expect(refuse({ participants: people(2), steps: Array.from({ length: 81 }, () => say) })).toBe(
		"steps has 81; the limit is 80.",
	);
	expect(refuse({ participants: people(2), steps: [{ from: "p0", to: "x", label: "hi" }] })).toBe(
		'steps[0].to names "x", which is not a participant.',
	);
	expect(refuse({ participants: people(2), steps: [{ note: "n", over: ["p0", "p0"] }] })).toBe(
		'steps[0].over names "p0" twice.',
	);
	expect(refuse({ participants: people(2), steps: [{ from: "p0", to: "p1" }] })).toBe(
		"steps[0].label must be non-empty text.",
	);
});

test("word wrap counts lines and breaks words wider than a line", () => {
	expect(wrap("", 100, 12, 3)).toEqual({ lines: 1, clipped: false });
	expect(wrap("one two", 1000, 12, 3)).toEqual({ lines: 1, clipped: false });
	expect(wrap("a\nb", 1000, 12, 3)).toEqual({ lines: 2, clipped: false });
	expect(wrap("x".repeat(100), 70, 12, 3)).toEqual({ lines: 3, clipped: true });
});
