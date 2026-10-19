import CryptoKit
import Foundation
import PilotCore
import Testing
@testable import Pilot

private func courierObject(_ value: JSONValue, _ fields: [String: JSONValue?]) -> JSONValue {
    guard case .object(var object) = value else { return value }
    for (key, value) in fields { object[key] = value }
    return .object(object)
}

/// Frozen DTO examples exercise the app adapter only. This is NOT the two-daemon rollout proof.
@MainActor private final class CourierWireProbe {
    let fixture: JSONValue
    let binding: ControlHomeEnrollment
    let home: HostRef
    let target: HostRef
    var current = true
    var accepted = false
    var adopted = false
    var loseDeliveryReply = false
    var pendingDelivery = false
    var loseImportReply = false
    var holdLookup = false
    var held: CheckedContinuation<Void, Never>?
    private var lookupObserver: CheckedContinuation<Void, Never>?
    private var lookupFinished = false
    var foreignCheckpoint = false
    var imported = 0
    var retained = 0
    var notices = 0
    var deliveries = 0
    var queries: [Int] = []
    var calls: [String] = []
    var statusNext: String?
    var publishedRevision = 0
    var statusBaselines: [Double] = []
    var readOutcome: JSONValue?
    var disconnectRead = false
    let operation: JSONValue

    init() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../packages/protocol/fixtures/control-hosts.json").standardizedFileURL
        fixture = try JSONValue.decode(Data(contentsOf: url))
        binding = try fixture["enrollments"]!.array![0].decode(ControlHomeEnrollment.self)
        home = HostRef(hostId: "local", daemonId: binding.home.daemonId, lineageId: binding.home.lineageId)
        target = HostRef(hostId: "box", daemonId: binding.executor.daemonId, lineageId: binding.executor.lineageId)
        let original = fixture["exchange"]!["operations"]!.array![0]
        let payload = original["payload"]!.string!
        let hash = SHA256.hash(data: Data(payload.utf8)).map { String(format: "%02x", $0) }.joined()
        operation = courierObject(original, ["payloadHash": .string(hash)])
    }

    func pass(lane: ControlOperationExchangeResponse.Lane = .ordinary) throws -> ControlCourierPass {
        let homeAPI = ControlCourierAPI(token: HostConnectionToken(host: home), isCurrent: { [self] in current },
            send: { [self] in try await reply($0, home: true) })
        let executorAPI = ControlCourierAPI(token: HostConnectionToken(host: target), isCurrent: { [self] in current },
            send: { [self] in try await reply($0, home: false) })
        return try ControlCourierPass(binding: binding, home: homeAPI, target: executorAPI, lane: lane)
    }

    func waitForHeldLookup() async {
        if held != nil || lookupFinished { return }
        await withCheckedContinuation { lookupObserver = $0 }
    }

    func finishLookupWait() {
        lookupFinished = true; lookupObserver?.resume(); lookupObserver = nil
    }

    private func reply(_ request: ControlCourierRequest, home: Bool) async throws -> Data {
        let path = request.path.joined(separator: "/")
        calls.append((home ? "home:" : "target:") + path)
        let body = try request.body.map(JSONValue.decode)
        let result: JSONValue
        if request.path == ["operations", "receipt"] {
            if holdLookup {
                await withCheckedContinuation {
                    held = $0; lookupObserver?.resume(); lookupObserver = nil
                }
            }
            result = accepted ? receipt() : .object(["state": .string("unknown")])
        } else if request.path == ["operations"] {
            deliveries += 1; accepted = true
            if loseDeliveryReply { loseDeliveryReply = false; throw URLError(.networkConnectionLost) }
            result = receipt(pending: pendingDelivery)
        } else if path.hasSuffix("/exchange") && !path.contains("/reads/") {
            result = courierObject(fixture["exchange"]!, ["operations": .array(adopted ? [] : [operation]), "more": .bool(false), "next": nil])
        } else if path.hasSuffix("/ack") && !path.contains("/events/") {
            #expect(body?["operation"] == operation)
            adopted = true; result = fixture["receiptAdoptions"]!.array![0]
        } else if path.hasSuffix("/sync-state") {
            let events = courierObject(fixture["syncStates"]!.array![1]["events"]!, [
                "importedThrough": .number(Double(imported)), "lastEventId": imported == 0 ? nil : .string("event:1"),
                "acknowledgedThrough": .number(Double(retained)), "head": .number(1),
            ])
            let status: JSONValue? = statusNext != nil || publishedRevision > 0
                ? courierObject(fixture["syncStates"]!.array![0]["status"]!, [
                    "next": statusNext.map(JSONValue.string), "publishedRevision": .number(Double(publishedRevision)),
                    "state": .string(statusNext == nil ? "published" : "staged"),
                ]) : nil
            // Slot 0 is home, slot 1 is executor. Their cursors can match while owner pins cannot.
            result = courierObject(fixture["syncStates"]!.array![foreignCheckpoint ? 1 : 0], ["events": events, "reconciliationRequired": .bool(false), "status": status])
        } else if path.hasSuffix("/events/ack") {
            retained = Int(body?["through"]?.number ?? -1); result = body!
        } else if path.hasSuffix("/events/import") {
            let through = Int(body?["events"]?.array?.last?["cursor"]?.number ?? Double(imported))
            if through > imported { notices += 1; imported = through }
            if loseImportReply { loseImportReply = false; throw URLError(.networkConnectionLost) }
            result = eventAck()
        } else if path.hasSuffix("/events") {
            let after = Int(request.query.first { $0.name == "after" }?.value ?? "-1")!
            queries.append(after)
            result = courierObject(fixture["eventPages"]!.array![0], ["after": .number(Double(after)), "head": .number(1),
                "acknowledgedThrough": .number(Double(retained)), "acknowledgedEventId": retained == 0 ? nil : .string("event:1"),
                "events": after == 0 ? fixture["eventPages"]!.array![0]["events"] : .array([]), "next": nil])
        } else if path.hasSuffix("/status/import") {
            statusBaselines.append(body?["expectedPublishedRevision"]?.number ?? -1)
            #expect(body?["expectedPublishedRevision"]?.number == Double(publishedRevision))
            statusNext = body?["page"]?["next"]?.string
            if statusNext == nil { publishedRevision += 1 }
            result = fixture["statusImports"]!.array![statusNext == nil ? 1 : 0]
        } else if path.hasSuffix("/status") {
            result = fixture["statusPages"]!.array![request.query.isEmpty ? 0 : 1]
        } else if path.hasSuffix("/reads/exchange") {
            result = courierObject(fixture["readExchangeResponse"]!, ["requests": .array([fixture["readRequests"]!.array![0]]), "more": .bool(false), "next": nil])
        } else if path.hasSuffix("/reads/execute") {
            #expect(body == fixture["readRequests"]!.array![0])
            if disconnectRead { throw URLError(.networkConnectionLost) }
            result = fixture["readResponses"]!.array![0]
        } else if path.hasSuffix("/reads/import") {
            readOutcome = body?["outcome"]
            result = fixture["readImports"]!.array![0]
        } else { throw ControlCourierFailure(.incompatible, status: 404) }
        return try JSONEncoder().encode(result)
    }

    private func receipt(pending: Bool = false) -> JSONValue {
        courierObject(fixture["acknowledgments"]!.array![1]["receipt"]!, [
            "payloadHash": operation["payloadHash"], "state": .string(pending ? "pending" : "accepted"),
        ])
    }
    private func eventAck() -> JSONValue {
        courierObject(fixture["eventAcknowledgment"]!, ["through": .number(Double(imported)), "eventId": imported == 0 ? nil : .string("event:1")])
    }
}

@Suite struct ControlCourierPassTests {
    @Test @MainActor func lostDeliveryReplyReconcilesTheSameOriginalReceiptBeforeAnotherDelivery() async throws {
        let probe = try CourierWireProbe()
        probe.loseDeliveryReply = true
        do { _ = try await probe.pass().step(.init(check: {})); Issue.record("Expected lost reply") } catch {}
        #expect(probe.deliveries == 1 && !probe.adopted)
        _ = try await probe.pass().step(.init(check: {}))
        #expect(probe.deliveries == 1 && probe.adopted)
        #expect(probe.calls.filter { $0 == "target:operations/receipt" }.count == 2)
        #expect(!probe.calls.contains { $0.contains("sessions/") || $0.contains("chat-create") })
    }

    @Test @MainActor func pendingReceiptIsNeverAdoptedAndDoesNotOccupyAnotherHostsQueue() async throws {
        let probe = try CourierWireProbe()
        probe.pendingDelivery = true
        let more = try await probe.pass().step(.init(check: {}))
        #expect(more, "Facts remain in this bounded pass even when the action head is pending")
        #expect(probe.deliveries == 1 && !probe.adopted)
    }

    @Test @MainActor func replacedConnectionCannotAdoptAHeldReceipt() async throws {
        let probe = try CourierWireProbe()
        probe.accepted = true; probe.holdLookup = true
        let pass = try probe.pass()
        let task = Task {
            defer { probe.finishLookupWait() }
            return try await pass.step(.init(check: { if !probe.current { throw HostRoutingError.staleGeneration } }))
        }
        await probe.waitForHeldLookup()
        guard probe.held != nil else {
            _ = try await task.value
            Issue.record("Pass completed without reaching the held receipt lookup")
            return
        }
        probe.current = false; probe.held?.resume(); probe.held = nil
        do { _ = try await task.value; Issue.record("Stale receipt was adopted") } catch {}
        #expect(!probe.adopted && probe.deliveries == 0)
    }

    @Test @MainActor func lostHomeEventImportReplyUsesDurableCursorAndReplaysOnlyItsExactAck() async throws {
        let probe = try CourierWireProbe()
        probe.adopted = true; probe.loseImportReply = true
        let first = try probe.pass()
        _ = try await first.step(.init(check: {}))
        do { _ = try await first.step(.init(check: {})); Issue.record("Expected lost import reply") } catch {}
        #expect(probe.imported == 1 && probe.retained == 0 && probe.notices == 1)
        let restarted = try probe.pass()
        _ = try await restarted.step(.init(check: {}))
        _ = try await restarted.step(.init(check: {}))
        #expect(probe.queries == [0, 1])
        #expect(probe.imported == 1 && probe.retained == 1 && probe.notices == 1)
    }

    @Test @MainActor func courierSignerBindsExactBytesAndCannotAuthorizeManagementOrNakedChatCreate() async throws {
        let probe = try CourierWireProbe()
        let capability = try courierObject(probe.fixture["courierCapability"]!, ["expiresAt": .number(9_999_999_999_999)]).decode(ControlCourierCapability.self)
        let key = Curve25519.Signing.PrivateKey()
        let signer = ControlCourierSigning(capability: capability, sign: { try key.signature(for: $0) })
        let body = try JSONEncoder().encode(probe.operation)
        let authentication = try await signer.authentication(method: "POST", path: "/api/operations/receipt", body: body)
        var signed = Data("courier-v1\n".utf8); signed.append(Data(authentication.signedPayload.utf8))
        #expect(key.publicKey.isValidSignature(Data(base64Encoded: authentication.signature)!, for: signed))
        let proof = try JSONValue.decode(Data(authentication.signedPayload.utf8))
        #expect(proof["path"]?.string == "/api/operations/receipt")
        let issuedAt = try #require(proof["issuedAt"]?.number)
        #expect(issuedAt == issuedAt.rounded(.down), "The daemon requires safe integer milliseconds")
        #expect(proof["bodyHash"]?.string == SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined())
        #expect(!signer.permits(ControlCourierRequest(path: ["control-hosts", capability.bindingId, "enrollment"], method: "POST", scope: .exchange), on: probe.target))
        let naked = courierObject(probe.operation, ["kind": .string("chat-create")])
        let nakedBody = try JSONEncoder().encode(naked)
        #expect(!signer.permits(ControlCourierRequest(path: ["operations"], method: "POST", body: nakedBody, scope: .exchange), on: probe.target))
    }

    @Test @MainActor func statusResumesHomeStageWithItsOriginalCASAndReadsReturnToOriginalWaiter() async throws {
        let probe = try CourierWireProbe()
        probe.adopted = true
        let pass = try probe.pass()
        for _ in 0..<5 { _ = try await pass.step(.init(check: {})) }
        #expect(probe.statusBaselines == [0, 0])
        #expect(probe.publishedRevision == 1 && probe.statusNext == nil)
        #expect(probe.readOutcome?["requestId"] == probe.fixture["readRequests"]!.array![0]["requestId"])
        #expect(probe.readOutcome?["host"] == probe.fixture["readRequests"]!.array![0]["host"])
        #expect(probe.readOutcome?["response"]?["untrusted"]?.bool == true)
    }

    @Test @MainActor func failedSelectedHostReadImportsUnavailableWithoutFabricatedCaptureOrEmptyResult() async throws {
        let probe = try CourierWireProbe()
        probe.adopted = true; probe.disconnectRead = true
        let pass = try probe.pass()
        for _ in 0..<4 { _ = try await pass.step(.init(check: {})) }
        #expect(probe.readOutcome?["availability"]?.string == "disconnected")
        #expect(probe.readOutcome?["requestId"] == probe.fixture["readRequests"]!.array![0]["requestId"])
        #expect(probe.readOutcome?["response"] == nil)
        #expect(probe.readOutcome?["error"]?["code"]?.string == "read_unavailable")
    }

    @Test @MainActor func executorCheckpointCannotStandInForHomeDurableImportState() async throws {
        let probe = try CourierWireProbe()
        probe.adopted = true; probe.foreignCheckpoint = true
        let pass = try probe.pass()
        _ = try await pass.step(.init(check: {}))
        do {
            _ = try await pass.step(.init(check: {}))
            Issue.record("Executor checkpoint was accepted as home ownership")
        } catch let error as ControlCourierFailure { #expect(error.kind == .reconciliationRequired) }
        #expect(probe.queries.isEmpty && probe.imported == 0 && probe.retained == 0 && probe.notices == 0)
    }
}
