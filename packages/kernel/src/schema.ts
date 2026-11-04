import { Type } from "typebox";

/** A JSON string enum retaining TypeBox inference for native and Durable tools. */
export function StringEnum<const T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
