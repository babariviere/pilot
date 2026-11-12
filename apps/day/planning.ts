// The only path between the planning screens and Rust: a typed read model
// mirrored in one signal, and typed intents on the feed. Like Today's feed,
// it has no transport, and nsh.json denies network, sockets, files and
// processes.
import { type Signal, signal } from "nsh";
import { PlanFeed, type Planning, type PlanScenario } from "pilot-day/native";
import { changesRoute } from "./changesView";
import { DEMO_PROJECTS, ScriptedChats } from "./chatDemo";
import { type ChatMirror, mirrorChats } from "./chatFeed";
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
	/** New's projects and standalone chats: the root's in the connected window, a script in the mock ones. */
	chats: ChatMirror;
	/** Stops listening and frees the feed. */
	close: () => void;
};

/**
 * Opens a mock planning feed from `scenario` and mirrors its read model.
 * Its New offers invented demo projects; a demo chat is only a counter.
 */
export function openPlanning(scenario?: PlanScenario): Plans {
	const feed = new PlanFeed(scenario);
	const off = () => {
		const now = feed.snapshot();
		return now.canStart ? "" : now.startReason || "Starting a chat is not available here.";
	};
	return mirrorPlanning(feed, mirrorChats(new ScriptedChats(DEMO_PROJECTS, DEMO_PROJECTS[0].projectId, off)));
}

/** Mirrors `feed`'s planning read, mock or connected. Closing stops listening and frees the feed. */
export function mirrorPlanning(feed: PlanningFeed, chats: ChatMirror): Plans {
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
		chats,
		close: () => {
			stop();
			feed.dispose();
			chats.close();
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
