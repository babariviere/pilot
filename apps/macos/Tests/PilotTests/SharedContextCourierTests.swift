import CryptoKit
import Foundation
import Testing
@testable import Pilot
@testable import PilotCore

private func sharedDecode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
    try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
}

@MainActor private final class CourierFixture {
    let home: HostRef
    let target: HostRef
    var binding: SharedContextBinding
    var destinationBinding: SharedContextBinding
    var pending: [DurableOperation] = []
    var receipts: [String: OperationReceipt] = [:]
    var calls: [String] = []
    var acknowledged: [String] = []
    var destinationCurrent = true
    var replyState: OperationReceipt.State = .accepted
    var loseFirstReply = false
    var afterLookup: (() -> Void)?
    var pageSize = 16

    init(count: Int = 1) throws {
        let home = HostRef(hostId: "local", daemonId: "home", lineageId: "h1")
        let target = HostRef(hostId: "ssh-alias", daemonId: "target", lineageId: "t1")
        self.home = home; self.target = target
        let binding = SharedContextBinding(bindingId: "binding", generation: 1, logicalProjectId: "logical",
            memoryHome: SharedProjectRef(host: OperationHost(home), projectId: "same"),
            missionHome: OperationHost(home),
            executionProject: SharedProjectRef(host: OperationHost(target), projectId: "same"),
            missionIds: ["same"], shareMemory: true)
        self.binding = binding; destinationBinding = binding
        for index in 1...max(1, count) where count > 0 {
            let payload = "{ \"stable\": \"payload-\(index)\" }"
            pending.append(DurableOperation(schemaVersion: 1, operationId: "original-\(index)", producerId: "daemon-producer",
                sequence: index, origin: OperationHost(home).envelopeIdentity,
                destination: OperationHost(target).envelopeIdentity, kind: "share-memory-page", targetId: "same",
                payload: payload, payloadHash: SHA256.hash(data: Data(payload.utf8)).map { String(format: "%02x", $0) }.joined(),
                bindingId: "binding", bindingGeneration: 1))
        }
    }

    func summary(_ binding: SharedContextBinding) throws -> SharedContextSummary {
        try sharedDecode(SharedContextSummary.self, [
            "binding": JSONSerialization.jsonObject(with: JSONEncoder().encode(binding)),
            "freshness": ["applied": ["memory": 0, "mission": 0], "complete": true, "pendingCount": 0, "conflictCount": 0],
            "grants": [],
        ])
    }

    func receipt(_ operation: DurableOperation) -> OperationReceipt {
        OperationReceipt(operationId: operation.operationId, payloadHash: operation.payloadHash,
            destination: operation.destination, targetId: operation.targetId, state: replyState,
            result: .object(["state": .string("conflict")]), reason: nil)
    }

    func endpoints() -> [HostRef: SharedContextCourier.Endpoint] {
        [home: .init(token: HostConnectionToken(host: home), isCurrent: { true },
            summaries: { [self] in [try summary(binding)] },
            exchange: { [self] id, peer in
                #expect(id == binding.bindingId); #expect(peer == OperationHost(target))
                calls.append("exchange")
                return SharedExchangeBatch(bindingId: id, generation: binding.generation,
                    operations: Array(pending.prefix(pageSize)), more: pending.count > pageSize)
            }, operation: { _, _ in Issue.record("Home must not execute outgoing operations"); return .unknown },
            acknowledge: { [self] id, ack in
                #expect(id == binding.bindingId)
                #expect(receipts[ack.operation.operationId] == ack.receipt)
                #expect(pending.contains(ack.operation))
                acknowledged.append(ack.operation.operationId)
                pending.removeAll { $0 == ack.operation }
            }),
         target: .init(token: HostConnectionToken(host: target), isCurrent: { [self] in destinationCurrent },
            summaries: { [self] in [try summary(destinationBinding)] },
            exchange: { [self] id, _ in
                SharedExchangeBatch(bindingId: id, generation: destinationBinding.generation, operations: [], more: false)
            }, operation: { [self] operation, lookup in
                calls.append("\(lookup ? "lookup" : "post"):\(operation.operationId)")
                #expect(pending.contains(operation), "The courier must not allocate or rewrite an envelope")
                if lookup {
                    afterLookup?()
                    return receipts[operation.operationId].map(OperationDelivery.receipt) ?? .unknown
                }
                let receipt = receipt(operation); receipts[operation.operationId] = receipt
                if loseFirstReply { loseFirstReply = false; throw URLError(.networkConnectionLost) }
                return .receipt(receipt)
            }, acknowledge: { _, _ in Issue.record("Destination cannot retire source intents") })]
    }
}

@MainActor private func courierUntil(_ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(90))
    while !condition() {
        guard ContinuousClock.now < deadline else { throw ClientError("Courier condition timed out") }
        try await Task.sleep(for: .milliseconds(5))
    }
}

@Suite struct SharedContextCourierTests {
    @Test @MainActor func receiptFirstLostReplyAndRelaunchPreserveOriginalDaemonIdentityAndSourceAck() async throws {
        let fixture = try CourierFixture()
        let original = try #require(fixture.pending.first)
        fixture.loseFirstReply = true
        let first = SharedContextCourier()
        first.update(fixture.endpoints())
        try await courierUntil { first.isIdle }
        #expect(fixture.acknowledged.isEmpty)
        #expect(fixture.pending == [original])
        #expect(fixture.calls.filter { $0.hasPrefix("post:") } == ["post:original-1"])
        first.stop()

        let relaunched = SharedContextCourier()
        relaunched.update(fixture.endpoints())
        try await courierUntil { relaunched.isIdle }
        #expect(fixture.acknowledged == [original.operationId])
        #expect(fixture.pending.isEmpty)
        #expect(fixture.calls.filter { $0.hasPrefix("post:") }.count == 1)
        let post = try #require(fixture.calls.firstIndex(of: "post:original-1"))
        #expect(fixture.calls[..<post].contains("lookup:original-1"))
        relaunched.stop()
    }

    @Test @MainActor func pendingReceiptNeverPostsOrAcknowledgesAndBlocksCausalSuccessors() async throws {
        let fixture = try CourierFixture(count: 2)
        fixture.replyState = .pending
        fixture.receipts[fixture.pending[0].operationId] = fixture.receipt(fixture.pending[0])
        let courier = SharedContextCourier(); courier.update(fixture.endpoints())
        try await courierUntil { courier.isIdle }
        #expect(fixture.calls.filter { $0.hasPrefix("post:") }.isEmpty)
        #expect(!fixture.calls.contains("lookup:original-2"))
        #expect(fixture.pending.count == 2); #expect(fixture.acknowledged.isEmpty)
        courier.stop()
    }

    @Test @MainActor func conclusiveRejectedAndConflictOutcomesReturnToOwnerWithoutAppProjection() async throws {
        for state in [OperationReceipt.State.accepted, .rejected] {
            let fixture = try CourierFixture(); fixture.replyState = state
            let courier = SharedContextCourier(); courier.update(fixture.endpoints())
            try await courierUntil { courier.isIdle }
            #expect(fixture.acknowledged == ["original-1"])
            #expect(fixture.receipts["original-1"]?.result?["state"]?.string == "conflict")
            courier.stop()
        }
    }

    @Test @MainActor func catchUpYieldsAfterPageBudgetAndContinuesWithoutPolling() async throws {
        let fixture = try CourierFixture(count: SharedContextCourier.pageBudget * 16 + 17)
        let courier = SharedContextCourier(); courier.update(fixture.endpoints())
        try await courierUntil { courier.isIdle }
        #expect(fixture.pending.isEmpty)
        #expect(Set(fixture.acknowledged).count == SharedContextCourier.pageBudget * 16 + 17)
        #expect(fixture.calls.filter { $0 == "exchange" }.count > SharedContextCourier.pageBudget)
        let count = fixture.calls.count
        for _ in 0..<20 { await Task.yield() }
        #expect(fixture.calls.count == count, "An idle courier does not poll")
        courier.stop()
    }

    @Test @MainActor func changedSocketGenerationOrCancelledBindingSnapshotCannotAckOrPost() async throws {
        for invalidateEpoch in [false, true] {
            let fixture = try CourierFixture()
            let courier = SharedContextCourier()
            fixture.afterLookup = {
                if invalidateEpoch { courier.stop() } else { fixture.destinationCurrent = false }
            }
            courier.update(fixture.endpoints())
            try await courierUntil { courier.isIdle }
            #expect(fixture.acknowledged.isEmpty)
            #expect(fixture.calls.filter { $0.hasPrefix("post:") }.isEmpty)
            courier.stop()
        }
    }

    @Test @MainActor func duplicateAliasPinsAndChangedEnrollmentFailClosedWithoutLocalFallback() async throws {
        let fixture = try CourierFixture()
        let courier = SharedContextCourier()
        var endpoints = fixture.endpoints()
        let alias = HostRef(hostId: "second-alias", daemonId: fixture.target.daemonId, lineageId: fixture.target.lineageId)
        let original = try #require(endpoints[fixture.target])
        endpoints[alias] = .init(token: HostConnectionToken(host: alias), isCurrent: original.isCurrent,
            summaries: original.summaries, exchange: original.exchange, operation: original.operation,
            acknowledge: original.acknowledge)
        courier.update(endpoints)
        try await courierUntil { courier.isIdle }
        #expect(fixture.acknowledged.isEmpty)
        #expect(fixture.calls.filter { $0.hasPrefix("post:") }.isEmpty)
        courier.stop()

        let binding = fixture.binding
        fixture.destinationBinding = SharedContextBinding(bindingId: binding.bindingId, generation: 2,
            logicalProjectId: binding.logicalProjectId, memoryHome: binding.memoryHome, missionHome: binding.missionHome,
            executionProject: binding.executionProject, missionIds: binding.missionIds, shareMemory: true)
        let changed = SharedContextCourier(); changed.update(fixture.endpoints())
        try await courierUntil { changed.isIdle }
        #expect(fixture.calls.filter { $0.hasPrefix("post:") }.isEmpty)
        changed.stop()
    }

    @Test @MainActor func repeatedTriggersKeepCancelledTransportsCountedUntilTheyActuallyFinish() async throws {
        let courier = SharedContextCourier()
        var active = 0, peak = 0
        var waiters: [CheckedContinuation<[SharedContextSummary], Error>] = []
        var endpoints: [HostRef: SharedContextCourier.Endpoint] = [:]
        for index in 0..<4 {
            let host = HostRef(hostId: "host-\(index)", daemonId: "daemon-\(index)", lineageId: "1")
            endpoints[host] = .init(token: HostConnectionToken(host: host), isCurrent: { true }, summaries: {
                active += 1; peak = max(peak, active)
                defer { active -= 1 }
                return try await withCheckedThrowingContinuation { waiters.append($0) }
            }, exchange: { _, _ in throw HostRoutingError.invalidReference }, operation: { _, _ in .unknown },
            acknowledge: { _, _ in })
        }
        courier.update(endpoints)
        try await courierUntil { waiters.count == 2 }
        for _ in 0..<100 { courier.trigger() }
        #expect(active == 2); #expect(peak == 2)
        courier.stop()
        for waiter in waiters { waiter.resume(returning: []) }
        try await courierUntil { courier.isIdle }
        #expect(active == 0); #expect(peak == 2)
    }

    @Test @MainActor func malformedOrOversizedDaemonBatchesCannotReachMutationTransport() async throws {
        for oversized in [false, true] {
            let fixture = try CourierFixture(count: oversized ? 17 : 1)
            if oversized { fixture.pageSize = 17 }
            else {
                let original = fixture.pending[0]
                fixture.pending[0] = DurableOperation(schemaVersion: original.schemaVersion,
                    operationId: original.operationId, producerId: original.producerId, sequence: original.sequence,
                    origin: original.origin, destination: original.destination, kind: original.kind,
                    targetId: original.targetId, payload: "changed bytes", payloadHash: original.payloadHash,
                    bindingId: original.bindingId, bindingGeneration: original.bindingGeneration)
            }
            let courier = SharedContextCourier(); courier.update(fixture.endpoints())
            try await courierUntil { courier.isIdle }
            #expect(fixture.calls.filter { $0.hasPrefix("lookup:") || $0.hasPrefix("post:") }.isEmpty)
            #expect(fixture.acknowledged.isEmpty)
            courier.stop()
        }
    }

    @Test @MainActor func revocationCanReachStillActivePeerInsteadOfDeadlockingOnStateEquality() async throws {
        let fixture = try CourierFixture()
        let binding = fixture.binding
        fixture.binding = SharedContextBinding(bindingId: binding.bindingId, generation: binding.generation,
            logicalProjectId: binding.logicalProjectId, memoryHome: binding.memoryHome, missionHome: binding.missionHome,
            executionProject: binding.executionProject, missionIds: binding.missionIds, shareMemory: binding.shareMemory,
            state: .revoked)
        let original = fixture.pending[0]
        fixture.pending[0] = DurableOperation(schemaVersion: original.schemaVersion, operationId: original.operationId,
            producerId: original.producerId, sequence: original.sequence, origin: original.origin,
            destination: original.destination, kind: "share-revoke", targetId: original.targetId,
            payload: original.payload, payloadHash: original.payloadHash,
            bindingId: original.bindingId, bindingGeneration: original.bindingGeneration)
        let courier = SharedContextCourier(); courier.update(fixture.endpoints())
        try await courierUntil { courier.isIdle }
        #expect(fixture.acknowledged == [original.operationId])
        #expect(fixture.destinationBinding.state == .active, "The relay does not project revocation itself")
        courier.stop()
    }
}
