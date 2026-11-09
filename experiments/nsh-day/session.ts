// The app's one feed. Kept in its own module so edits to the screens hot
// update without restarting the feed or losing Rust's state.
import { openDay } from "./day";

/** The running app's feed: the decisions world. */
export const day = openDay();
