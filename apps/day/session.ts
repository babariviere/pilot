// The app's feeds. Kept in their own module so edits to the screens hot
// update without restarting the feeds or losing Rust's state.
import { TodayFeed } from "pilot-day/native";
import { openChanges } from "./changeFeed";
import { mirrorDay } from "./day";
import { ScriptedDelivery } from "./deliveryDemo";
import { mirrorDelivery } from "./deliveryFeed";
import { ScriptedLinear } from "./linearDemo";
import { mirrorLinear } from "./linearFeed";
import { openPlanning } from "./planning";
import { ScriptedPreferences } from "./preferencesDemo";
import { mirrorPreferences } from "./preferencesFeed";
import { openUpdate } from "./updateFeed";

/** The running app's feed: the decisions world, with demo results to check, saved Linear issues and preferences. */
export const day = mirrorDay(
	new TodayFeed(),
	undefined,
	mirrorDelivery(new ScriptedDelivery()),
	mirrorLinear(new ScriptedLinear()),
	undefined,
	mirrorPreferences(new ScriptedPreferences()),
);
/** The running app's planning feed: one mission interview in progress. */
export const plans = openPlanning();
/** The running app's Changes feed: kept changes in every state. */
export const changes = openChanges();
/** The running app's update feed: Pilot's service, up to date. */
export const update = openUpdate();
