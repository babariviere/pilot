// The only path between the planning screens and Rust: a typed read model
// mirrored in one signal, and typed intents on the feed. Like Today's feed,
// it has no transport, and nsh.json denies network, sockets, files and
// processes.
import { type Signal, signal } from "nsh";
import { PlanFeed, type PlanScenario, type Planning } from "pilot-day/native";

/** Planning's read model as Rust last published it, and the feed to change it. */
export type Plans = {
	/** Sends intents. Never written to from TSX state. */
	feed: PlanFeed;
	/** A mirror of Rust's read model. Only the feed's listener sets it. */
	planning: Signal<Planning>;
	/** Stops listening and frees the feed. */
	close: () => void;
};

/** Opens a mock planning feed from `scenario` and mirrors its read model. */
export function openPlanning(scenario?: PlanScenario): Plans {
	const feed = new PlanFeed(scenario);
	const planning = signal(feed.snapshot());
	const stop = feed.onChange((next) => planning.set(next));
	return {
		feed,
		planning,
		close: () => {
			stop();
			feed.dispose();
		},
	};
}
