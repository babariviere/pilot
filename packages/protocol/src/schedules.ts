import type { SpawnRequest } from "./index.ts";
import type { InsightsReviewDispatch, InsightsReviewRun } from "./insights.ts";

/** Calendar deadlines, stored and executed on one host. */
export type ScheduleTrigger = "at" | "recurring";
export interface ScheduleRecurrence {
	every: "day" | "week" | "month";
	time: string;
	timeZone: string;
	weekdays?: number[];
	weekday?: number;
	dayOfMonth?: number;
}
export interface ScheduleRun {
	due: number;
	at: number;
	outcome: "started" | "sent" | "skipped_running" | "missed" | "failed";
	late?: true;
	sessionId?: string;
	count?: number;
	error?: string;
	/** Exact host-reserved review identity. Sent is placement, partial is bounded persistence only. */
	insightsReview?: { runId: string; state: InsightsReviewRun["state"] | "unresolved" };
}
export interface ScheduleHome {
	daemonId: string;
	lineageId: string;
}
export type ScheduleTarget =
	| {
			kind: "chat";
			spawn: SpawnRequest;
			/** Bound to the created chat on dispatch. */
			trackedItemId?: string;
	  }
	| { kind: "message"; sessionId: string; message: string };
export type ScheduleState = "pending" | "dispatching" | "fired" | "failed" | "cancelled";

/** POST /api/schedules. Recurring rules require recurrence and expectedHome, not at. */
export interface ScheduleRequest {
	title?: string;
	trigger: ScheduleTrigger;
	/** Epoch milliseconds. Overdue times fire when online. */
	at?: number;
	recurrence?: ScheduleRecurrence;
	expectedHome?: ScheduleHome;
	target: ScheduleTarget;
}
/** PATCH /api/schedules/:id. Only pending items are editable. Target replacement is complete. */
export interface SchedulePatch {
	title?: string;
	trigger?: ScheduleTrigger;
	at?: number;
	target?: ScheduleTarget;
	recurrence?: ScheduleRecurrence;
	paused?: boolean;
	dismissNotice?: true;
	expectedHome?: ScheduleHome;
	/** Optional optimistic concurrency guard against a stale editor. */
	expectedRevision?: number;
}
export interface ScheduledItem {
	id: string;
	revision: number;
	title: string;
	projectId?: string;
	/** Removed triggers are a non-executable tombstone on cancelled records. */
	trigger: ScheduleTrigger | "removed";
	at?: number;
	recurrence?: ScheduleRecurrence;
	handledThrough?: number;
	runs?: ScheduleRun[];
	notice?: ScheduleRun;
	paused?: true;
	target: ScheduleTarget;
	state: ScheduleState;
	createdAt: number;
	updatedAt: number;
	claimedAt?: number;
	/** Host-derived fixed-chat intent. Never grants access or downgrades to a generic send. */
	insightsDestination?: { sessionId: string; projectId: string; missionId: string };
	/** Host-only setup provenance. Not history authority or review-completion evidence. */
	insightsEnableOperationId?: string;
	/** Daemon-owned occurrence claim, retained across uncertain delivery and restart. */
	insightsReview?: { sessionId: string; request: InsightsReviewDispatch };
	firedAt?: number;
	/** Created chat, or target of a follow-up. */
	sessionId?: string;
	error?: string;
}
/** Full bounded index on connect and after changes. Terminal rows retained until DELETE. */
export interface SchedulesMessage {
	type: "schedules";
	schedules: ScheduledItem[];
}
