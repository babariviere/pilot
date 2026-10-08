import Combine
import Foundation
import Testing
@testable import Pilot

@Test @MainActor func brailleClockUsesOneTimerAndStopsAfterItsLastVisibleSubscriber() {
    let clock = BrailleProgressClock()
    let first = UUID()
    let second = UUID()
    #expect(!clock.isRunning)
    clock.subscribe(first)
    clock.subscribe(first)
    clock.subscribe(second)
    #expect(clock.isRunning && clock.subscriberCount == 2)
    clock.unsubscribe(first)
    clock.unsubscribe(first)
    #expect(clock.isRunning && clock.subscriberCount == 1)
    clock.unsubscribe(second)
    #expect(!clock.isRunning && clock.subscriberCount == 0)
}

@Test @MainActor func brailleClockPublishesOnlyChangedGlyphs() {
    let clock = BrailleProgressClock()
    clock.refresh(at: Date(timeIntervalSinceReferenceDate: 0))
    var publications = 0
    let token = clock.objectWillChange.sink { publications += 1 }
    clock.refresh(at: Date(timeIntervalSinceReferenceDate: 0.01))
    clock.refresh(at: Date(timeIntervalSinceReferenceDate: 0.09))
    #expect(publications == 0)
    clock.refresh(at: Date(timeIntervalSinceReferenceDate: 0.15))
    #expect(publications == 1 && clock.frameIndex == 1)
    withExtendedLifetime(token) {}
}
