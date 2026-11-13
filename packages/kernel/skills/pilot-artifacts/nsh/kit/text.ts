// Text size estimates that place diagram boxes before the platform lays out
// their text. The estimates lean wide: a label wraps a little early rather
// than spilling out of its box. The platform still draws the real text, and
// a label longer than its box allows ends with an ellipsis.

const WIDE =
	/[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]|[\u{20000}-\u{3fffd}]/u;
const NARROW = /[ijlI1.,:;'|!()[\]{}\s]/;
const BROAD = /[mwMW@%]/;

/** The estimated width in points of `text` at font size `size`. */
export function textWidth(text: string, size: number): number {
	let width = 0;
	for (const ch of text) {
		if (WIDE.test(ch)) width += size;
		else if (NARROW.test(ch)) width += size * 0.32;
		else if (BROAD.test(ch)) width += size * 0.86;
		else if (ch >= "A" && ch <= "Z") width += size * 0.68;
		else width += size * 0.58;
	}
	return width;
}

/** How many lines a word wrap gives `text` in `width` points, kept to `max`; `clipped` when more were needed. */
export function wrap(text: string, width: number, size: number, max: number): { lines: number; clipped: boolean } {
	const space = textWidth(" ", size);
	let lines = 0;
	for (const paragraph of text.split("\n")) {
		let used = 0;
		let started = false;
		for (const word of paragraph.split(/\s+/)) {
			if (word === "") continue;
			const w = textWidth(word, size);
			if (started && used + space + w <= width) {
				used += space + w;
			} else if (w <= width) {
				lines += 1;
				used = w;
			} else {
				// A word wider than the line breaks between its characters.
				const pieces = Math.ceil(w / width);
				lines += pieces;
				used = w - (pieces - 1) * width;
			}
			started = true;
		}
		if (!started) lines += 1;
	}
	lines = Math.max(lines, 1);
	return { lines: Math.min(lines, max), clipped: lines > max };
}
