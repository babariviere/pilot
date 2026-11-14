// The mock fixture entries' feeds (MockApp.tsx, Update.tsx): test support only,
// every record invented. Kept in their own module so edits to the screens hot
// update without restarting the feeds or losing Rust's state.
import { TodayFeed } from "pilot-day/native";
import { mirrorDay } from "./day";
import { ScriptedDelivery } from "./deliveryDemo";
import { mirrorDelivery } from "./deliveryFeed";
import { ScriptedLinear } from "./linearDemo";
import { mirrorLinear } from "./linearFeed";
import { openChanges, openMockChat, openPlanning, openUpdate } from "./mockFeeds";
import { ScriptedPreferences } from "./preferencesDemo";
import { mirrorPreferences } from "./preferencesFeed";
import { ScriptedThreads } from "./threadDemo";
import { mirrorThreads } from "./threadFeed";

/**
 * The mock app's feed: the decisions world, with demo results to check, saved Linear issues, preferences,
 * threads and read-only chats.
 */
export const day = mirrorDay(
	new TodayFeed(),
	undefined,
	mirrorDelivery(new ScriptedDelivery()),
	mirrorLinear(new ScriptedLinear()),
	undefined,
	mirrorPreferences(new ScriptedPreferences()),
	mirrorThreads(new ScriptedThreads()),
	undefined,
	undefined,
	openMockChat(),
);
/** The mock app's planning feed: one mission interview in progress. */
export const plans = openPlanning();
/** The mock app's Changes feed: kept changes in every state. */
export const changes = openChanges();
/** The mock app's update feed: Pilot's service, up to date. */
export const update = openUpdate();
