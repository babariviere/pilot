/** Closed, content-free feature-adoption catalog. Producers emit only after explicit analytics consent. */
export const FEATURE_CATALOG_VERSION = 1 as const;

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
	  } & (
				| { outcome: "success"; reason: "none" }
				| { outcome: "cancelled"; reason: "user" }
				| { outcome: "failure"; reason: "rejected" | "transport" | "unknown" }
				| { outcome: "unavailable"; reason: Exclude<FeatureAvailability, "available"> }
			));
