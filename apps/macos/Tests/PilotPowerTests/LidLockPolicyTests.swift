import PilotPowerSupport
import Testing

struct LidLockPolicyTests {
    @Test func locksOncePerClosureWhileOverrideIsActive() {
        var policy = LidLockPolicy()
        let beforeClosing = policy.shouldLock(lidClosed: false, overrideActive: true)
        #expect(!beforeClosing)
        let onClosing = policy.shouldLock(lidClosed: true, overrideActive: true)
        #expect(onClosing)
        for _ in 0..<10_000 {
            let repeated = policy.shouldLock(lidClosed: true, overrideActive: true)
            #expect(!repeated)
        }
        let reopened = policy.shouldLock(lidClosed: false, overrideActive: true)
        #expect(!reopened)
        let closedAgain = policy.shouldLock(lidClosed: true, overrideActive: true)
        #expect(closedAgain)
    }

    @Test func ordinarySleepAndAbsentLidsDoNotRequestLocks() {
        check([
            (nil, true, false),
            (false, false, false),
            (true, false, false),
        ])
    }

    @Test func enablingOverrideWithLidAlreadyClosedLocksIncludingStartup() {
        check([
            (true, false, false),
            (true, true, true),
        ])
        check([(true, true, true)])
    }

    @Test func unknownSensorsAndWorkRestartDoNotRelockDockedUser() {
        check([
            (true, true, true),
            (nil, true, false),
            (true, true, false),
            (true, false, false),
            (true, true, false),
            (false, false, false),
            (true, true, true),
        ])
    }

    private func check(_ steps: [(lidClosed: Bool?, overrideActive: Bool, expected: Bool)]) {
        var policy = LidLockPolicy()
        for step in steps {
            // Mutate before #expect: its function-call expansion takes the receiver by value.
            let actual = policy.shouldLock(lidClosed: step.lidClosed, overrideActive: step.overrideActive)
            #expect(actual == step.expected)
        }
    }
}
