import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class RecoveryHTTPStub: URLProtocol {
    struct Request { let host: String; let path: String; let operation: DurableOperation? }
    enum Mode { case loseAcceptedReply, pending, unknown, wrongIdentity, stopLost, stopAcknowledged }
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var mode = Mode.loseAcceptedReply
        var requests: [Request] = []
        var accepted: Set<String> = []
    }
    private static let state = State()
    static func reset(_ mode: Mode) {
        state.lock.lock(); defer { state.lock.unlock() }
        state.mode = mode; state.requests = []; state.accepted = []
    }
    static var requests: [Request] {
        state.lock.lock(); defer { state.lock.unlock() }
        return state.requests
    }
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix("recovery.invalid") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let data = request.httpBody ?? request.httpBodyStream.map { stream in
            stream.open(); defer { stream.close() }
            var result = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                result.append(buffer, count: count)
            }
            return result
        } ?? Data()
        let operation = try? JSONDecoder().decode(DurableOperation.self, from: data)
        Self.state.lock.lock()
        let mode = Self.state.mode
        Self.state.requests.append(Request(host: url.host!, path: url.path, operation: operation))
        let previouslyAccepted = operation.map { Self.state.accepted.contains($0.operationId) } ?? false
        if url.path == "/api/operations", let operation { Self.state.accepted.insert(operation.operationId) }
        Self.state.lock.unlock()
        if url.path == "/api/hello" {
            let hello = """
            {"daemonId":"remote","lineageId":"cloned-lineage","daemonVersion":"test","protocolVersion":1,
            "minimumClientProtocolVersion":1,"platform":"linux","arch":"x64","capabilities":{
            "powerManagement":false,"systemSleepEvents":false,"swiftUIArtifacts":false,
            "coordinatorIsolation":true,"independentExecution":true}}
            """
            reply(Data(hello.utf8)); return
        }
        if url.path.hasSuffix("/stop") {
            if mode == .stopLost { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)) }
            else { reply(Data("{}".utf8)) }
            return
        }
        guard let operation else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
        }
        if url.path == "/api/operations", mode == .loseAcceptedReply {
            // The daemon durably accepted the mutation, but the client never saw its response.
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        if mode == .unknown || (mode == .loseAcceptedReply && !previouslyAccepted) {
            reply(Data("{\"state\":\"unknown\"}".utf8)); return
        }
        let receipt: [String: Any] = [
            "operationId": operation.operationId, "payloadHash": operation.payloadHash,
            "targetId": operation.targetId,
            "destination": ["hostId": operation.destination.hostId, "daemonId": operation.destination.daemonId,
                            "lineageId": mode == .wrongIdentity ? "cloned-lineage" : operation.destination.lineageId],
            "state": mode == .pending ? "pending" : "accepted",
            "result": ["sessionId": operation.targetId],
        ]
        reply(try! JSONSerialization.data(withJSONObject: receipt))
    }
    private func reply(_ data: Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor private func recoveryClient(local: Bool = false, state: String = "working") -> PilotClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RecoveryHTTPStub.self]
    let client = PilotClient(baseURL: URL(string: "http://\(local ? "local" : "remote").recovery.invalid")!,
                             commandConfiguration: configuration)
    client.loadFixture(projects: [], sessions: [SessionSummary(id: "same", title: "Chat", cwd: "/repo",
        createdAt: 0, updatedAt: 0, state: state)])
    return client
}

@Suite(.serialized) struct RemoteOperationRecoveryTests {
    private let origin = HostRef(hostId: "local", daemonId: "local", lineageId: "l1")
    private let target = HostRef(hostId: "box", daemonId: "remote", lineageId: "r1")

    @Test @MainActor func lostAcceptanceReconcilesReceiptsAfterRelaunchWithoutDuplicatePostOrDraftAdoption() async throws {
        RecoveryHTTPStub.reset(.loseAcceptedReply)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory)
        try hosts.install(recoveryClient(), host: target)
        try hosts.install(recoveryClient(local: true), host: origin)
        let (operation, delivery) = try await hosts.deliver(host: target, kind: "chat-create", targetId: nil,
                                                          payload: ["message": "keep this draft"], origin: origin)
        #expect(delivery == .unknown)
        let initialRequests = RecoveryHTTPStub.requests
        let mutation = try #require(initialRequests.firstIndex { $0.path == "/api/operations" })
        #expect(initialRequests[..<mutation].contains { $0.path == "/api/operations/receipt" })
        #expect(initialRequests.filter { $0.path == "/api/operations" }.count == 1)
        await hosts.disconnect(target)

        let restarted = HostClients(operationDirectory: directory)
        try await restarted.restoreOffline(from: OfflineHostStore(directory: directory.appendingPathComponent("hosts")))
        #expect(restarted.pendingOperations[operation.operationId] == operation)
        #expect(restarted.operationDeliveries[operation.operationId] == .unknown)
        try restarted.install(recoveryClient(), host: target)
        try restarted.install(recoveryClient(local: true), host: origin)
        try await restarted.reconcileOperations(target)
        let recovered = try #require(restarted.operationDeliveries[operation.operationId])
        guard case let .receipt(receipt) = recovered else { Issue.record("Lost accepted receipt was not recovered"); return }
        #expect(receipt.state == .accepted)
        #expect(restarted.pendingOperations[operation.operationId] == operation, "The composer, not reconnect, adopts the receipt")
        #expect(try await OperationOutbox(directory: directory).pending() == [operation])
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/operations" }.count == 1)
        #expect(RecoveryHTTPStub.requests.allSatisfy { $0.host == "remote.recovery.invalid" })
        // An explicit matching retry still checks the receipt and uses the original operation/target.
        let (retry, repeated) = try await restarted.deliver(host: target, kind: "chat-create", targetId: nil,
            payload: ["message": "keep this draft"], origin: origin)
        #expect(retry == operation)
        #expect(repeated == recovered)
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/operations" }.count == 1)
        try await restarted.acknowledge(operation, receipt: receipt)
        #expect(try await OperationOutbox(directory: directory).pending().isEmpty)
        await restarted.disconnect(target)
        await restarted.disconnect(origin)
    }

    @Test @MainActor func pendingUnknownAndForeignReceiptsNeverTriggerAutomaticExecutionOrLocalFallback() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = OperationOutbox(directory: directory)
        let operation = try await outbox.reserve(kind: "chat-send", targetId: "same", payload: ["message": "retained"],
                                                origin: origin, destination: target)
        let hosts = HostClients(operationDirectory: directory)
        RecoveryHTTPStub.reset(.pending)
        try hosts.install(recoveryClient(), host: target)
        let (same, pending) = try await hosts.deliver(host: target, kind: "chat-send", targetId: "same",
                                                    payload: ["message": "retained"], origin: origin)
        #expect(same == operation)
        guard case let .receipt(receipt) = pending else { Issue.record("Expected pending receipt"); return }
        #expect(receipt.state == .pending)
        #expect(RecoveryHTTPStub.requests.allSatisfy { $0.path == "/api/operations/receipt" })
        RecoveryHTTPStub.reset(.unknown)
        try await hosts.reconcileOperations(target)
        #expect(hosts.operationDeliveries[operation.operationId] == pending, "A stale unknown lookup cannot erase known durable ownership")
        #expect(RecoveryHTTPStub.requests.allSatisfy { $0.path == "/api/operations/receipt" })
        RecoveryHTTPStub.reset(.wrongIdentity)
        let (_, foreign) = try await hosts.deliver(host: target, kind: "chat-send", targetId: "same",
                                                  payload: ["message": "retained"], origin: origin)
        #expect(foreign == .unknown)
        #expect(RecoveryHTTPStub.requests.allSatisfy { $0.path == "/api/operations/receipt" })
        await hosts.disconnect(target)
        let before = RecoveryHTTPStub.requests.count
        try hosts.install(recoveryClient(local: true), host: origin)
        do {
            _ = try await hosts.deliver(host: target, kind: "chat-send", targetId: "same",
                                        payload: ["message": "retained"], origin: origin)
            Issue.record("Offline send was admitted")
        } catch { #expect(error as? HostRoutingError == .disconnected) }
        #expect(RecoveryHTTPStub.requests.count == before)
        #expect(try await outbox.pending() == [operation])
        await hosts.disconnect(origin)
    }

    @Test @MainActor func lostStopReplyRemainsRequestedAcrossRestartAndIdleSnapshotIsNotAcknowledgment() async throws {
        RecoveryHTTPStub.reset(.stopLost)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        try await hosts.restoreOffline(from: OfflineHostStore(directory: directory.appendingPathComponent("hosts")))
        try await hosts.enroll(target, configuration: SSHConnectionConfiguration(alias: "fixture-box"))
        try hosts.install(recoveryClient(), host: target)
        let ref = HostResourceRef(host: target, kind: .session, localId: "same")
        do { _ = try await hosts.requestStop(ref); Issue.record("Lost response was acknowledged") } catch {}
        #expect(hosts.offlineHosts[target]?.stopRequests["same"] == .requested)
        #expect(hosts.sessions.first?.value.state == "working")
        #expect(hosts.sessions.first?.value.outcome == nil)
        await hosts.disconnect(target)
        try await hosts.flushOffline()
        let restarted = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        try await restarted.restoreOffline(from: OfflineHostStore(directory: directory.appendingPathComponent("hosts")))
        try restarted.install(recoveryClient(state: "idle"), host: target)
        #expect(restarted.offlineHosts[target]?.stopRequests["same"] == .requested)
        #expect(RecoveryHTTPStub.requests.filter { $0.path.hasSuffix("/stop") }.count == 1)
        RecoveryHTTPStub.reset(.stopAcknowledged)
        _ = try await restarted.requestStop(ref)
        #expect(restarted.offlineHosts[target]?.stopRequests["same"] == .acknowledged)
        #expect(restarted.sessions.first?.value.outcome == nil, "Delivery acknowledgment is not a stopped outcome or seal")
        await restarted.disconnect(target)
    }

    @Test @MainActor func daemonOnlyReconnectRechecksPinsBeforeOpeningControlOrTranscriptStreams() async throws {
        RecoveryHTTPStub.reset(.wrongIdentity)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory)
        let client = recoveryClient()
        try hosts.install(client, host: target)
        client.connect(to: URL(string: "http://remote.recovery.invalid")!)
        let listener = client.subscribe("same") { _ in Issue.record("Wrong-identity stream delivered events") }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while client.connectionError == nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(client.connectionError == .identityChanged)
        #expect(!client.connected)
        #expect(client.hostIdentity == target)
        #expect(hosts.sessions.first?.value.state == "working")
        #expect(hosts.sessions.first?.value.outcome == nil)
        #expect(!RecoveryHTTPStub.requests.isEmpty)
        #expect(RecoveryHTTPStub.requests.allSatisfy { $0.path == "/api/hello" })
        client.unsubscribe("same", token: listener)
        await hosts.disconnect(target)
    }
}
