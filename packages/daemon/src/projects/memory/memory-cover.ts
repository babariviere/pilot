/** Age-weighted cover described by VictorTaelin/OptMem's memo. Ranges are half-open here. */
export type Block = [number, number];
function tile(total: number, alpha: number, cap: number): Block[] {
	const out: Block[] = [];
	for (let cursor = 0; cursor < total; ) {
		// Select the largest aligned dyadic interval allowed by its age and the snapshot end.
		let size = 1;
		while (size * 2 <= total - cursor && cursor % (size * 2) === 0 && size * 2 <= alpha * (total - cursor)) size *= 2;
		out.push([cursor, cursor + size]);
		cursor += size;
		if (out.length > cap) break;
	}
	return out;
}
export function cover(total: number, budget = 96): Block[] {
	if (!Number.isSafeInteger(total) || total < 0 || !Number.isInteger(budget) || budget < 1)
		throw new Error("Invalid cover size");
	if (!total) return [];
	if (total <= budget) return Array.from({ length: total }, (_, i): Block => [i, i + 1]);
	let low = 0,
		high = 1;
	for (let i = 0; i < 60; i++) {
		const mid = (low + high) / 2;
		if (tile(total, mid, budget).length > budget) low = mid;
		else high = mid;
	}
	// A prefix may require popcount(total) blocks even at maximum coarsening.
	const out = tile(total, high, Number.MAX_SAFE_INTEGER);
	while (out.length < budget) {
		const i = out.findLastIndex(([lo, hi]) => hi - lo > 1);
		if (i < 0) break;
		const [lo, hi] = out[i]!,
			mid = (lo + hi) / 2;
		out.splice(i, 1, [lo, mid], [mid, hi]);
	}
	return out;
}
