/**
 * When ordinary chats compact at model request boundaries, including tool loops. pi-durable's generation preparation
 * blocks on a threshold compaction above `contextWindow - reserveTokens`, measured as total input (the last provider
 * usage, which counts system prompt and tools, plus estimates of newer messages). Pilot sets that threshold to a fixed
 * target (100k) and lowers it only where the model window needs room for the answer.
 */
import type { CompactionPolicy } from "@earendil-works/pi-durable";

export const COMPACTION_TARGETS = {
	/** Compact once total input exceeds this, on any window large enough. */
	targetTokens: 100_000,
	/** Recent context kept verbatim; the Harness never splits a tool call from its result. */
	keepRecentTokens: 20_000,
	/** Digest budget in tokens. */
	digestTokens: 5_000,
	/** Room kept free for the answer on smaller windows: a fraction of the window, clamped. */
	reserveFraction: 0.2,
	minReserveTokens: 2_048,
	maxReserveTokens: 16_384,
	/** A target compaction is declined unless total input shrinks to at most this share. */
	maxAfterRatio: 0.6,
	/** After a declined target compaction, wait for this much growth before trying again. */
	backoffTokens: 20_000,
};
export type CompactionTargets = typeof COMPACTION_TARGETS;

export type PilotCompactionPolicy = {
	window: number;
	/** Above this, compaction is required for window safety and is never declined. */
	safety: number;
	/** Compaction starts above this. */
	trigger: number;
	keepRecentTokens: number;
	digestTokens: number;
	harness: CompactionPolicy;
};

/**
 * The policy for a model window. `backoffFrom` is the total input of the last declined target compaction: the
 * trigger moves above it by `backoffTokens` (hysteresis), never past the window safety threshold.
 */
export function compactionPolicy(
	window: number,
	backoffFrom?: number,
	targets: CompactionTargets = COMPACTION_TARGETS,
): PilotCompactionPolicy {
	const size = Number.isFinite(window) && window > 0 ? Math.floor(window) : 0;
	const reserve = Math.min(
		targets.maxReserveTokens,
		Math.max(targets.minReserveTokens, Math.floor(size * targets.reserveFraction)),
	);
	const safety = Math.max(0, size - reserve);
	const base = Math.min(targets.targetTokens, safety);
	const trigger =
		backoffFrom === undefined ? base : Math.min(Math.max(base, backoffFrom + targets.backoffTokens), safety);
	const keepRecentTokens = Math.max(256, Math.min(targets.keepRecentTokens, Math.floor(trigger * 0.25)));
	const digestTokens = Math.max(400, Math.min(targets.digestTokens, Math.floor(trigger * 0.06)));
	return {
		window: size,
		safety,
		trigger,
		keepRecentTokens,
		digestTokens,
		// No background compaction: the deterministic digest is cheap, so the request waits for it instead of
		// paying for one more oversized request.
		harness: { enabled: size > 0, reserveTokens: size - trigger, keepRecentTokens, backgroundTokens: 0 },
	};
}
