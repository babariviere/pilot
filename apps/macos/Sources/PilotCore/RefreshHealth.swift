import Foundation

public enum RefreshStage: String, Codable, Sendable {
    case parentHeaders = "parent_headers"
    case discovery, classification, commit, waitingReplies = "waiting_replies", reactionReads = "reaction_reads"
}
public enum RefreshOutcome: String, Codable, Sendable { case success, partial, failure, budgetLimited = "budget_limited", cancelled }
public enum RefreshReason: String, Codable, Sendable {
    case signIn = "sign_in", providerRateLimit = "provider_rate_limit"
    case localClassificationBudget = "local_classification_budget", localReadBudget = "local_read_budget"
    case channelRead = "channel_read", classificationFailed = "classification_failed", classifierUnavailable = "classifier_unavailable"
    case batchLimit = "batch_limit", timeout, configChanged = "config_changed", stopped
    case deliveryDeferred = "delivery_deferred", readFailed = "read_failed", unknown
}
public struct RefreshStageHealth: Codable, Sendable {
    public let stage: RefreshStage
    public let lastStartedAt: Double?
    public let lastCompletedAt: Double?
    public let lastSucceededAt: Double?
    public let outcome: RefreshOutcome?
    public let reason: RefreshReason?
    public let channelIndex: Int?
    public let count: Int?
    public let requested: Int?
    public let readAttempts: Int?
    public let cacheHits: Int?
}
public struct RefreshLiveHealth: Codable, Sendable {
    public let lastAttemptAt: Double
    public let lastStartedAt: Double
    public let lastCompletedAt: Double?
    public let lastCommittedAt: Double?
    public let returnedItems: Int?
    public let outcome: RefreshOutcome?
    public let reason: RefreshReason?
    public let stages: [RefreshStageHealth]
}
