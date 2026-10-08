/// Auto-follow is suspended during a scroll gesture and while reading older messages.
/// User scrolling and explicit message expansion update this policy, not streaming layout.
public struct TranscriptScrollFollow: Equatable {
    public private(set) var isFollowing = true
    public private(set) var isUserScrolling = false

    public init() {}

    public var shouldScrollToBottom: Bool { isFollowing && !isUserScrolling }

    public mutating func pauseFollowing() {
        isFollowing = false
    }

    public mutating func beginUserScroll() {
        isUserScrolling = true
    }

    public mutating func userScrolled(distanceToBottom: Double) {
        // Allow for fractional-point rounding at the bottom of the native scroll view.
        isFollowing = distanceToBottom <= 2
    }

    public mutating func endUserScroll(distanceToBottom: Double) {
        userScrolled(distanceToBottom: distanceToBottom)
        isUserScrolling = false
    }
}
