export type RefreshStage = "discovery" | "classification" | "commit" | "waiting_replies" | "reaction_reads";
export type RefreshOutcome = "success" | "partial" | "failure" | "budget_limited" | "cancelled";
export type RefreshReason =
	| "sign_in"
	| "provider_rate_limit"
	| "local_classification_budget"
	| "local_read_budget"
	| "channel_read"
	| "classification_failed"
	| "classifier_unavailable"
	| "batch_limit"
	| "timeout"
	| "config_changed"
	| "stopped"
	| "delivery_deferred"
	| "read_failed"
	| "unknown";
/** Internal producer only, never accepted from a diagnostic reader or model. */
export interface RefreshObservation {
	stage: RefreshStage;
	phase: "started" | "completed" | "partial";
	outcome?: RefreshOutcome;
	reason?: RefreshReason;
	channelIndex?: number;
	count?: number;
}
export interface RefreshStageHealth {
	stage: RefreshStage;
	lastStartedAt?: number;
	lastCompletedAt?: number;
	lastSucceededAt?: number;
	outcome?: RefreshOutcome;
	reason?: RefreshReason;
	channelIndex?: number;
	/** Stage-scoped observed work count, not necessarily new items. */
	count?: number;
}
export interface RefreshLiveHealth {
	lastAttemptAt: number;
	lastStartedAt: number;
	lastCompletedAt?: number;
	lastCommittedAt?: number;
	returnedItems?: number;
	outcome?: RefreshOutcome;
	reason?: RefreshReason;
	stages: RefreshStageHealth[];
}
