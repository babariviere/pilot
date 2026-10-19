import type { FeatureEvent, FeatureName } from "./feature-events.ts";
import type { OperationHost } from "./operations.ts";

/** Aggregate cells only. No transcript, session, event ID, event timestamp or free text. */
export type FeatureUsageCell = FeatureEvent & { day: string; count: number };
export interface FeatureUsageBatch {
	schemaVersion: 1;
	epoch: string;
	producer: string;
	revision: number;
	startedAt: string;
	observedAt: string;
	cells: FeatureUsageCell[];
	dropped: number;
}
export interface FeatureUsageSnapshot {
	schemaVersion: 1;
	host: OperationHost;
	catalogVersion: 1;
	features: readonly FeatureName[];
	scope: "native_ui_observations_across_chats";
	status: "disabled" | "unavailable" | "partial";
	reason?: "no_producer" | "storage_unavailable";
	collectedAt: string;
	enabledAt?: string;
	observedFrom?: string;
	observedThrough?: string;
	retentionDays: 7;
	retainedFrom: string;
	producerLimit: 16;
	prunedProducers: number;
	dropped: number;
	/** Only positive observed cells. Missing cells/stages/days are unknown, NOT zero. */
	cells: FeatureUsageCell[];
}
