// Planning's data mirror. Navigation and animation belong to the window.
import { type Signal, signal } from "nsh";
import type { Planning } from "pilot-day/native";
import type { ChatMirror } from "./chatFeed";
import type { PlanningFeed } from "./feeds";

/** Planning's read model as Rust last published it, and the feed to change it. */
export type Plans = {
	/** Sends intents. Never written to from TSX state. */
	feed: PlanningFeed;
	/** A mirror of Rust's read model. Only the feed's listener sets it. */
	planning: Signal<Planning>;
	/** New's projects and standalone chats: the root's in the connected window, a script in the mock ones. */
	chats: ChatMirror;
	/** Stops listening and frees the feed. */
	close: () => void;
};

/** Mirrors `feed`'s planning read, mock or connected. Closing stops listening and frees the feed. */
export function mirrorPlanning(feed: PlanningFeed, chats: ChatMirror): Plans {
	const planning = signal(feed.snapshot());
	const stop = feed.onChange((next) => planning.set(next));
	return {
		feed,
		planning,
		chats,
		close: () => {
			stop();
			feed.dispose();
			chats.close();
		},
	};
}

/** Whether the list can be read, and which missions it lists at which stage: what a glide follows. */
export function planningListShape(p: Planning): string {
	return [p.availability, ...p.plans.map((row) => `${row.missionId}:${row.stage}`)].join(",");
}
