import type { TrackingJson } from "@pilot/protocol";

export type ObjectJson = Record<string, TrackingJson>;

export function object(value: TrackingJson): ObjectJson {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected Linear object");
	return value;
}

export function string(value: TrackingJson | undefined, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid Linear text");
	return value;
}
