import Foundation
import PilotCore
import Testing

struct ControlHostsProtocolTests {
    private func fixtures() throws -> [String: Any] {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("packages/protocol/fixtures/control-hosts.json"))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// Compare the JSON too: equality of decoded structs alone would miss a dropped wire field.
    @discardableResult
    private func roundTrip<Value: Codable & Equatable>(_ type: Value.Type, _ source: Any) throws -> Value {
        let data = try JSONSerialization.data(withJSONObject: source)
        let value = try JSONDecoder().decode(type, from: data)
        let encoded = try JSONEncoder().encode(value)
        #expect(try JSONDecoder().decode(type, from: encoded) == value)
        #expect(try JSONValue.decode(encoded) == JSONValue.decode(data))
        return value
    }

    @Test func hostIdentityRequestsAndAuthorizationScopeRoundTrip() throws {
        let f = try fixtures()
        let hellos = try roundTrip([DaemonHello].self, #require(f["hellos"]))
        #expect(hellos[0].capabilities.controlHosts == nil)
        #expect(hellos[0].controlHost == nil)
        #expect(hellos[1].capabilities.controlHosts == 1)
        #expect(hellos.dropFirst().compactMap { $0.controlHost?.role } == [.home, .executor, .archivedControl])
        let cutovers = try roundTrip([ControlHostCutover].self, #require(f["cutovers"]))
        #expect(cutovers.map(\.state) == [.preparing, .ready, .archived])
        #expect(cutovers[0].watchEventId == nil)
        #expect(cutovers[1].actionReceiptOperationId == "operation:1")
        let configurations = try roundTrip([ControlHostConfiguration].self, #require(f["configurations"]))
        #expect(configurations.map(\.role) == [.home, .executor, .archivedControl])
        #expect(configurations[0].host == configurations[0].home)
        #expect(configurations[2].archive?.sessionId == "old-control")
        _ = try roundTrip([ControlHomeEnrollment].self, #require(f["enrollments"]))
        let requests = try roundTrip([ControlHostRequest].self, #require(f["requests"]))
        #expect(Set(requests.map(\.action)) == Set(ControlPilotAction.allCases))
        #expect(requests[0].host == nil)
        #expect(requests[1].host?.daemonId == "executor-daemon")
        let grants = try roundTrip([ControlAuthorization].self, #require(f["authorizations"]))
        #expect(grants[0].hosts?.count == 2)
        #expect(grants[1].hosts == nil)
        #expect(grants[2].hosts == [])
        #expect(grants[0].targets[0].host?.daemonId == "executor-daemon")
    }

    @Test func allOperationPayloadsAndReceiptStatesRoundTrip() throws {
        let f = try fixtures()
        let payloads = try #require(f["payloads"] as? [[String: Any]])
        var kinds = Set<ControlOperationKind>()
        var actions = Set<ControlRunOperationPayload.Action>()
        for item in payloads {
            let rawKind = try #require(item["kind"] as? String)
            let kind = try #require(ControlOperationKind(rawValue: rawKind))
            let payload = try #require(item["payload"])
            kinds.insert(kind)
            switch kind {
            case .start: _ = try roundTrip(ControlStartOperationPayload.self, payload)
            case .send: _ = try roundTrip(ControlSendOperationPayload.self, payload)
            case .run:
                let run = try roundTrip(ControlRunOperationPayload.self, payload)
                #expect((run.action == .redirect) == (run.message != nil))
                actions.insert(run.action)
            case .watch: _ = try roundTrip(ControlWatchOperationPayload.self, payload)
            case .unwatch: _ = try roundTrip(ControlUnwatchOperationPayload.self, payload)
            case .revoke: _ = try roundTrip(ControlRevokeOperationPayload.self, payload)
            case .archive: _ = try roundTrip(ControlArchiveOperationPayload.self, payload)
            }
        }
        #expect(kinds == Set(ControlOperationKind.allCases))
        #expect(actions == Set(ControlRunOperationPayload.Action.allCases))
        _ = try roundTrip(ControlOperationExchangeRequest.self, #require(f["exchangeRequest"]))
        let exchange = try roundTrip(ControlOperationExchangeResponse.self, #require(f["exchange"]))
        let operation = try #require(exchange.operations.first)
        let acks = try roundTrip([ControlOperationAcknowledgment].self, #require(f["acknowledgments"]))
        #expect(acks.map(\.receipt.state) == [.pending, .accepted, .rejected])
        for ack in acks {
            #expect(ack.operation == operation)
            #expect(ack.receipt.operationId == operation.operationId)
            #expect(ack.receipt.payloadHash == operation.payloadHash)
            #expect(ack.receipt.destination.daemonId == operation.destination.daemonId)
        }
        let accepted = try #require(acks.first { $0.receipt.state == .accepted })
        let result = try #require(accepted.receipt.result)
        let decoded = try JSONDecoder().decode(ControlOperationResult.self, from: JSONEncoder().encode(result))
        #expect(decoded.kind == .start)
        #expect(decoded.sessionId == operation.targetId)
    }

    @Test func enrollmentCourierQueriesAndArchiveTransitionRoundTrip() throws {
        let f = try fixtures()
        let enrollments = try roundTrip([ControlHomeEnrollmentRequest].self, #require(f["enrollmentRequests"]))
        #expect(enrollments[0].expectedGeneration == nil)
        #expect(enrollments[2].expectedGeneration == 1)
        let constructed = ControlHomeEnrollmentRequest(enrollment: enrollments[0].enrollment,
                                                      peerHello: enrollments[0].peerHello, expectedGeneration: nil)
        #expect(constructed == enrollments[0])
        // Explicit null is a CAS assertion, not an optional field that may be silently omitted.
        let encoded = try JSONValue.decode(JSONEncoder().encode(constructed))
        #expect(encoded["expectedGeneration"] == .null)
        var missing = try #require((f["enrollmentRequests"] as? [[String: Any]])?.first)
        missing.removeValue(forKey: "expectedGeneration")
        let missingData = try JSONSerialization.data(withJSONObject: missing)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(ControlHomeEnrollmentRequest.self, from: missingData)
        }
        let states = try roundTrip([ControlHostStateResponse].self, #require(f["hostStates"]))
        #expect(states[0].cutover == nil)
        #expect(states[1].cutover?.state == .ready)
        let request = try roundTrip(ControlArchiveRequest.self, #require(f["archiveRequest"]))
        #expect(ControlArchiveRequest(expectedGeneration: 1, sessionId: "old-control", idempotencyKey: "archive:1") == request)
        let response = try roundTrip(ControlArchiveResponse.self, #require(f["archiveResponse"]))
        #expect(response.operation.kind == .archive)
        #expect(response.operation.operationId == request.idempotencyKey)
        #expect(response.operation.targetId == request.sessionId)
        let result = try roundTrip(ControlArchiveResult.self, #require(f["archiveResult"]))
        #expect(result.configuration.role == .archivedControl)
        #expect(result.cutover.state == .archived)
        let acks = try roundTrip([ControlOperationAcknowledgment].self, #require(f["archiveAcknowledgments"]))
        for ack in acks {
            let generic = ack.operation.durableOperation
            #expect(generic.payload == ack.operation.payload)
            #expect(generic.operationId == ack.operation.operationId)
            try ack.receipt.validate(generic)
            #expect(ControlOperationAcknowledgment(operation: ack.operation, receipt: ack.receipt) == ack)
        }
        let queries = try roundTrip([ControlOperationExchangeRequest].self, #require(f["outboxQueries"]))
        let pages = try roundTrip([ControlOperationExchangeResponse].self, #require(f["outboxPages"]))
        #expect(queries[1].cursor == pages[0].next)
        #expect(ControlOperationExchangeRequest(peer: queries[0].peer) == queries[0])
        _ = try roundTrip([ControlReceiptAdoptionResponse].self, #require(f["receiptAdoptions"]))
        let events = try roundTrip([ControlRemoteEventQuery].self, #require(f["eventQueries"]))
        #expect(ControlRemoteEventQuery(after: 0, limit: 128) == events[0])
        let statuses = try roundTrip([ControlRemoteStatusQuery].self, #require(f["statusQueries"]))
        #expect(ControlRemoteStatusQuery() == statuses[0])
        let imports = try roundTrip([ControlRemoteStatusImportResponse].self, #require(f["statusImports"]))
        #expect(imports.map(\.state) == [.staged, .published])
        #expect(statuses[1].cursor == imports[0].next)
    }

    @Test func journalCursorsAndStatusCapturePagesRoundTrip() throws {
        let f = try fixtures()
        let pages = try roundTrip([ControlRemoteEventPage].self, #require(f["eventPages"]))
        let event = try #require(pages.first?.events.first)
        #expect(event.resultTail?.untrusted == true)
        #expect(event.resultTail?.text == "Result <untrusted> café 🛠")
        #expect(event.watchId == event.watch.id)
        #expect(pages[0].next == event.cursor)
        #expect(pages[1].events.isEmpty)
        #expect(pages[1].next == nil)
        let ack = try roundTrip(ControlRemoteEventAcknowledgment.self, #require(f["eventAcknowledgment"]))
        #expect(ack.sourceHost == event.sourceHost)
        #expect(ack.through == event.cursor)
        let snapshots = try roundTrip([ControlRemoteStatusPage].self, #require(f["statusPages"]))
        #expect(snapshots[0].snapshot.snapshotId == snapshots[1].snapshot.snapshotId)
        #expect(snapshots[0].snapshot.capturedAt == snapshots[1].snapshot.capturedAt)
        #expect(snapshots[0].snapshot.missionTasks.first?.state == .accepted)
        #expect(snapshots[1].snapshot.missionTasks.first?.context == .provisional)
        #expect(snapshots[0].next != nil)
        #expect(snapshots[1].next == nil)
    }
}
