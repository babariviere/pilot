import PilotPowerSupport
import Testing

struct LidLockPolicyTests {
    @Test func locksOncePerClosureWhileOverrideIsActive() {
        var policy = LidLockPolicy()
        #expect(!policy.shouldLock(lidClosed: false, overrideActive: true))
        #expect(policy.shouldLock(lidClosed: true, overrideActive: true))
        for _ in 0..<10_000 {
            #expect(!policy.shouldLock(lidClosed: true, overrideActive: true))
        }
        #expect(!policy.shouldLock(lidClosed: false, overrideActive: true))
        #expect(policy.shouldLock(lidClosed: true, overrideActive: true))
    }

    @Test func ordinarySleepAndAbsentLidsDoNotRequestLocks() {
        var policy = LidLockPolicy()
        #expect(!policy.shouldLock(lidClosed: nil, overrideActive: true))
        #expect(!policy.shouldLock(lidClosed: false, overrideActive: false))
        #expect(!policy.shouldLock(lidClosed: true, overrideActive: false))
    }

    @Test func enablingOverrideWithLidAlreadyClosedLocksIncludingStartup() {
        var policy = LidLockPolicy()
        #expect(!policy.shouldLock(lidClosed: true, overrideActive: false))
        #expect(policy.shouldLock(lidClosed: true, overrideActive: true))
        var startup = LidLockPolicy()
        #expect(startup.shouldLock(lidClosed: true, overrideActive: true))
    }

    @Test func unknownSensorsAndWorkRestartDoNotRelockDockedUser() {
        var policy = LidLockPolicy()
        #expect(policy.shouldLock(lidClosed: true, overrideActive: true))
        #expect(!policy.shouldLock(lidClosed: nil, overrideActive: true))
        #expect(!policy.shouldLock(lidClosed: true, overrideActive: true))
        #expect(!policy.shouldLock(lidClosed: true, overrideActive: false))
        #expect(!policy.shouldLock(lidClosed: true, overrideActive: true))
        #expect(!policy.shouldLock(lidClosed: false, overrideActive: false))
        #expect(policy.shouldLock(lidClosed: true, overrideActive: true))
    }
}
