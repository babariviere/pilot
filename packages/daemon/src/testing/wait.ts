import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

/** Polls for an external result without depending on wall-clock changes. */
export async function until<T>(
	check: () => Promise<T | undefined>,
	{ timeoutMs, intervalMs, message }: { timeoutMs: number; intervalMs: number; message: string },
): Promise<T> {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value !== undefined) return value;
		if (performance.now() >= deadline) throw new Error(message);
		await delay(intervalMs);
	}
}
