// The mock fixture entries' feeds (MockApp.tsx, Update.tsx): test support only,
// every record invented. Kept in their own module so edits to the screens hot
// update without restarting the feeds or losing Rust's state.
import { TodayFeed } from "pilot-day/native";
import { ScriptedDelivery } from "../../missions/delivery/deliveryDemo";
import { mirrorDelivery } from "../../missions/delivery/deliveryFeed";
import { ScriptedThreads } from "../../sessions/threadDemo";
import { mirrorThreads } from "../../sessions/threadFeed";
import { ScriptedPreferences } from "../../settings/preferencesDemo";
import { mirrorPreferences } from "../../settings/preferencesFeed";
import { ScriptedLinear } from "../../sources/linear/linearDemo";
import { mirrorLinear } from "../../sources/linear/linearFeed";
import { mirrorDay } from "../day";
import { openChanges, openMockChat, openPlanning, openUpdate } from "./mockFeeds";

/**
 * The mock app's feed: the decisions world, with demo results to check, saved Linear issues, preferences,
 * threads and read-only chats.
 */
export const day = mirrorDay(new TodayFeed(), {
	delivery: mirrorDelivery(new ScriptedDelivery()),
	linear: mirrorLinear(new ScriptedLinear()),
	preferences: mirrorPreferences(new ScriptedPreferences()),
	threads: mirrorThreads(new ScriptedThreads()),
	chat: openMockChat(),
});
/** The mock app's planning feed: one mission interview in progress. */
export const plans = openPlanning();
/** The mock app's Changes feed: kept changes in every state. */
export const changes = openChanges();
/** The mock app's update feed: Pilot's service, up to date. */
export const update = openUpdate();
