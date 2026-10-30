import Foundation

/// Explicit app-requested provider limits, separate from retained token history.
public struct SubscriptionRefreshProvider: Codable, Equatable, Sendable {
    public let provider: SubscriptionProvider
    public let account: String
    public let state: String
    public let usage: SubscriptionUsage?
}

public struct SubscriptionRefreshSnapshot: Codable, Equatable, Sendable {
    public let providers: [SubscriptionRefreshProvider]
}
