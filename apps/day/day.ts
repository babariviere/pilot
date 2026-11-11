// The only path between the Today screen and Rust: a typed read model
// mirrored in one signal, and typed intents on the feed. The feed has no
// transport, and nsh.json denies network, sockets, files and processes.
import { type Signal, signal } from "nsh";
import { type Scenario, type Today, TodayFeed } from "pilot-day/native";
import type { DayFeed } from "./feeds";
import { glide } from "./motion";

/** Today's read model as Rust last published it, and the feed to change it. */
export type Day = {
	/** Sends intents. Never written to from TSX state. */
	feed: DayFeed;
	/** A mirror of Rust's read model. Only the feed's listener sets it. */
	today: Signal<Today>;
	/** Stops listening and frees the feed. */
	close: () => void;
};

/** Opens a mock feed from `scenario` and mirrors its read model. */
export function openDay(scenario?: Scenario): Day {
	return mirrorDay(new TodayFeed(scenario));
}

/** Mirrors `feed`'s read model, mock or connected. Closing stops listening and frees the feed. */
export function mirrorDay(feed: DayFeed): Day {
	const today = signal(feed.snapshot());
	const stop = feed.onChange((next) => {
		// Items that arrive or leave, and missions that change group, glide to
		// their places. Text and state changes in place do not move anything.
		if (shape(next) !== shape(today())) glide();
		today.set(next);
	});
	return {
		feed,
		today,
		close: () => {
			stop();
			feed.dispose();
		},
	};
}

/** Which items wait and which group each mission is in: what a glide follows. */
function shape(t: Today): string {
	return [
		t.decisions.map((d) => d.id).join(","),
		t.actions.map((a) => a.id).join(","),
		t.moving.map((m) => m.id).join(","),
		t.notMoving.map((m) => m.id).join(","),
		t.unreported.map((m) => m.id).join(","),
		t.intake.requests.map((r) => r.id).join(","),
	].join("|");
}
