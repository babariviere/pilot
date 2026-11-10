// The only path between the planning screens and Rust: a typed read model
// mirrored in one signal, and typed intents on the feed. Like Today's feed,
// it has no transport, and nsh.json denies network, sockets, files and
// processes.
import { type Signal, signal } from "nsh";
import { PlanFeed, type PlanScenario, type Planning } from "pilot-day/native";
import { changesRoute } from "./changesView";
import type { PlanningFeed } from "./feeds";
import { glide } from "./motion";
import { planRoute } from "./planView";
import { ritualRoute } from "./ritualView";
import { route } from "./view";

/** Planning's read model as Rust last published it, and the feed to change it. */
export type Plans = {
	/** Sends intents. Never written to from TSX state. */
	feed: PlanningFeed;
	/** A mirror of Rust's read model. Only the feed's listener sets it. */
	planning: Signal<Planning>;
	/** Stops listening and frees the feed. */
	close: () => void;
};

/** Opens a mock planning feed from `scenario` and mirrors its read model. */
export function openPlanning(scenario?: PlanScenario): Plans {
	return mirrorPlanning(new PlanFeed(scenario));
}

/** Mirrors `feed`'s planning read, mock or connected. Closing stops listening and frees the feed. */
export function mirrorPlanning(feed: PlanningFeed): Plans {
	const planning = signal(feed.snapshot());
	const stop = feed.onChange((next) => {
		// On Today, missions that arrive in or leave the list, or change stage,
		// glide to their places. Saves and typing do not move anything, and an
		// open interview, mission, Changes or ritual never glides because of the list.
		if (todayShown() && shape(next) !== shape(planning())) glide();
		planning.set(next);
	});
	return {
		feed,
		planning,
		close: () => {
			stop();
			feed.dispose();
		},
	};
}

/** Whether the list can be read, and which missions it lists at which stage: what a glide follows. */
function shape(p: Planning): string {
	return [p.availability, ...p.plans.map((row) => `${row.missionId}:${row.stage}`)].join(",");
}

/** Whether Today is the screen shown. */
function todayShown(): boolean {
	return planRoute() === null && route() === null && !changesRoute() && !ritualRoute();
}
