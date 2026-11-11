// The only path between the update page and Rust: Pilot's service as a
// typed read model mirrored in one signal, and typed intents on the feed.
// Like the other feeds it has no transport, and nsh.json denies network,
// sockets, files and processes. The mock feed registers, updates and
// restarts nothing real.
import { type Signal, signal } from "nsh";
import {
	type IntentOutcome,
	type Prepared,
	type PrepareIntent,
	type ServiceView,
	type UpdateRef,
	UpdateFeed,
	type UpdateScenario,
} from "pilot-day/native";

/** Pilot's service as Rust last published it, and the feed to act on it. */
export type Update = {
	/**
	 * Sends intents. Never written to from TSX state. The connected root
	 * answers `prepare` and `cancel` asynchronously; the mock at once.
	 */
	feed: Pick<UpdateFeed, "snapshot" | "onChange" | "confirm" | "check" | "restored"> & {
		prepare(intent: PrepareIntent): Prepared | Promise<Prepared>;
		cancel(intent: UpdateRef): IntentOutcome | Promise<IntentOutcome>;
	};
	/** A mirror of Rust's view. Only the feed's listener sets it. */
	service: Signal<ServiceView>;
	/** Stops listening and frees the feed. */
	close: () => void;
};

/** Opens a mock update feed from `scenario` and mirrors its view. */
export function openUpdate(scenario?: UpdateScenario): Update {
	const feed = new UpdateFeed(scenario);
	const service = signal(feed.snapshot());
	const stop = feed.onChange((next) => service.set(next));
	return {
		feed,
		service,
		close: () => {
			stop();
			feed.dispose();
		},
	};
}
