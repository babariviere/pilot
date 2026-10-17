/** Closed, content-free feature-adoption catalog. Producers emit only after explicit analytics consent. */
export const FEATURE_CATALOG_VERSION = 1 as const;
export const FEATURE_EVENT_PROCESS_LIMIT = 128;

export const FEATURE_NAMES = ["diagnose_chat", "devbox_chat", "slack_triage"] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureStage = "eligibility" | "exposure" | "attempt" | "outcome";
export type FeatureAvailability = "available" | "not_configured" | "disconnected" | "unsupported";
export type FeatureOutcome = "success" | "failure" | "cancelled" | "unavailable";
export type FeatureReason =
	| "none"
	| "user"
	| "rejected"
	| "transport"
	| "unknown"
	| Exclude<FeatureAvailability, "available">;

interface FeatureEventBase {
	catalogVersion: typeof FEATURE_CATALOG_VERSION;
	feature: FeatureName;
}

export type FeatureEvent =
	| (FeatureEventBase & {
			stage: "eligibility";
			availability: FeatureAvailability;
			reason: "none" | Exclude<FeatureAvailability, "available">;
	  })
	| (FeatureEventBase & { stage: "exposure" | "attempt" })
	| (FeatureEventBase & {
			stage: "outcome";
			outcome: FeatureOutcome;
			reason: FeatureReason;
	  });

const FEATURES = new Set<string>(FEATURE_NAMES);
const BASE_KEYS = ["catalogVersion", "feature", "stage"];

function exactKeys(record: Record<string, unknown>, expected: string[]): boolean {
	return Object.keys(record).length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

/** Reject rather than redact unknown fields or invalid stage combinations. */
export function parseFeatureEvent(value: unknown): FeatureEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	if (
		record.catalogVersion !== FEATURE_CATALOG_VERSION ||
		typeof record.feature !== "string" ||
		!FEATURES.has(record.feature)
	)
		return;
	const feature = record.feature as FeatureName;
	if (record.stage === "exposure" || record.stage === "attempt") {
		if (!exactKeys(record, BASE_KEYS)) return;
		return { catalogVersion: FEATURE_CATALOG_VERSION, feature, stage: record.stage };
	}
	if (record.stage === "eligibility") {
		if (!exactKeys(record, [...BASE_KEYS, "availability", "reason"])) return;
		const availability = record.availability;
		if (
			availability !== "available" &&
			availability !== "not_configured" &&
			availability !== "disconnected" &&
			availability !== "unsupported"
		)
			return;
		if (record.reason !== (availability === "available" ? "none" : availability)) return;
		return {
			catalogVersion: FEATURE_CATALOG_VERSION,
			feature,
			stage: "eligibility",
			availability,
			reason: availability === "available" ? "none" : availability,
		};
	}
	if (record.stage !== "outcome" || !exactKeys(record, [...BASE_KEYS, "outcome", "reason"])) return;
	if (record.outcome === "success" && record.reason === "none")
		return { catalogVersion: FEATURE_CATALOG_VERSION, feature, stage: "outcome", outcome: "success", reason: "none" };
	if (record.outcome === "cancelled" && record.reason === "user")
		return {
			catalogVersion: FEATURE_CATALOG_VERSION,
			feature,
			stage: "outcome",
			outcome: "cancelled",
			reason: "user",
		};
	if (
		record.outcome === "failure" &&
		(record.reason === "rejected" || record.reason === "transport" || record.reason === "unknown")
	)
		return {
			catalogVersion: FEATURE_CATALOG_VERSION,
			feature,
			stage: "outcome",
			outcome: "failure",
			reason: record.reason,
		};
	if (
		record.outcome === "unavailable" &&
		(record.reason === "not_configured" || record.reason === "disconnected" || record.reason === "unsupported")
	)
		return {
			catalogVersion: FEATURE_CATALOG_VERSION,
			feature,
			stage: "outcome",
			outcome: "unavailable",
			reason: record.reason,
		};
}
