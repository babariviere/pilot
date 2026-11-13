// The only path between the Changes screens and Rust: a typed read model
// mirrored in one signal, and typed intents on the feed. Like Today's feed,
// it has no transport, and nsh.json denies network, sockets, files and
// processes.
import type { Signal } from "nsh";
import type { ChangeList, ChangesFeed } from "pilot-day/native";

/** Kept changes as Rust last published them, and the feed to act on them. */
export type Changes = {
	/** Sends intents. Never written to from TSX state. */
	feed: ChangesFeed;
	/** A mirror of Rust's list. Only the feed's listener sets it. */
	list: Signal<ChangeList>;
	/** Stops listening and frees the feed. */
	close: () => void;
};
