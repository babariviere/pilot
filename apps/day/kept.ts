// Where the user is inside a screen, kept as plain values so keeping it
// changes nothing on screen: the scroll offset of the screen shown, and the
// text field that last had the keyboard focus with its selection. An update
// saves them in its SavedView; a restored view hands them back once, as
// upstream NSH supports it: `contentOffset` or `scrollTo` for a scroll,
// `focus` and `setSelection` for a field. An input method's unfinished
// composition (preedit) is not kept: NSH reports it but has no way to set it
// again, and the native owner commits or cancels it before forms are saved.
import { type InputRef, signal } from "nsh";

/** One screen's scroll offset, by the screen's key. */
type Offset = { key: string; y: number };

let shown: Offset = { key: "", y: 0 };
let waiting: Offset | null = null;

/** Today's restored offset, for a Today that is already on screen. Its Scroll takes it once. */
export const todayScrollTo = signal<number | null>(null);

/**
 * The scroll props of the screen `key`, called once as it mounts. A
 * restored offset for it starts it there once; after that it starts at the
 * top, as before. Its scrolling is kept as it happens.
 */
export function keepScroll(key: string) {
	let y = 0;
	if (waiting?.key === key) {
		y = waiting.y;
		waiting = null;
	}
	shown = { key, y };
	return {
		contentOffset: { y },
		onScroll: (e: { offset: { y: number } }) => {
			shown = { key, y: e.offset.y };
		},
	};
}

/** The kept offset of screen `key`, or 0 when another screen scrolled last. */
export function scrollOf(key: string): number {
	return shown.key === key ? Math.max(0, shown.y) : 0;
}

/** Starts screen `key` at `y` the next time it mounts, once. */
export function restoreScroll(key: string, y: number) {
	waiting = y > 0 ? { key, y } : null;
}

/** A text field, by the screen's key for it, and its selection in UTF-16 units. */
export type Field = { key: string; place: string; start: number; end: number };

let field: Field | null = null;
let waitingField: Field | null = null;

function utf16(text: string): number {
	return text.length;
}

/**
 * The field that last had the keyboard focus on screen `place`, kept when
 * it loses the focus to a button (such as Update). Another field's focus
 * replaces it.
 */
export function lastField(place: string): Field | null {
	return field && field.place === place ? field : null;
}

/** Forgets every kept field and offset, as a new window starts. */
export function forgetPlaces() {
	shown = { key: "", y: 0 };
	waiting = null;
	field = null;
	waitingField = null;
	todayScrollTo.set(null);
}

/** Gives `key` the keyboard focus with that selection when its field next mounts, once. */
export function restoreField(next: Field | null) {
	waitingField = next?.key ? next : null;
}

/**
 * The focus, selection and ref handlers that keep field `key` on screen
 * `place()`. `text()` is its value now. `ref` also gets the node.
 */
export function keepField(key: string, place: () => string, text: () => string, ref?: (node: InputRef) => void) {
	return {
		ref: (node: InputRef) => {
			ref?.(node);
			const want = waitingField;
			if (!want || want.key !== key) return;
			waitingField = null;
			const length = utf16(text());
			const start = Math.min(want.start, length);
			const end = Math.min(Math.max(want.end, start), length);
			field = { key, place: place(), start, end };
			node.focus();
			node.setSelection(start, end);
		},
		focus: () => {
			// The caret until the platform reports the selection.
			if (field?.key === key) return;
			const end = utf16(text());
			field = { key, place: place(), start: end, end };
		},
		select: (e: { start: number; end: number }) => {
			const start = Math.max(0, Math.min(e.start, e.end));
			const end = Math.max(e.start, e.end, 0);
			field = { key, place: place(), start, end };
		},
	};
}
