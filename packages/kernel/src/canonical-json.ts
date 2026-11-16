/** Stable code-unit key order for persisted planning holds and interview identities. */
export function canonicalJSON(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: item,
	);
}
