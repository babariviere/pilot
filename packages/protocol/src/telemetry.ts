/** Optional host-local diagnostic comparison. It is never an execution or provider-quota control. */
export interface AIUsageBudget {
	basis: "catalog_estimate" | "billed";
	/** Positive integer USD microdollars. There is deliberately no default. */
	limitUsdMicros: number;
	/** The existing bounded accounting retained with one chat, not a calendar or billing period. */
	window: "retained_chat";
}

export interface AIUsageBudgetComparison {
	basis: AIUsageBudget["basis"];
	limitUsdMicros: number;
	window: AIUsageBudget["window"];
	comparison: "below" | "equal" | "above" | "indeterminate" | "unavailable";
	/** Sum available for the selected basis. Partial values are lower bounds, never zero-filled totals. */
	observedUsdMicros?: number;
	coverage: "complete_for_retained_usage" | "partial_retained_usage" | "unavailable";
	subscriptionCoverage: "covered" | "not_covered" | "unknown";
	informational: true;
}

/** Effective settings for one daemon host. Export and analytics are explicit, independent opt-ins. */
export interface TelemetrySettings {
	schemaVersion: 1;
	hostKind: "local" | "devbox";
	/** Pseudonymous host correlation. This is never a raw HostRef field. */
	hostId: string;
	localDiagnostics: boolean;
	/** Local-only Next capture privacy epoch; older hosts leave integrated collection unknown. */
	nextDiagnostics?: { schemaVersion: 1; epoch: number };
	/** Independent local-only aggregate collection, off by default. */
	localFeatureUsage?: boolean;
	/** Fences pending native snapshots after clear/revocation; never exported. */
	featureUsageEpoch?: string;
	remoteOperational: boolean;
	productAnalytics: boolean;
	/** Local app/daemon analytics identity. Present only on the local host while analytics consent is on. */
	analyticsId?: string;
	/** Present only after validation. Never contains userinfo, a query, fragment or credential. */
	endpoint?: string;
	/** Private host-local comparison configuration. It is not part of exported telemetry. */
	aiUsageBudget?: AIUsageBudget;
	updatedAt?: string;
}

export interface TelemetrySettingsPatch {
	localDiagnostics: boolean;
	/** Omit to preserve older clients' setting. */
	localFeatureUsage?: boolean;
	remoteOperational: boolean;
	productAnalytics: boolean;
	endpoint?: string;
	/** Omit to preserve an older client's value; null explicitly clears it. */
	aiUsageBudget?: AIUsageBudget | null;
}

export interface TelemetryClearResponse {
	cleared: true;
}

/** Private Local control, never remote telemetry or delivery evidence. */
export interface NextDiagnosticsControl {
	schemaVersion: 1;
	host: import("./index.ts").OperationHost;
	localDiagnostics: boolean;
	epoch: number;
}
