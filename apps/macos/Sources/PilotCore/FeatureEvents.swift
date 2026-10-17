public let featureCatalogVersion = 1
public let featureEventProcessLimit = 128

public enum FeatureName: String, Codable, CaseIterable, Sendable {
    case diagnoseChat = "diagnose_chat"
    case devboxChat = "devbox_chat"
    case slackTriage = "slack_triage"
}

public enum FeatureStage: String, Codable, Sendable { case eligibility, exposure, attempt, outcome }
public enum FeatureAvailability: String, Codable, Sendable {
    case available, notConfigured = "not_configured", disconnected, unsupported
}
public enum FeatureOutcome: String, Codable, Sendable { case success, failure, cancelled, unavailable }
public enum FeatureReason: String, Codable, Sendable {
    case none, user, rejected, transport, unknown
    case notConfigured = "not_configured"
    case disconnected, unsupported
}

/// Closed catalog event. Time and pseudonymous identity are supplied by the consent-gated telemetry envelope.
public struct FeatureEvent: Codable, Equatable, Sendable {
    public let catalogVersion: Int
    public let feature: FeatureName
    public let stage: FeatureStage
    public let availability: FeatureAvailability?
    public let outcome: FeatureOutcome?
    public let reason: FeatureReason?

    private init(feature: FeatureName, stage: FeatureStage, availability: FeatureAvailability? = nil,
                 outcome: FeatureOutcome? = nil, reason: FeatureReason? = nil) {
        catalogVersion = featureCatalogVersion
        self.feature = feature
        self.stage = stage
        self.availability = availability
        self.outcome = outcome
        self.reason = reason
    }

    public static func eligibility(_ feature: FeatureName, _ availability: FeatureAvailability) -> FeatureEvent {
        FeatureEvent(feature: feature, stage: .eligibility, availability: availability,
                     reason: availability == .available ? FeatureReason.none : FeatureReason(rawValue: availability.rawValue))
    }

    public static func exposure(_ feature: FeatureName) -> FeatureEvent {
        FeatureEvent(feature: feature, stage: .exposure)
    }

    public static func attempt(_ feature: FeatureName) -> FeatureEvent {
        FeatureEvent(feature: feature, stage: .attempt)
    }

    public static func outcome(_ feature: FeatureName, _ outcome: FeatureOutcome,
                               reason: FeatureReason) -> FeatureEvent? {
        let valid = switch outcome {
        case .success: reason == .none
        case .cancelled: reason == .user
        case .failure: reason == .rejected || reason == .transport || reason == .unknown
        case .unavailable: reason == .notConfigured || reason == .disconnected || reason == .unsupported
        }
        return valid ? FeatureEvent(feature: feature, stage: .outcome, outcome: outcome, reason: reason) : nil
    }
}
