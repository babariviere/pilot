import type { DashboardNeedsYouItem, DashboardSection } from "./index.ts";
import type { TrackedItem } from "./tracking.ts";

/** A needs-you row of the Inbox, with the project it belongs to. */
export interface InboxNeedsYouItem extends DashboardNeedsYouItem {
	projectId: string;
}

/** Open Slack messages left out of the Inbox by a project label marked "Hide from Inbox". */
export interface InboxHiddenLabel {
	label: string;
	count: number;
}

/**
 * GET /api/inbox?projectId=...&limit=...: everything waiting on the user, across every project or within one.
 * Bounded to `limit` rows per section (default 50, at most 100). Read-only; rows keep their usual actions.
 */
export interface Inbox {
	/** Chats, missions and scheduled items that need the user, most urgent first, as on the project page. */
	needsYou: DashboardSection<InboxNeedsYouItem>;
	/** My Linear tickets that are not done or canceled: in progress first, then by priority.
	 * Absent when no project in scope has a Linear team. */
	linear?: DashboardSection<TrackedItem>;
	/** Open and in-progress Slack messages, without dismissed ones or hidden labels, most severe first.
	 * Absent when no project in scope tracks Slack channels. */
	slack?: DashboardSection<TrackedItem> & { hidden: InboxHiddenLabel[] };
}
