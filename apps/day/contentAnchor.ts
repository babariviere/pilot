// Keeps what the user reads in place when content above it changes size.
// A Scroll has no content anchor in NSH 0.5, so when a card arrives in Now
// above the screen, everything below would move down by its height. The
// page names a few anchor views; after a layout change it measures them
// against the page root, picks the one that showed the top of the screen
// and scrolls by however far that anchor moved. One check runs at a time,
// and changes that arrive meanwhile join the next one. A scroll by the user
// during a check cancels its adjustment; leaving the page stops it. Nothing
// polls: only layout changes start a check.
import type { ScrollRef, ViewRef } from "nsh";

export type ContentAnchor = {
	/** The page's Scroll, as its `ref`. */
	scroll: (node: ScrollRef) => void;
	/** The view the anchors are measured against: the page's content root. */
	root: (node: ViewRef) => void;
	/** The page scrolled to `y`, from its `onScroll`. */
	scrolled: (y: number) => void;
	/** The user started to drag the page, from its `onScrollDragStart`: an adjustment in flight is dropped. */
	dragged: (y: number) => void;
	/** One anchor view: its `ref` and `onLayout`. */
	part: (name: string) => { ref: (node: ViewRef) => void; onLayout: () => void };
	/** The page left: stop. */
	dispose: () => void;
};

let probe: ((name: string) => Promise<Span | null>) | null = null;
/** Set when the keyboard focus moves with a task to its new place: that place is revealed instead. */
let yieldOnce = false;

/** The next check reveals the focused place instead of keeping the anchor. */
export function yieldAnchor() {
	yieldOnce = true;
}

/**
 * Where anchor `name` sits on screen now: its top and bottom from the top of the screen, in points, or null when it
 * is not drawn. Read only, for test fixtures that check the page kept its place.
 */
export function anchorOnScreen(name: string): Promise<Span | null> {
	return probe ? probe(name) : Promise.resolve(null);
}

export type Span = { top: number; bottom: number };

/**
 * The anchor that shows what is at the top of the screen, from where the anchors were: the innermost one that
 * held the top of the screen, else the first one below it, which is the first the user sees. Anchors that are
 * gone now do not count.
 */
function anchorAt(was: Map<string, Span>, top: number, now: Map<string, Span>): string | null {
	let holding: string | null = null;
	let below: string | null = null;
	for (const [n, s] of was) {
		if (!now.has(n)) continue;
		if (s.top <= top && s.bottom > top) {
			if (!holding || s.top >= (was.get(holding) as Span).top) holding = n;
		} else if (s.top > top && (!below || s.top < (was.get(below) as Span).top)) below = n;
	}
	return holding ?? below;
}

export function createContentAnchor(startY: number): ContentAnchor {
	let scroll: ScrollRef | null = null;
	let root: ViewRef | null = null;
	const parts = new Map<string, ViewRef>();
	/** Each anchor's top and bottom in the root, from the last check. */
	let before = new Map<string, Span>();
	let y = startY;
	/** The offset this anchor scrolled to; its own scroll event is not the user's. */
	let ours: number | null = null;
	let moves = 0;
	let running = false;
	let again = false;
	let alive = true;

	const measure = async () => {
		if (!scroll || !root) return null;
		const names = [...parts.keys()];
		// A view that left the page measures as null; a refused measure counts as nothing seen.
		const all = await Promise.all([
			scroll.measure(),
			root.measure(),
			...names.map((n) => (parts.get(n) as ViewRef).measure()),
		]).catch(() => null);
		if (!all) return null;
		const [s, r, ...views] = all;
		if (!s || !r) return null;
		const tops = new Map<string, Span>();
		names.forEach((n, i) => {
			const v = views[i];
			if (v) {
				const top = v.pagePosition.y - r.pagePosition.y;
				tops.set(n, { top, bottom: top + v.bounds.size.height });
			}
		});
		return { top: s.pagePosition.y - r.pagePosition.y, tops };
	};

	const check = async () => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			do {
				again = false;
				const startMoves = moves;
				const seen = await measure();
				if (!alive || !seen) return;
				const skip = yieldOnce;
				yieldOnce = false;
				// At the top of the page nothing is scrolled past: what grows in the header pushes the rest down, as
				// it should, and the page stays at the top.
				const atTop = seen.top <= 0 || y <= 1;
				if (!skip && !atTop && moves === startMoves) {
					const name = anchorAt(before, seen.top, seen.tops);
					const shift = name ? (seen.tops.get(name) as Span).top - (before.get(name) as Span).top : 0;
					if (Math.abs(shift) >= 1 && scroll) {
						y = Math.max(0, y + shift);
						ours = y;
						scroll.scrollTo({ y, animated: false });
					}
				}
				before = seen.tops;
			} while (again && alive);
		} finally {
			running = false;
		}
	};

	const anchor: ContentAnchor = {
		scroll: (node) => {
			scroll = node;
		},
		root: (node) => {
			root = node;
		},
		scrolled: (next) => {
			y = next;
			if (ours !== null && Math.abs(next - ours) < 1) {
				ours = null;
				return;
			}
			ours = null;
			moves++;
			yieldOnce = false;
		},
		dragged: (next) => {
			y = next;
			ours = null;
			moves++;
			yieldOnce = false;
		},
		part: (name) => ({
			ref: (node) => {
				parts.set(name, node);
			},
			onLayout: () => void check(),
		}),
		dispose: () => {
			alive = false;
			if (probe === read) probe = null;
		},
	};
	const read = async (name: string) => {
		const seen = await measure();
		const span = seen?.tops.get(name);
		return seen && span ? { top: span.top - seen.top, bottom: span.bottom - seen.top } : null;
	};
	probe = read;
	return anchor;
}
