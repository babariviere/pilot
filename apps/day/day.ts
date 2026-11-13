// The only path between the Today screen and Rust: a typed read model
// mirrored in one signal, and typed intents on the feed. The feed has no
// transport, and nsh.json denies network, sockets, files and processes.
import { type Signal, signal } from "nsh";
import { type Scenario, type Today, TodayFeed } from "pilot-day/native";
import type { ArtifactSource } from "./artifactReads";
import type { DeliveryMirror } from "./deliveryFeed";
import type { DayFeed } from "./feeds";
import type { IntakeMirror } from "./intakeFeed";
import type { LinearMirror } from "./linearFeed";
import { glide } from "./motion";
import type { PreferencesMirror } from "./preferencesFeed";
import type { ThreadsMirror } from "./threadFeed";
import type { ScopeMirror } from "./todayScope";

/** Today's read model as Rust last published it, and the feed to change it. */
export type Day = {
	/** Sends intents. Never written to from TSX state. */
	feed: DayFeed;
	/** A mirror of Rust's read model. Only the feed's listener sets it. */
	today: Signal<Today>;
	/**
	 * The New section's requests and their Later, Discard and Start. Only the
	 * connected window has them; the mock window shows Today's example rows.
	 */
	intake?: IntakeMirror;
	/**
	 * Delivered results and the user's Done, Send back and Reopen. Only the
	 * connected window has them; the mock window shows no To check.
	 */
	delivery?: DeliveryMirror;
	/**
	 * The user's saved Linear issues and the cycle Pilot last read, for the
	 * read-only Linear page. Only the connected window has them.
	 */
	linear?: LinearMirror;
	/**
	 * Today's cross-project read for the window's project scope. Without it,
	 * Today shows only the window's own project and offers no scope.
	 */
	scope?: ScopeMirror;
	/**
	 * The window's own project's preferences, for Settings. Without them the
	 * window offers no Settings.
	 */
	preferences?: PreferencesMirror;
	/**
	 * Missions' focused threads with their coordinator. Without them a
	 * mission's overview offers no threads.
	 */
	threads?: ThreadsMirror;
	/**
	 * Saved artifacts of the window's project and its missions. Without them
	 * the window offers no Artifacts page or mission section.
	 */
	artifacts?: ArtifactSource;
	/** Stops listening and frees the feed. */
	close: () => void;
};

/** Opens a mock feed from `scenario` and mirrors its read model. */
export function openDay(scenario?: Scenario): Day {
	return mirrorDay(new TodayFeed(scenario));
}

/** Mirrors `feed`'s read model, mock or connected. Closing stops listening and frees the feeds. */
export function mirrorDay(
	feed: DayFeed,
	intake?: IntakeMirror,
	delivery?: DeliveryMirror,
	linear?: LinearMirror,
	scope?: ScopeMirror,
	preferences?: PreferencesMirror,
	threads?: ThreadsMirror,
	artifacts?: ArtifactSource,
): Day {
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
		intake,
		delivery,
		linear,
		scope,
		preferences,
		threads,
		artifacts,
		close: () => {
			stop();
			feed.dispose();
			intake?.close();
			delivery?.close();
			linear?.close();
			preferences?.close();
			threads?.close();
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
