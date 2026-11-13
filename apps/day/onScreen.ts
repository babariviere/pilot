// Whether a view shows in the page's scroll view, for previews that pause
// out of view. A page with previews hands over its Scroll and its scrolling;
// `rested` changes once scrolling stops for a moment, so a fast pass does
// not stop and start every preview it crosses. Nothing polls.
import { signal, type ViewRef } from "nsh";

const REST_MS = 250;

let page: ViewRef | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Changes once the page's scrolling rests. */
export const rested = signal(0);

/** The shown page's Scroll, as its `ref`. */
export function pageScroll(node: ViewRef) {
	page = node;
}

/** The page scrolled: `rested` changes when it stops. */
export function scrolled() {
	clearTimeout(timer);
	timer = setTimeout(() => rested.update((n) => n + 1), REST_MS);
}

/**
 * Whether any part of `node` is inside the page's scroll view now. A view
 * not in the tree does not show; without a page to compare, it does.
 */
export async function showsInPage(node: ViewRef): Promise<boolean> {
	const [scroll, view] = await Promise.all([page ? page.measure() : Promise.resolve(null), node.measure()]);
	if (!view) return false;
	if (!scroll) return true;
	const top = scroll.pagePosition.y;
	const bottom = top + scroll.bounds.size.height;
	return view.pagePosition.y < bottom && view.pagePosition.y + view.bounds.size.height > top;
}
