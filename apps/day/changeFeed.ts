// The only path between the Changes screens and Rust: a typed read model
// mirrored in one signal, and typed intents on the feed. Like Today's feed,
// it has no transport, and nsh.json denies network, sockets, files and
// processes.
import { type Signal, signal } from "nsh";
import { type ChangeList, ChangesFeed, type ChangesScenario } from "pilot-day/native";

/** Kept changes as Rust last published them, and the feed to act on them. */
export type Changes = {
	/** Sends intents. Never written to from TSX state. */
	feed: ChangesFeed;
	/** A mirror of Rust's list. Only the feed's listener sets it. */
	list: Signal<ChangeList>;
	/** Stops listening and frees the feed. */
	close: () => void;
};

/** Opens a mock Changes feed from `scenario` and mirrors its list. */
export function openChanges(scenario?: ChangesScenario): Changes {
	const feed = new ChangesFeed(scenario);
	const list = signal(feed.snapshot());
	const stop = feed.onChange((next) => list.set(next));
	return {
		feed,
		list,
		close: () => {
			stop();
			feed.dispose();
		},
	};
}
