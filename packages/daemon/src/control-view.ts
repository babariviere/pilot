/** Persisted OptChat ranges. The merge heap exists only for one fixed-time batch. */
export interface ControlLine {
	id: number;
	n: number;
	text: string;
}
export const CONTROL_VIEW_HIGH = 128_000;
export const CONTROL_VIEW_LOW = 64_000;
export function controlLine(line: ControlLine): string {
	return `${line.id}+${line.n}|${line.text.replace(/[\r\n]/g, " ")}\n`;
}
type Link = { line: ControlLine; prev?: Link; next?: Link; live: boolean };
type Pair = { left: Link; right: Link; due: number };
/** Most due first, oldest on ties. Age is measured from the LAST message, not the first. */
function before(a: Pair, b: Pair): boolean {
	return a.due > b.due || (a.due === b.due && a.left.line.id < b.left.line.id);
}
export function mergeControlView(
	lines: ControlLine[],
	total: number,
	parent: (id: number, n: number) => string | undefined,
	budget: { bytes?: number; lines?: number },
): { lines: ControlLine[]; merges: ControlLine[] } {
	const links: Link[] = lines.map((line) => ({ line, live: true }));
	for (let i = 0; i < links.length; i++) {
		links[i]!.prev = links[i - 1];
		links[i]!.next = links[i + 1];
	}
	let first: Link | undefined = links[0],
		count = lines.length;
	let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(controlLine(line)), 0);
	const heap: Pair[] = [],
		merges: ControlLine[] = [];
	const add = (left?: Link) => {
		const right = left?.next;
		if (!left || !right || left.line.n !== right.line.n || left.line.id % (left.line.n * 2)) return;
		if (right.line.id !== left.line.id + left.line.n || parent(left.line.id, left.line.n * 2) === undefined) return;
		const pair = { left, right, due: (total - (right.line.id + right.line.n - 1)) / left.line.n };
		let i = heap.length;
		heap.push(pair);
		while (i) {
			const p = (i - 1) >> 1;
			if (!before(pair, heap[p]!)) break;
			heap[i] = heap[p]!;
			i = p;
		}
		heap[i] = pair;
	};
	for (const link of links) add(link);
	const pop = (): Pair | undefined => {
		const top = heap[0],
			last = heap.pop();
		if (heap.length && last) {
			let i = 0;
			while (i * 2 + 1 < heap.length) {
				let child = i * 2 + 1;
				if (child + 1 < heap.length && before(heap[child + 1]!, heap[child]!)) child++;
				if (!before(heap[child]!, last)) break;
				heap[i] = heap[child]!;
				i = child;
			}
			heap[i] = last;
		}
		return top;
	};
	while (
		(budget.bytes !== undefined && bytes > budget.bytes) ||
		(budget.lines !== undefined && count > budget.lines)
	) {
		const pair = pop();
		if (!pair) break;
		const { left, right } = pair;
		if (!left.live || !right.live || left.next !== right) continue;
		const line = { id: left.line.id, n: left.line.n * 2, text: parent(left.line.id, left.line.n * 2)! };
		const merged: Link = { line, prev: left.prev, next: right.next, live: true };
		left.live = right.live = false;
		if (merged.prev) merged.prev.next = merged;
		else first = merged;
		if (merged.next) merged.next.prev = merged;
		bytes +=
			Buffer.byteLength(controlLine(line)) -
			Buffer.byteLength(controlLine(left.line)) -
			Buffer.byteLength(controlLine(right.line));
		count--;
		merges.push(line);
		add(merged.prev);
		add(merged);
	}
	const out: ControlLine[] = [];
	for (let link: Link | undefined = first; link; link = link.next) out.push(link.line);
	return { lines: out, merges };
}
