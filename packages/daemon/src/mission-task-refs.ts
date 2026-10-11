/** Expand claim selectors before any writes. Opaque task IDs (including UUIDs) stay intact. */
export function parseTaskRefs(input: unknown): string[] {
	const values = Array.isArray(input) ? input : [input];
	const refs = new Set<string>();
	let expanded = 0;
	const limit = 1000;
	if (!values.length || values.length > limit) throw new Error(`claim requires 1-${limit} task selectors`);
	const add = (ref: string) => {
		if (++expanded > limit) throw new Error(`claim accepts at most ${limit} expanded task references`);
		refs.add(ref);
	};
	const number = (value: string) => {
		const n = Number(value.replace(/^#/, ""));
		if (!Number.isSafeInteger(n) || n < 1) throw new Error("task numbers must be positive safe integers");
		return n;
	};
	for (const value of values) {
		if (typeof value !== "string" && typeof value !== "number")
			throw new Error("task selectors must be IDs, numbers or ranges such as 1-5");
		if (typeof value === "number") {
			add(String(number(String(value))));
			continue;
		}
		if (value.length > 128) throw new Error("task selector is too long (max 128 characters)");
		for (const part of value.split(",")) {
			const ref = part.trim();
			if (!ref) throw new Error("task selector must not be empty");
			const range = /^#?(\d+)\s*-\s*#?(\d+)$/.exec(ref);
			if (range) {
				const start = number(range[1]!);
				const end = number(range[2]!);
				if (end < start) throw new Error("task range must be ascending");
				if (end - start + 1 > limit - expanded)
					throw new Error(`claim accepts at most ${limit} expanded task references`);
				for (let n = start; n <= end; n++) add(String(n));
			} else {
				add(/^#?\d+$/.test(ref) ? String(number(ref)) : ref);
			}
		}
	}
	return [...refs];
}
