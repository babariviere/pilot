// The only path between the update page and Rust: Pilot's service as a
// typed read model mirrored in one signal, and typed intents on the feed.
// Like the other feeds it has no transport, and nsh.json denies network,
// sockets, files and processes. The test-only mock feed (mockFeeds.tsx)
// registers, updates and restarts nothing real.
import type { Signal } from "nsh";
import type { IntentOutcome, Prepared, PrepareIntent, ServiceView, UpdateFeed, UpdateRef } from "pilot-day/native";

/** Pilot's service as Rust last published it, and the feed to act on it. */
export type Update = {
	/**
	 * Sends intents. Never written to from TSX state. The connected root
	 * answers `prepare` and `cancel` asynchronously; the mock at once.
	 */
	feed: Pick<UpdateFeed, "snapshot" | "onChange" | "confirm" | "forceConfirm" | "check" | "restored"> & {
		prepare(intent: PrepareIntent): Prepared | Promise<Prepared>;
		cancel(intent: UpdateRef): IntentOutcome | Promise<IntentOutcome>;
	};
	/** A mirror of Rust's view. Only the feed's listener sets it. */
	service: Signal<ServiceView>;
	/** Stops listening and frees the feed. */
	close: () => void;
};
