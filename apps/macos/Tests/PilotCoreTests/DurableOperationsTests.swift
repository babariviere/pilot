import Foundation
import Testing
@testable import PilotCore

@Test func outboxRetainsImmutableIntentsAcrossRestartAndOnlyReleasesConclusiveReceipts() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let origin = HostRef(hostId: "local", daemonId: "a", lineageId: "1")
    let target = HostRef(hostId: "box", daemonId: "b", lineageId: "2")
    let first = try await OperationOutbox(directory: directory).reserve(
        kind: "chat-create", targetId: nil, payload: ["message": "hello"], origin: origin, destination: target)
    let restarted = OperationOutbox(directory: directory)
    let retry = try await restarted.reserve(kind: "chat-create", targetId: nil, payload: ["message": "hello"],
                                           origin: origin, destination: target)
    #expect(first == retry)
    let otherHost = try await restarted.reserve(kind: "chat-create", targetId: nil, payload: ["message": "hello"],
                                                origin: origin, destination: origin)
    #expect(otherHost.operationId != first.operationId)
    let receipt = OperationReceipt(operationId: first.operationId, payloadHash: first.payloadHash,
        destination: target, targetId: first.targetId, state: .accepted,
        result: .object(["sessionId": .string(first.targetId)]), reason: nil)
    try await restarted.acknowledge(first, receipt: receipt)
    let next = try await restarted.reserve(kind: "chat-create", targetId: nil, payload: ["message": "hello"],
                                          origin: origin, destination: target)
    #expect(next.operationId != first.operationId)
    #expect(next.sequence > first.sequence)
}

