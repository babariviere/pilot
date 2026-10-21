import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class RepairArchiveHTTP: URLProtocol {
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var failures = 0
        var posts: [String] = []
    }
    private static let state = State()
    static func reset(failures: Int = 0) {
        state.lock.lock(); defer { state.lock.unlock() }
        state.failures = failures; state.posts = []
    }
    static var posts: [String] {
        state.lock.lock(); defer { state.lock.unlock() }
        return state.posts
    }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix("repair-archive.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        guard url.path.hasSuffix("/archive") else { reply(Data(), status: 500); return }
        Self.state.lock.lock()
        Self.state.posts.append(url.host! + url.path)
        let fail = Self.state.failures > 0
        Self.state.failures = max(0, Self.state.failures - 1)
        Self.state.lock.unlock()
        if fail { reply(Data(#"{"error":"Archive unavailable"}"#.utf8), status: 503); return }
        reply(try! JSONEncoder().encode(SessionSummary(id: "origin", title: "Diagnostics", cwd: "/tmp",
            createdAt: 1, updatedAt: 2, state: "idle", archivedAt: 3, role: .diagnostics)))
    }
    private func reply(_ data: Data, status: Int = 200) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: nil, headerFields: ["content-type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite(.serialized) struct DiagnosticRepairArchiveTests {
    private let local = HostRef(hostId: "local", daemonId: "mac", lineageId: "one")

    @MainActor private func fixture(_ directory: URL, host: HostRef, operation: DurableOperation,
                                   archived: Bool = false, specialist: Bool = true) throws -> AppModel {
        func client(_ host: HostRef) -> PilotClient {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [RepairArchiveHTTP.self]
            configuration.timeoutIntervalForRequest = 3
            configuration.timeoutIntervalForResource = 5
            let client = PilotClient(baseURL: URL(string: "http://\(host.hostId).repair-archive.invalid"),
                                     commandConfiguration: configuration)
            client.loadFixture(projects: [], sessions: [
                SessionSummary(id: "origin", title: "Diagnostics", cwd: "/tmp", createdAt: 1, updatedAt: 2,
                    state: "idle", archivedAt: archived && host == operation.destination ? 3 : nil,
                    role: specialist ? .diagnostics : nil),
                SessionSummary(id: operation.targetId, title: "Repair", cwd: "/tmp", createdAt: 3, updatedAt: 3, state: "idle")
            ])
            return client
        }
        let hosts = ClientDirectory(operationDirectory: directory)
        let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: UUID().uuidString)!,
            client: client(local), hosts: hosts)
        try app.registerLocal(local)
        try hosts.install(app.client, host: local)
        guard host == local else { throw HostRoutingError.disconnected }
        return app
    }

    private func operation(_ directory: URL, host: HostRef, disclosed: Bool? = true) async throws -> DurableOperation {
        let admission = DiagnosticRepairAdmission(specialistSessionId: "origin", proposalId: "reviewed-proposal",
            subject: .app(host: host), binding: nil, repairTitle: "Fix reconnect", archiveSpecialistOnStart: disclosed)
        return try await OperationOutbox(directory: directory).reserve(kind: "repair-create", targetId: nil,
            payload: SpawnRequest(message: "Reviewed repair", mode: .build, diagnosticRepair: admission),
            origin: local, destination: host)
    }

    private func receipt(_ operation: DurableOperation, state: String = "accepted", sessionId: String? = nil) throws -> OperationReceipt {
        let host = operation.destination
        return try JSONDecoder().decode(OperationReceipt.self, from: JSONSerialization.data(withJSONObject: [
            "operationId": operation.operationId, "payloadHash": operation.payloadHash, "targetId": operation.targetId,
            "destination": ["hostId": host.hostId, "daemonId": host.daemonId, "lineageId": host.lineageId],
            "state": state, "result": ["sessionId": sessionId ?? operation.targetId]
        ]))
    }

    @Test(.timeLimit(.minutes(1))) @MainActor func acceptedRepairArchivesOnlyQualifiedOriginAndKeepsHistory() async throws {
        for host in [local] {
            RepairArchiveHTTP.reset()
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let op = try await operation(directory, host: host)
            let app = try fixture(directory, host: host, operation: op)
            let ref = HostResourceRef(host: host, kind: .session, localId: "origin")
            let delivery = OperationDelivery.receipt(try receipt(op))
            // Explicit app-actor callers keep this regression independent of async-let executor inheritance.
            let first = Task { @MainActor in try await app.finishDiagnosticRepairStart(op, delivery: delivery, reference: ref) }
            let second = Task { @MainActor in try await app.finishDiagnosticRepairStart(op, delivery: delivery, reference: ref) }
            defer { first.cancel(); second.cancel() }
            let one = try await first.value
            let two = try await second.value
            #expect(one == two && one.localId == op.targetId && one.host == host)
            #expect(app.hosts.selection == one)
            #expect(RepairArchiveHTTP.posts == ["\(host.hostId).repair-archive.invalid/api/sessions/origin/archive"])
            #expect(try await OperationOutbox(directory: directory).pending().isEmpty)
            if host != local { #expect(app.client.session("origin")?.isArchived == false, "colliding Local ID is untouched") }
        }
    }

    @Test(.timeLimit(.minutes(1))) @MainActor func archiveFailureSurvivesReopenAndNeverCreatesAnotherRepair() async throws {
        RepairArchiveHTTP.reset(failures: 1)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let op = try await operation(directory, host: local)
        let ref = HostResourceRef(host: local, kind: .session, localId: "origin")
        let app = try fixture(directory, host: local, operation: op)
        await #expect(throws: ClientError.self) {
            _ = try await app.finishDiagnosticRepairStart(op, delivery: .receipt(receipt(op)), reference: ref)
        }
        #expect(app.hosts.selection?.localId == op.targetId)
        let pending = try await OperationOutbox(directory: directory).pending()
        #expect(pending == [op])
        // Reopen with no proposal/binding in the current origin summary. Only the original receipt matters.
        let reopened = try fixture(directory, host: local, operation: op)
        let recovered = try #require(pending.first)
        _ = try await reopened.finishDiagnosticRepairStart(recovered, delivery: .receipt(receipt(recovered)), reference: ref)
        #expect(try await OperationOutbox(directory: directory).pending().isEmpty)
        #expect(RepairArchiveHTTP.posts.count == 2, "only archival, never a second create or Stop")
    }

    @Test(.timeLimit(.minutes(1))) @MainActor func unconfirmedWrongIdentityLegacyAndManualArchiveAreSafe() async throws {
        for mode in ["unknown", "pending", "rejected", "wrong_result", "wrong_host", "wrong_role", "legacy", "manual"] {
            RepairArchiveHTTP.reset()
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let op = try await operation(directory, host: local, disclosed: mode == "legacy" ? nil : true)
            let app = try fixture(directory, host: local, operation: op, archived: mode == "manual", specialist: mode != "wrong_role")
            let ref = HostResourceRef(host: mode == "wrong_host" ? HostRef(hostId: "box", daemonId: "other", lineageId: "other") : local, kind: .session, localId: "origin")
            let delivery: OperationDelivery = mode == "unknown" ? .unknown : .receipt(try receipt(op,
                state: ["pending", "rejected"].contains(mode) ? mode : "accepted", sessionId: mode == "wrong_result" ? "other" : nil))
            if ["legacy", "manual"].contains(mode) {
                _ = try await app.finishDiagnosticRepairStart(op, delivery: delivery, reference: ref)
            } else {
                await #expect(throws: (any Error).self) {
                    _ = try await app.finishDiagnosticRepairStart(op, delivery: delivery, reference: ref)
                }
            }
            #expect(RepairArchiveHTTP.posts.isEmpty)
        }
    }
}
