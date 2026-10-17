import CoreGraphics
import Foundation

/// Which directions the scrollable areas under the pointer inside an inline artifact can still move,
/// including the artifact's own page. Read from the page while the pointer moves over it.
public struct ArtifactScrollState: Equatable, Sendable {
    public var up: Bool
    public var down: Bool
    public var left: Bool
    public var right: Bool

    public init(up: Bool = false, down: Bool = false, left: Bool = false, right: Bool = false) {
        self.up = up
        self.down = down
        self.left = left
        self.right = right
    }

    /// Booleans in `[up, down, left, right]` order, as the page probe returns them.
    public init?(_ values: [Bool]) {
        guard values.count == 4 else { return nil }
        self.init(up: values[0], down: values[1], left: values[2], right: values[3])
    }
}

public enum ArtifactScrollTarget: Equatable, Sendable {
    case artifact, chat
}

/// Phases of a scroll event, reduced from `NSEvent.phase` and `momentumPhase`.
public enum ArtifactScrollPhase: Equatable, Sendable {
    /// A mouse wheel tick: no gesture, each tick routes on its own.
    case discrete
    case began, changed, ended, momentum, momentumEnded
}

public enum ArtifactScrollDecision: Equatable, Sendable {
    /// Keep the event until the gesture's direction is known.
    case hold
    /// Send held events, then this one, to the target.
    case deliver(ArtifactScrollTarget)
}

/// Decides whether a scroll over an inline artifact moves the artifact or the chat. Vertical scrolling
/// goes to the chat unless something under the pointer can still scroll that way, so the chat is never
/// trapped; horizontal scrolling goes to the artifact. A trackpad gesture keeps one target from its first
/// movement through its momentum, like nested scroll views, so reaching an edge passes the next gesture on.
public struct ArtifactScrollRouter: Equatable, Sendable {
    private var locked: ArtifactScrollTarget?

    public init() {}

    public static func target(deltaX: CGFloat, deltaY: CGFloat, state: ArtifactScrollState?) -> ArtifactScrollTarget {
        if abs(deltaX) > abs(deltaY) { return .artifact }
        guard let state, deltaY != 0 else { return .chat }
        // Positive deltas reveal content above (natural or traditional scrolling alike).
        return (deltaY > 0 ? state.up : state.down) ? .artifact : .chat
    }

    public mutating func route(_ phase: ArtifactScrollPhase, deltaX: CGFloat, deltaY: CGFloat,
                               state: ArtifactScrollState?) -> ArtifactScrollDecision {
        let moving = deltaX != 0 || deltaY != 0
        switch phase {
        case .discrete:
            return .deliver(Self.target(deltaX: deltaX, deltaY: deltaY, state: state))
        case .began, .changed:
            if phase == .began { locked = nil }
            if locked == nil {
                guard moving else { return .hold }
                locked = Self.target(deltaX: deltaX, deltaY: deltaY, state: state)
            }
            return .deliver(locked ?? .chat)
        case .ended, .momentum:
            return .deliver(locked ?? .chat)
        case .momentumEnded:
            let target = locked ?? .chat
            locked = nil
            return .deliver(target)
        }
    }
}
