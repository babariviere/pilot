import PilotPowerSupport
import Testing

struct SleepAcknowledgementTests {
    @Test func acknowledgementAndFallbackConsumeTheTokenOnlyOnce() {
        var acknowledgement = SleepAcknowledgement()
        let generation = acknowledgement.begin(argument: 123)
        let token = acknowledgement.take(generation: generation)
        #expect(token == 123)
        let repeated = acknowledgement.take(generation: generation)
        #expect(repeated == nil)
        #expect(SleepAcknowledgement.preparationTimeout == 5)
    }

    @Test func lateDaemonRepliesAndTimersCannotReleaseTheNextSleep() {
        var acknowledgement = SleepAcknowledgement()
        let old = acknowledgement.begin(argument: 123)
        acknowledgement.woke()
        let afterWake = acknowledgement.take(generation: old)
        #expect(afterWake == nil)
        let current = acknowledgement.begin(argument: 456)
        let stale = acknowledgement.take(generation: old)
        #expect(stale == nil)
        let token = acknowledgement.take(generation: current)
        #expect(token == 456)
    }
}
