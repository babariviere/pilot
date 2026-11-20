export interface ContextUsage {
	tokens?: number;
	contextWindow: number;
	percent?: number;
}

export interface SubscriptionUsage {
	/** Epoch ms of the provider snapshot, not the time it was forwarded. */
	fetchedAt: number;
	provider?: "anthropic" | "openai";
	windows: Array<{ label: string; usedPercent: number; resetsAt?: string }>;
	error?: string;
}

/** Provider-reported token classes. Reasoning is a subset of output and must not be added again. */
export interface AIUsageTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	reasoningStatus: "reported" | "partial" | "unavailable";
}

/** Cost semantics are explicit: catalog estimates are never presented as billed or marginal subscription spend. */
export interface AIUsageCost {
	estimateStatus: "catalog_estimate" | "partial_catalog_estimate" | "unavailable";
	estimatedUsdMicros?: number;
	/** The model catalog version that produced an estimate. */
	pricingRevision?: string;
	billedStatus: "known" | "unavailable";
	billedUsdMicros?: number;
	subscriptionCoverage: "covered" | "not_covered" | "unknown";
}

export interface AIUsageActivity {
	/** Direct model requests, or usage-bearing child/tool operations as identified by `kind`. */
	kind: "model_requests" | "child_operations";
	count: number;
	success: number;
	failure: number;
	cancelled: number;
	usageReports: number;
	/** Physical HTTP attempts observed in this process family. May omit a crash before publication. */
	providerAttemptsObserved: number;
	/** Retries within observed provider requests. This is partial when a process exits before publishing timing. */
	requestRetriesObserved: number;
	elapsedMsObserved: number;
	activeMsObserved: number;
	outcomeCoverage: "partial";
	timingCoverage: "partial";
}

export interface AIUsageEfficiencyScope {
	/** Positive cumulative usage changes observed after the daemon established a durable baseline. */
	observations: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Cache-read tokens divided by input plus cache-read tokens. Keep both values for honest aggregation. */
	cacheEfficiencyNumerator: number;
	cacheEfficiencyDenominator: number;
	coverage: "daemon_observed_deltas_partial";
}

export type AIWorkerLaunchReason =
	| "initial"
	| "parked_wake"
	| "user_resume"
	| "crash_recovery"
	| "startup_retry"
	| "replacement"
	| "unknown";

export interface AIUsageEfficiency {
	direct: AIUsageEfficiencyScope;
	child: AIUsageEfficiencyScope;
	context?: {
		observedAt: number;
		tokens: number;
		contextWindow: number;
		headroomTokens: number;
		percent: number;
		coverage: "latest_observation";
	};
	compaction: {
		count: number;
		pairedMeasurements: number;
		beforeTokens: number;
		afterTokens: number;
		tokensRemoved: number;
		timingStatus: "unavailable";
		coverage: "epoch_observed_partial";
	};
	relaunch: {
		count: number;
		reasons: Record<AIWorkerLaunchReason, number>;
		lastObservedAt?: number;
		contextPreparationsObserved: number;
		contextTokensPrepared: number;
		estimatedCostStatus: "unavailable";
		coverage: "daemon_observed_partial";
	};
}

export interface AIUsageScope {
	tokens: AIUsageTokens;
	cost: AIUsageCost;
	activity: AIUsageActivity;
}

/** Durable, bounded, content-free accounting for one chat across its attempts and worker restarts. */
export interface AIUsageAccounting {
	observedAt: number;
	direct: AIUsageScope;
	child: AIUsageScope;
	/** Daemon-observed lifecycle time. Gaps while pilotd was not running are not invented. */
	time: {
		elapsedMs: number;
		activeMs: number;
		pausedMs: number;
		idleMs: number;
		coverage: "daemon_observed_partial";
	};
	/** Context/cache and worker-launch observations. Missing means an older daemon has no efficiency evidence. */
	efficiency?: AIUsageEfficiency;
}

export interface SessionUsage {
	context?: ContextUsage;
	subscription?: SubscriptionUsage;
	ai?: AIUsageAccounting;
}

export interface SubscriptionPauseWindow {
	provider: "anthropic" | "openai";
	label: string;
	usedPercent: number;
	resetsAt?: string;
}

export interface SubscriptionPause {
	windows: SubscriptionPauseWindow[];
	/** User explicitly allowed this chat and its children past these windows, until reset. */
	forced?: boolean;
}
