import type { LinearSize } from "@pilot/protocol";

export const LINEAR_SIZES = ["quick_fix", "needs_planning", "unknown"] as const satisfies readonly LinearSize[];

export function isLinearSize(value: unknown): value is LinearSize {
	return LINEAR_SIZES.some((size) => size === value);
}
