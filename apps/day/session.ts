// The app's feeds. Kept in their own module so edits to the screens hot
// update without restarting the feeds or losing Rust's state.
import { openChanges } from "./changeFeed";
import { openDay } from "./day";
import { openPlanning } from "./planning";
import { openUpdate } from "./updateFeed";

/** The running app's feed: the decisions world. */
export const day = openDay();
/** The running app's planning feed: one mission interview in progress. */
export const plans = openPlanning();
/** The running app's Changes feed: kept changes in every state. */
export const changes = openChanges();
/** The running app's update feed: Pilot's service, up to date. */
export const update = openUpdate();
