import { createHash } from "node:crypto";

export const payloadHash = (payload: string): string => createHash("sha256").update(payload).digest("hex");

/**
 * Sorts keys with localeCompare. Saved digests, including journal stream keys, hash this output. Changing
 * the order needs a hash migration. The kernel's canonicalJSON (code-unit order) is a separate stored form.
 */
export function canonicalJSON(value: unknown): string {
	return JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
			: item,
	);
}
