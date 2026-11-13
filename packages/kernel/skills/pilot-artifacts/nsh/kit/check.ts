// Checks for the declarative data the helpers draw. A helper refuses data it
// cannot draw faithfully and says why; it never draws part of it.

/** Why data cannot be drawn. Layout functions turn it into a `{ ok: false }` result. */
export class Problem extends Error {}

/** A layout, or the reason there is none. */
export type Laid<T> = { ok: true; layout: T } | { ok: false; problem: string };

/** Runs `build`, turning a `Problem` (or any other thrown value) into a refusal. */
export function attempt<T>(build: () => T): Laid<T> {
	try {
		return { ok: true, layout: build() };
	} catch (error) {
		if (error instanceof Problem) return { ok: false, problem: error.message };
		return { ok: false, problem: `Unexpected data: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Code points, so a limit counts what the reader sees rather than UTF-16 units. */
export function length(text: string): number {
	let count = 0;
	for (const _ of text) count += 1;
	return count;
}

export function record(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Problem(`${what} must be an object.`);
	return value as Record<string, unknown>;
}

export function list(value: unknown, what: string, min: number, max: number): readonly unknown[] {
	if (!Array.isArray(value)) throw new Problem(`${what} must be a list.`);
	if (value.length < min) throw new Problem(`${what} needs at least ${min}.`);
	if (value.length > max) throw new Problem(`${what} has ${value.length}; the limit is ${max}.`);
	return value;
}

export function text(value: unknown, what: string, max: number): string {
	if (typeof value !== "string" || value.trim() === "") throw new Problem(`${what} must be non-empty text.`);
	const size = length(value);
	if (size > max) throw new Problem(`${what} has ${size} characters; the limit is ${max}.`);
	return value;
}

export function optionalText(value: unknown, what: string, max: number): string | undefined {
	return value === undefined ? undefined : text(value, what, max);
}

export function choice<T extends string>(value: unknown, what: string, options: readonly T[], fallback: T): T {
	if (value === undefined) return fallback;
	if (typeof value === "string" && (options as readonly string[]).includes(value)) return value as T;
	throw new Problem(`${what} must be one of: ${options.join(", ")}.`);
}

export function flag(value: unknown, what: string): boolean {
	if (value === undefined) return false;
	if (typeof value !== "boolean") throw new Problem(`${what} must be true or false.`);
	return value;
}

export function finite(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Problem(`${what} must be a finite number.`);
	return value;
}
