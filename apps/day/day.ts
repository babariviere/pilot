// The only path between the Today screen and Rust: a typed read model
// mirrored in one signal, and typed intents on the feed. The feed has no
// transport, and nsh.json denies network, sockets, files and processes.
import { type Signal, signal } from "nsh";
import { type Scenario, type Today, TodayFeed } from "pilot-day/native";

/** Today's read model as Rust last published it, and the feed to change it. */
export type Day = {
	/** Sends intents. Never written to from TSX state. */
	feed: TodayFeed;
	/** A mirror of Rust's read model. Only the feed's listener sets it. */
	today: Signal<Today>;
	/** Stops listening and frees the feed. */
	close: () => void;
};

/** Opens a mock feed from `scenario` and mirrors its read model. */
export function openDay(scenario?: Scenario): Day {
	const feed = new TodayFeed(scenario);
	const today = signal(feed.snapshot());
	const stop = feed.onChange((next) => today.set(next));
	return {
		feed,
		today,
		close: () => {
			stop();
			feed.dispose();
		},
	};
}
