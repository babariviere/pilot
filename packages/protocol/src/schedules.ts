import type { SpawnRequest } from "./index.ts";

/** on_back is wake followed by reachability ("When I'm back"). All triggers are one-shot. */
export type ScheduleTrigger = "at" | "on_wake" | "on_online" | "on_back";
export type ScheduleTarget =
	| {
			kind: "chat";
			spawn: SpawnRequest;
			/** Bound to the created chat on dispatch. */
			trackedItemId?: string;
	  }
	| { kind: "message"; sessionId: string; message: string };
export type ScheduleState = "pending" | "dispatching" | "fired" | "failed" | "cancelled";

/** POST /api/schedules. Omitted trigger defaults to on_back. */
export interface ScheduleRequest {
	title?: string;
	trigger?: ScheduleTrigger;
	/** Epoch milliseconds. Required only for at; overdue times fire when online. */
	at?: number;
	target: ScheduleTarget;
}
/** PATCH /api/schedules/:id. Only pending items are editable. Target replacement is complete. */
export interface SchedulePatch {
	title?: string;
	trigger?: ScheduleTrigger;
	at?: number;
	target?: ScheduleTarget;
	/** Optional optimistic concurrency guard against a stale editor. */
	expectedRevision?: number;
}
export interface ScheduledItem {
	id: string;
	revision: number;
	title: string;
	projectId?: string;
	trigger: ScheduleTrigger;
	at?: number;
	target: ScheduleTarget;
	state: ScheduleState;
	createdAt: number;
	updatedAt: number;
	/** Persisted so a wake while offline survives a restart. */
	wakeObserved?: boolean;
	claimedAt?: number;
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
