import type { SpawnRequest } from "./index.ts";

/** on_back is sleep after save/edit, then a full wake followed by reachability ("When I'm back"). All triggers are one-shot. */
export type ScheduleTrigger = "at" | "on_wake" | "on_online" | "on_back" | "on_join_network" | "on_leave_network";
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
	/** Exact, case-sensitive Wi-Fi names (1–32 entries). Only for network triggers. */
	networkNames?: string[];
	target: ScheduleTarget;
}
/** PATCH /api/schedules/:id. Only pending items are editable. Target replacement is complete. */
export interface SchedulePatch {
	title?: string;
	trigger?: ScheduleTrigger;
	at?: number;
	networkNames?: string[];
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
	networkNames?: string[];
	target: ScheduleTarget;
	state: ScheduleState;
	createdAt: number;
	updatedAt: number;
	/** Persisted so a full wake while offline survives a restart. Requires sleepObserved. */
	wakeObserved?: boolean;
	/** A sleep after the last save/edit. Dark wakes do not consume this latch. */
	sleepObserved?: boolean;
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

/** Local Wi-Fi picker state. null means disconnected only when authorized and available. */
export interface WiFiStatus {
	authorization: "not_determined" | "authorized" | "denied" | "restricted" | "disabled" | "unavailable";
	available: boolean;
	currentNetwork: string | null;
	knownNetworks: string[];
	/** Static diagnostic, never includes a network name. */
	error?: string;
}
