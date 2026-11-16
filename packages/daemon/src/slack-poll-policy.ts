/** Historical diagnostic fields only. Slack has no local hourly admission cap. */
export const SLACK_HOURLY_BUDGET = 100;
export const SLACK_BUDGET_WINDOW_MS = 3_600_000;
export const SLACK_REACTION_BATCH = 8;
/** Waiting messages per pass, and the delay between reads of the same waiting thread. */
export const SLACK_WAITING_BATCH = 4;
export const SLACK_WAITING_INTERVAL_MS = 10 * 60_000;
/** An open item's reaction is checked at most this often. */
export const SLACK_REACTION_RECHECK_MS = 3_600_000;
