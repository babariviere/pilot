import Foundation
import PilotCore
import Testing
@testable import Pilot

@MainActor private final class ControlSchedulerProbe {
    let home = HostConnectionToken(host: HostRef(hostId: "local", daemonId: "home", lineageId: "h1"))
    var calls: [String] = []
    var committed: [String] = []
    var active = 0
    var maximumActive = 0
    var blocked: Set<String> = []
    var waits: [String: CheckedContinuation<Void, Never>] = [:]
    var more: [String: Int] = [:]
    var failures: Set<String> = []

    func host(_ id: String) -> HostRef { HostRef(hostId: id, daemonId: id, lineageId: "lineage") }

    func endpoint(_ id: String, home: HostConnectionToken? = nil,
                  target: HostConnectionToken? = nil) -> ControlCourierScheduler.Endpoint {
        .init(home: home ?? self.home, target: target ?? HostConnectionToken(host: host(id)), isCurrent: { true },
              exchange: { [self] fence in
            calls.append(id)
            active += 1
            maximumActive = max(maximumActive, active)
            defer { active -= 1 }
            if blocked.contains(id) { await withCheckedContinuation { waits[id] = $0 } }
            try fence.check()
            if failures.contains(id) { throw URLError(.networkConnectionLost) }
            committed.append(id)
            let remaining = more[id, default: 0]
            more[id] = max(0, remaining - 1)
            return remaining > 0
        })
    }

    func release(_ id: String) { blocked.remove(id); waits.removeValue(forKey: id)?.resume() }
}

@MainActor private func controlSchedulerUntil(_ predicate: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(10))
    while !predicate() {
        guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
        try await Task.sleep(for: .milliseconds(5))
    }
}

@Suite struct ControlCourierSchedulerTests {
    @Test @MainActor func changeDuringExchangeIsCoalescedAndIdleNeverPolls() async throws {
        let probe = ControlSchedulerProbe()
        let scheduler = ControlCourierScheduler()
        probe.blocked.insert("a")
        let endpoints = [probe.host("a"): probe.endpoint("a")]
        try scheduler.update(endpoints)
        try await controlSchedulerUntil { probe.waits["a"] != nil }
        for _ in 0..<100 {
            scheduler.changed(probe.host("a"))
            try scheduler.update(endpoints)
        }
        probe.release("a")
        try await controlSchedulerUntil { scheduler.isIdle }
        #expect(probe.calls == ["a", "a"])
        #expect(probe.maximumActive == 1)
        for _ in 0..<20 { await Task.yield() }
        #expect(probe.calls == ["a", "a"])
        scheduler.stop()
    }

    @Test @MainActor func replacedTargetWaitsForCancelledTransportAndCannotCommitStaleWork() async throws {
        let probe = ControlSchedulerProbe()
        let scheduler = ControlCourierScheduler()
        probe.blocked = ["a", "b"]
        let a = probe.host("a"), b = probe.host("b"), c = probe.host("c")
        let firstA = probe.endpoint("a"), firstB = probe.endpoint("b")
        try scheduler.update([a: firstA, b: firstB])
        try await controlSchedulerUntil { probe.waits.count == 2 }
        try scheduler.update([a: probe.endpoint("a"), b: firstB, c: probe.endpoint("c")])
        for _ in 0..<10 { await Task.yield() }
        #expect(probe.calls.count == 2, "Cancellation does not free a slot before the transport returns")
        probe.release("a")
        try await controlSchedulerUntil { probe.committed.contains("a") && probe.committed.contains("c") }
        #expect(probe.calls.filter { $0 == "a" }.count == 2)
        #expect(probe.committed.filter { $0 == "a" }.count == 1)
        #expect(probe.maximumActive <= ControlCourierScheduler.concurrency)
        probe.release("b")
        try await controlSchedulerUntil { scheduler.isIdle }
        scheduler.stop()
    }

    @Test @MainActor func homeReconnectFencesEveryPeerAndOfflineRemovalNeverFallsBack() async throws {
        let probe = ControlSchedulerProbe()
        let scheduler = ControlCourierScheduler()
        probe.blocked = ["a", "b"]
        let a = probe.host("a"), b = probe.host("b")
        try scheduler.update([a: probe.endpoint("a"), b: probe.endpoint("b")])
        try await controlSchedulerUntil { probe.waits.count == 2 }
        let newHome = HostConnectionToken(host: probe.home.host)
        try scheduler.update([a: probe.endpoint("a", home: newHome)])
        scheduler.changed(b)
        probe.release("a"); probe.release("b")
        try await controlSchedulerUntil { scheduler.isIdle }
        #expect(probe.committed == ["a"])
        #expect(probe.calls.filter { $0 == "b" }.count == 1)
        #expect(scheduler.failures.isEmpty)
        scheduler.stop()
    }

    @Test @MainActor func catchUpYieldsAtPageBudgetAndUnrelatedHostIsNotStarved() async throws {
        let probe = ControlSchedulerProbe()
        let scheduler = ControlCourierScheduler()
        probe.more["a"] = ControlCourierScheduler.pageBudget * 3
        try scheduler.update(Dictionary(uniqueKeysWithValues: ["a", "b", "c"].map {
            (probe.host($0), probe.endpoint($0))
        }))
        try await controlSchedulerUntil { scheduler.isIdle }
        let c = try #require(probe.calls.firstIndex(of: "c"))
        #expect(probe.calls[..<c].filter { $0 == "a" }.count <= ControlCourierScheduler.pageBudget)
        #expect(probe.calls.filter { $0 == "a" }.count == ControlCourierScheduler.pageBudget * 3 + 1)
        #expect(probe.maximumActive <= ControlCourierScheduler.concurrency)
        scheduler.stop()
    }

    @Test @MainActor func ambiguousFailureWaitsForChangeRatherThanRetrying() async throws {
        let probe = ControlSchedulerProbe()
        let scheduler = ControlCourierScheduler()
        let a = probe.host("a")
        probe.failures.insert("a")
        try scheduler.update([a: probe.endpoint("a")])
        try await controlSchedulerUntil { scheduler.isIdle }
        #expect(probe.calls == ["a"])
        #expect(scheduler.failures == [a])
        for _ in 0..<20 { await Task.yield() }
        #expect(probe.calls == ["a"])
        probe.failures.remove("a")
        scheduler.changed(a)
        try await controlSchedulerUntil { scheduler.isIdle }
        #expect(probe.committed == ["a"])
        #expect(scheduler.failures.isEmpty)
        scheduler.stop()
    }

    @Test @MainActor func stopFencesSuspendedSideEffectsAndCannotRestart() async throws {
        let probe = ControlSchedulerProbe()
        let scheduler = ControlCourierScheduler()
        let a = probe.host("a")
        probe.blocked.insert("a")
        try scheduler.update([a: probe.endpoint("a")])
        try await controlSchedulerUntil { probe.waits["a"] != nil }
        scheduler.stop()
        #expect(!scheduler.isIdle)
        try scheduler.update([a: probe.endpoint("a")])
        scheduler.changed()
        probe.release("a")
        try await controlSchedulerUntil { scheduler.isIdle }
        #expect(probe.calls == ["a"])
        #expect(probe.committed.isEmpty)
    }

    @Test @MainActor func duplicatePinsMixedHomesAndOversizedInventoriesFailClosed() throws {
        let probe = ControlSchedulerProbe()
        let a = probe.host("a")
        let alias = HostRef(hostId: "alias", daemonId: a.daemonId, lineageId: a.lineageId)
        let mixedHome = HostConnectionToken(host: HostRef(hostId: "local", daemonId: "other", lineageId: "h2"))
        let homeAlias = HostRef(hostId: "alias", daemonId: probe.home.host.daemonId, lineageId: probe.home.host.lineageId)
        let invalid: [[HostRef: ControlCourierScheduler.Endpoint]] = [
            [a: probe.endpoint("a"), alias: probe.endpoint("alias", target: HostConnectionToken(host: alias))],
            [a: probe.endpoint("a"), probe.host("b"): probe.endpoint("b", home: mixedHome)],
            [a: probe.endpoint("wrong")],
            [homeAlias: probe.endpoint("alias", target: HostConnectionToken(host: homeAlias))],
            Dictionary(uniqueKeysWithValues: (0...ControlCourierScheduler.hostBudget).map {
                let id = "box-\($0)"; return (probe.host(id), probe.endpoint(id))
            }),
        ]
        for endpoints in invalid {
            let scheduler = ControlCourierScheduler()
            #expect(throws: HostRoutingError.invalidReference) { try scheduler.update(endpoints) }
            #expect(scheduler.isIdle)
        }
        #expect(probe.calls.isEmpty)
    }
}
