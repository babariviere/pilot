/** Generic validators for untrusted request fields. */

/** Opaque IDs in requests and saved records: operation, chat, mission, task and request IDs. */
export const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A plain object whose own keys are exactly `keys`. */
export function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

/** A trimmed string field. Throws "<name> must be a string", "<name> is required" or "<name> is too long". */
export function text(
	value: unknown,
	name: string,
	max: number,
	options: { optional?: boolean; empty?: boolean; codePoints?: boolean } = {},
) {
	if (value === undefined && options.optional) return undefined;
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	const trimmed = value.trim();
	if (!trimmed && !options.empty) throw new Error(`${name} is required`);
	if ((options.codePoints ? Array.from(value).length : value.length) > max)
		throw new Error(`${name} is too long (max ${max} characters)`);
	return trimmed;
}
