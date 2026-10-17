import CoreGraphics
import Testing
@testable import PilotCore

private let scrollsDown = ArtifactScrollState(up: false, down: true)
private let atBottom = ArtifactScrollState(up: true, down: false)

@Test func verticalScrollGoesToTheChatUnlessTheArtifactCanStillMoveThatWay() {
    // Negative deltas move toward the end of the content.
    #expect(ArtifactScrollRouter.target(deltaX: 0, deltaY: -4, state: scrollsDown) == .artifact)
    #expect(ArtifactScrollRouter.target(deltaX: 0, deltaY: 4, state: scrollsDown) == .chat)
    #expect(ArtifactScrollRouter.target(deltaX: 0, deltaY: -4, state: atBottom) == .chat)
    #expect(ArtifactScrollRouter.target(deltaX: 0, deltaY: 4, state: atBottom) == .artifact)
    // Nothing scrollable, or not read yet: never trap the chat.
    #expect(ArtifactScrollRouter.target(deltaX: 0, deltaY: -4, state: ArtifactScrollState()) == .chat)
    #expect(ArtifactScrollRouter.target(deltaX: 0, deltaY: -4, state: nil) == .chat)
}

@Test func horizontalScrollGoesToTheArtifact() {
    #expect(ArtifactScrollRouter.target(deltaX: 6, deltaY: 2, state: nil) == .artifact)
    #expect(ArtifactScrollRouter.target(deltaX: -6, deltaY: -1, state: ArtifactScrollState()) == .artifact)
}

@Test func mouseWheelTicksRouteIndependently() {
    var router = ArtifactScrollRouter()
    #expect(router.route(.discrete, deltaX: 0, deltaY: -1, state: scrollsDown) == .deliver(.artifact))
    #expect(router.route(.discrete, deltaX: 0, deltaY: -1, state: atBottom) == .deliver(.chat))
}

@Test func aTrackpadGestureKeepsItsFirstTargetThroughMomentum() {
    var router = ArtifactScrollRouter()
    #expect(router.route(.began, deltaX: 0, deltaY: -3, state: scrollsDown) == .deliver(.artifact))
    // The page reaches its end mid-gesture: the gesture stays with it, like nested scroll views.
    #expect(router.route(.changed, deltaX: 0, deltaY: -3, state: atBottom) == .deliver(.artifact))
    #expect(router.route(.ended, deltaX: 0, deltaY: 0, state: atBottom) == .deliver(.artifact))
    #expect(router.route(.momentum, deltaX: 0, deltaY: -8, state: atBottom) == .deliver(.artifact))
    #expect(router.route(.momentumEnded, deltaX: 0, deltaY: 0, state: atBottom) == .deliver(.artifact))
    // The next gesture at the edge passes through to the chat.
    #expect(router.route(.began, deltaX: 0, deltaY: -3, state: atBottom) == .deliver(.chat))
    #expect(router.route(.changed, deltaX: 0, deltaY: -3, state: scrollsDown) == .deliver(.chat))
}

@Test func aGestureWithoutMovementWaitsForItsDirection() {
    var router = ArtifactScrollRouter()
    #expect(router.route(.began, deltaX: 0, deltaY: 0, state: atBottom) == .hold)
    #expect(router.route(.changed, deltaX: 0, deltaY: 0, state: atBottom) == .hold)
    #expect(router.route(.changed, deltaX: 0, deltaY: 5, state: atBottom) == .deliver(.artifact))
    // A touch that never moves ends in the chat.
    #expect(router.route(.began, deltaX: 0, deltaY: 0, state: scrollsDown) == .hold)
    #expect(router.route(.ended, deltaX: 0, deltaY: 0, state: scrollsDown) == .deliver(.chat))
}

@Test func scrollStateDecodesThePageProbeOrder() {
    #expect(ArtifactScrollState([true, false, false, true]) == ArtifactScrollState(up: true, right: true))
    #expect(ArtifactScrollState([true]) == nil)
}
