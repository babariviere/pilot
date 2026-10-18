import AppKit
import Combine
import Foundation
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private final class RecoveryHTTPStub: URLProtocol {
    struct Request { let host: String; let path: String; let operation: DurableOperation? }
    enum Mode { case normal, accepted, loseAcceptedReply, pending, pendingThenAccepted, unknown, failedLookup, missingChat, heldLookup, rejected, wrongIdentity, stopLost, stopAcknowledged }
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var mode = Mode.loseAcceptedReply
        var requests: [Request] = []
        var accepted: Set<String> = []
        var lookups = 0
        var held: [RecoveryHTTPStub] = []
    }
    private static let state = State()
    static func reset(_ mode: Mode) {
        state.lock.lock(); defer { state.lock.unlock() }
        state.mode = mode; state.requests = []; state.accepted = []; state.lookups = 0
    }
    static func setMode(_ mode: Mode) {
        state.lock.lock(); defer { state.lock.unlock() }
        state.mode = mode; state.lookups = 0
    }
    static var heldCount: Int {
        state.lock.lock(); defer { state.lock.unlock() }
        return state.held.count
    }
    static func releaseLookups() {
        state.lock.lock()
        let held = state.held
        state.held = []
        state.lock.unlock()
        for item in held {
            if let operation = item.heldOperation { item.replyReceipt(operation, mode: .accepted, lookups: 0) }
        }
    }
    private var heldOperation: DurableOperation?
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
        if url.path == "/api/operations/receipt" { Self.state.lookups += 1 }
        let lookups = Self.state.lookups
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
        if url.path.hasPrefix("/api/sessions/"), request.httpMethod == "GET" {
            if mode == .missingChat { reply(Data("{\"error\":\"Unknown session\"}".utf8), status: 404); return }
            let session = SessionSummary(id: url.lastPathComponent, title: "Hello", cwd: "/repo", projectId: "p",
                                         createdAt: 0, updatedAt: 1, state: "working")
            reply(try! JSONEncoder().encode(session)); return
        }
        guard let operation else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
        }
        if mode == .failedLookup {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return
        }
        if mode == .heldLookup, url.path.hasSuffix("/receipt") {
            heldOperation = operation
            Self.state.lock.lock(); Self.state.held.append(self); Self.state.lock.unlock()
            return
        }
        if url.path == "/api/operations", mode == .loseAcceptedReply {
            // The daemon durably accepted the mutation, but the client never saw its response.
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        if mode == .unknown || ((mode == .loseAcceptedReply || mode == .normal) && !previouslyAccepted && url.path.hasSuffix("/receipt")) {
            reply(Data("{\"state\":\"unknown\"}".utf8)); return
        }
        replyReceipt(operation, mode: mode, lookups: lookups)
    }
    private func replyReceipt(_ operation: DurableOperation, mode: Mode, lookups: Int) {
        let receipt: [String: Any] = [
            "operationId": operation.operationId, "payloadHash": operation.payloadHash,
            "targetId": operation.targetId,
            "destination": ["hostId": operation.destination.hostId, "daemonId": operation.destination.daemonId,
                            "lineageId": mode == .wrongIdentity ? "cloned-lineage" : operation.destination.lineageId],
            "state": mode == .rejected ? "rejected" : (mode == .pending || (mode == .pendingThenAccepted && lookups < 2) ? "pending" : "accepted"),
            "result": ["sessionId": operation.targetId],
            "reason": "Project no longer exists",
        ]
        reply(try! JSONSerialization.data(withJSONObject: receipt))
    }
    private func reply(_ data: Data, status: Int = 200) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
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
    client.loadFixture(projects: [Project(id: "p", name: "Code", path: "/repo", workspace: "direct", createdAt: 0)], sessions: [SessionSummary(id: "same", title: "Chat", cwd: "/repo",
        createdAt: 0, updatedAt: 0, state: state)])
    return client
}

@Suite(.serialized) struct RemoteOperationRecoveryTests {
    private let origin = HostRef(hostId: "local", daemonId: "local", lineageId: "l1")
    private let target = HostRef(hostId: "box", daemonId: "remote", lineageId: "r1")

    @MainActor private func app(_ directory: URL, hosts: HostClients) throws -> AppModel {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let app = AppModel(projectFolderDefaults: defaults,
                           draftStore: DraftStore(directory: directory, attachmentDirectory: directory.deletingLastPathComponent()), hosts: hosts)
        try app.registerLocal(origin)
        app.newSessionForm.executionHost = target
        return app
    }

    @Test @MainActor func ordinaryRemoteCreateAdoptsAndOpensTheReservedChat() async throws {
        RecoveryHTTPStub.reset(.normal)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        let client = recoveryClient()
        try hosts.install(client, host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let form = app.newSessionForm
        form.message = "say hello world"
        let project = try #require(client.projects.first)
        try await app.createHostedChat(form: form, host: target, project: project, revision: form.revision)
        let mutation = try #require(RecoveryHTTPStub.requests.first { $0.path == "/api/operations" }?.operation)
        #expect(form.message.isEmpty)
        #expect(form.pendingOperationId == nil)
        #expect(hosts.pendingOperations.isEmpty)
        #expect(app.selectedSessionId == HostResourceRef(host: target, kind: .session, localId: mutation.targetId).storageKey)
        #expect(app.selectedSession?.id == mutation.targetId, "Navigation has the real summary before the list stream arrives")
        #expect(try DraftStore(directory: directory.appendingPathComponent("drafts")).load().selection?.localId == mutation.targetId)
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/operations" }.count == 1)
        await hosts.disconnect(target)
    }

    @Test @MainActor func homeCheckPublishesProgressThenAdoptsPendingToAcceptedWithoutAnotherCreate() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        let client = recoveryClient()
        try hosts.install(client, host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let form = app.newSessionForm
        form.message = "say hello world"
        do {
            let project = try #require(client.projects.first)
            try await app.createHostedChat(form: form, host: target, project: project, revision: form.revision)
            Issue.record("Pending create was adopted")
        } catch {}
        let id = try #require(form.pendingOperationId)
        let operation = try #require(hosts.pendingOperations[id])
        RecoveryHTTPStub.setMode(.pendingThenAccepted)
        var progress: [Bool] = []
        let subscription = form.$checkingStart.sink { progress.append($0) }
        // This is the same action used by Home's Check button, not a receipt-only stand-in.
        await app.checkHostedChat(operation, form: form, delay: .zero)
        #expect(progress == [false, true, false])
        withExtendedLifetime(subscription) {}
        #expect(form.error == nil)
        #expect(form.message.isEmpty && form.pendingOperationId == nil)
        #expect(app.selectedSessionId == HostResourceRef(host: target, kind: .session, localId: operation.targetId).storageKey)
        let reads = RecoveryHTTPStub.requests
        let receiptReads = reads.filter { $0.path == "/api/operations/receipt" }
        #expect(receiptReads.count == 3, "One initial lookup plus two bounded Check reads")
        #expect(receiptReads.allSatisfy { $0.operation == operation })
        #expect(reads.filter { $0.path == "/api/operations" }.isEmpty)
        #expect(app.selectedSession?.id == operation.targetId)
        await hosts.disconnect(target)
    }

    @Test @MainActor func pressingNativeHomeCheckActuallyChecksShowsProgressAndOpensTheExistingChat() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        let client = recoveryClient()
        client.fixtureModels = ModelList(models: [])
        client.fixtureBranches = RemoteBranchList(branches: [], defaultBranch: nil)
        try hosts.install(client, host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let form = app.newSessionForm
        form.message = "say hello world"
        let (operation, _) = try await hosts.deliver(host: target, kind: "chat-create", targetId: nil,
            payload: SpawnRequest(projectId: "p", message: form.message, mode: .build), origin: origin)
        form.pendingOperationId = operation.operationId
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 160),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        // This is Home's production recovery row, not a replacement button or a test action.
        // Mounting it alone avoids confusing a tab/menu control with Check in an offscreen window.
        let hosting = NSHostingView(rootView: HostedChatStartNotice(operation: operation, hosts: hosts, form: form,
            retryOriginal: { Issue.record("A pending receipt must not offer replay") }).environmentObject(app))
        window.contentView = hosting
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        window.orderFrontRegardless()
        window.update()
        hosting.layoutSubtreeIfNeeded()
        func controls<V: NSView>(_ view: NSView, of type: V.Type) -> [V] {
            (view as? V).map { [$0] } ?? view.subviews.flatMap { controls($0, of: type) }
        }
        let mountDeadline = ContinuousClock.now.advanced(by: .seconds(10))
        while controls(hosting, of: NSButton.self).isEmpty, ContinuousClock.now < mountDeadline {
            hosting.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
        }
        let buttons = controls(hosting, of: NSButton.self)
        try #require(buttons.count == 1, "A pending start has exactly one native recovery action: Check")
        let check = try #require(buttons.first)
        try #require(check.isEnabled)
        RecoveryHTTPStub.setMode(.heldLookup)
        defer { RecoveryHTTPStub.releaseLookups() }
        // Exercise the actual AppKit control's action without relying on headless window focus
        // or screen coordinates. Its closure is the exact one used by Home.
        check.performClick(nil)
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while RecoveryHTTPStub.heldCount == 0, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        #expect(RecoveryHTTPStub.heldCount == 1)
        #expect(form.checkingStart)
        while check.isEnabled, form.checkingStart, ContinuousClock.now < deadline {
            hosting.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(!check.isEnabled, "The mounted Check control is visibly disabled while checking")
        RecoveryHTTPStub.setMode(.accepted)
        RecoveryHTTPStub.releaseLookups()
        while form.checkingStart, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        #expect(!form.checkingStart && form.error == nil)
        #expect(form.pendingOperationId == nil && form.message.isEmpty)
        #expect(app.selectedSession?.id == operation.targetId)
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/operations/receipt" }.count == 2)
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/operations" }.isEmpty)
        await hosts.disconnect(target)
    }

    @Test @MainActor func failedCheckIsVisibleAndRecoverableAndUnresolvedChecksStayBounded() async throws {
        RecoveryHTTPStub.reset(.unknown)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        try hosts.install(recoveryClient(), host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let form = app.newSessionForm
        form.message = "keep this draft"
        let (operation, _) = try await hosts.deliver(host: target, kind: "chat-create", targetId: nil,
            payload: SpawnRequest(projectId: "p", message: form.message, mode: .build), origin: origin)
        form.pendingOperationId = operation.operationId
        RecoveryHTTPStub.setMode(.failedLookup)
        await app.checkHostedChat(operation, form: form, delay: .zero)
        #expect(form.error?.contains("Check again") == true)
        #expect(!form.checkingStart && form.message == "keep this draft")
        #expect(form.pendingOperationId == operation.operationId)
        RecoveryHTTPStub.setMode(.wrongIdentity)
        await app.checkHostedChat(operation, form: form, delay: .zero)
        #expect(form.error?.contains("identity changed") == true)
        #expect(form.pendingOperationId == operation.operationId && app.selectedSessionId == nil)
        RecoveryHTTPStub.setMode(.unknown)
        var before = RecoveryHTTPStub.requests.count
        await app.checkHostedChat(operation, form: form, delay: .zero)
        #expect(RecoveryHTTPStub.requests.count - before == 3)
        #expect(form.error == nil)
        #expect(form.startRecoveryMessage?.contains("does not prove") == true)
        #expect(hosts.pendingOperations[operation.operationId] == operation)
        RecoveryHTTPStub.setMode(.pending)
        before = RecoveryHTTPStub.requests.count
        await app.checkHostedChat(operation, form: form, delay: .zero)
        #expect(RecoveryHTTPStub.requests.count - before == 3)
        #expect(form.startRecoveryMessage?.contains("still unconfirmed") == true)
        #expect(form.message == "keep this draft" && app.selectedSessionId == nil)
        RecoveryHTTPStub.setMode(.normal)
        await app.checkHostedChat(operation, form: form, delay: .zero)
        #expect(form.error == nil && form.pendingOperationId == nil)
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/operations" }.count == 1)
        await hosts.disconnect(target)
    }

    @Test @MainActor func lostReplyRelaunchReconnectAndCheckOpenOriginalWithoutResending() async throws {
        RecoveryHTTPStub.reset(.loseAcceptedReply)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let operations = directory.appendingPathComponent("operations"), drafts = directory.appendingPathComponent("drafts")
        let hosts = HostClients(operationDirectory: operations)
        let client = recoveryClient()
        try hosts.install(client, host: target)
        let first = try app(drafts, hosts: hosts)
        first.newSessionForm.message = "say hello world"
        do {
            let project = try #require(client.projects.first)
            try await first.createHostedChat(form: first.newSessionForm, host: target, project: project, revision: first.newSessionForm.revision)
            Issue.record("Lost reply was adopted")
        } catch {}
        let id = try #require(first.newSessionForm.pendingOperationId)
        let original = try #require(hosts.pendingOperations[id])
        try first.persistDrafts()
        await hosts.disconnect(target)
        let restarted = HostClients(operationDirectory: operations)
        try await restarted.restoreOffline(from: OfflineHostStore(directory: directory.appendingPathComponent("hosts")))
        let second = try app(drafts, hosts: restarted)
        #expect(second.newSessionForm.pendingOperationId == id)
        try restarted.install(recoveryClient(), host: target)
        try await restarted.reconcileOperations(target)
        await second.checkHostedChat(original, form: second.newSessionForm, delay: .zero)
        #expect(second.newSessionForm.message.isEmpty)
        #expect(second.selectedSessionId == HostResourceRef(host: target, kind: .session, localId: original.targetId).storageKey)
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/operations" }.count == 1)
        #expect(RecoveryHTTPStub.requests.filter { $0.operation != nil }.allSatisfy { $0.operation == original && $0.host == "remote.recovery.invalid" })
        #expect(second.selectedSession?.id == original.targetId)
        await restarted.disconnect(target)
    }

    @Test @MainActor func confirmedOriginalKeepsNewerDraftAndAttachmentsUntilExplicitOpen() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        try hosts.install(recoveryClient(), host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let form = app.newSessionForm
        form.message = "original"
        let (operation, _) = try await hosts.deliver(host: target, kind: "chat-create", targetId: nil,
            payload: SpawnRequest(projectId: "p", message: form.message, mode: .build), origin: origin)
        form.pendingOperationId = operation.operationId
        form.message = "newer draft"
        let imageURL = directory.appendingPathComponent("newer.png")
        let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1, pixelsHigh: 1,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        bitmap.setColor(.black, atX: 0, y: 0)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: imageURL)
        let image = PastedImage(id: UUID(), url: imageURL, preview: NSImage(size: NSSize(width: 1, height: 1)))
        form.attachments.items = [image]
        RecoveryHTTPStub.setMode(.accepted)
        await app.checkHostedChat(operation, form: form, delay: .zero)
        #expect(form.startRecoveryMessage?.contains("newer draft") == true)
        #expect(form.message == "newer draft" && form.attachments.items.map(\.id) == [image.id])
        #expect(form.pendingOperationId == operation.operationId && app.selectedSessionId == nil)
        try app.persistDrafts()
        let restored = try self.app(directory.appendingPathComponent("drafts"), hosts: hosts)
        #expect(restored.newSessionForm.attachments.items.map(\.id) == [image.id])
        await restored.checkHostedChat(operation, form: restored.newSessionForm, openConfirmed: true, delay: .zero)
        #expect(restored.newSessionForm.message == "newer draft" && restored.newSessionForm.attachments.items.map(\.id) == [image.id])
        #expect(restored.newSessionForm.pendingOperationId == nil)
        #expect(restored.selectedSessionId == HostResourceRef(host: target, kind: .session, localId: operation.targetId).storageKey)
        #expect(FileManager.default.fileExists(atPath: imageURL.path))
        #expect(RecoveryHTTPStub.requests.allSatisfy { $0.path == "/api/operations/receipt" || $0.path == "/api/sessions/\(operation.targetId)" })
        await hosts.disconnect(target)
    }

    @Test @MainActor func rejectionRetiresOnlyConclusiveOperationAndKeepsEditableDraft() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        try hosts.install(recoveryClient(), host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let form = app.newSessionForm
        form.message = "retained"
        let (operation, _) = try await hosts.deliver(host: target, kind: "chat-create", targetId: nil,
            payload: SpawnRequest(projectId: "p", message: form.message, mode: .build), origin: origin)
        RecoveryHTTPStub.setMode(.rejected)
        await app.checkHostedChat(operation, form: form, delay: .zero)
        #expect(form.error?.contains("Project no longer exists") == true)
        #expect(form.message == "retained" && form.pendingOperationId == nil)
        #expect(hosts.pendingOperations.isEmpty && app.selectedSessionId == nil)
        #expect(RecoveryHTTPStub.requests.allSatisfy { $0.path == "/api/operations/receipt" })
        await hosts.disconnect(target)
    }

    @Test @MainActor func confirmedButMissingChatRemainsRecoverableWithoutClearingDraftOrCreatingAgain() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        try hosts.install(recoveryClient(), host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let form = app.newSessionForm
        form.message = "retained"
        let (operation, _) = try await hosts.deliver(host: target, kind: "chat-create", targetId: nil,
            payload: SpawnRequest(projectId: "p", message: form.message, mode: .build), origin: origin)
        RecoveryHTTPStub.setMode(.missingChat)
        await app.checkHostedChat(operation, form: form, delay: .zero)
        #expect(form.error?.contains("Chat start was confirmed") == true)
        #expect(form.message == "retained" && form.pendingOperationId == operation.operationId)
        #expect(app.selectedSessionId == nil && hosts.pendingOperations[operation.operationId] == operation)
        RecoveryHTTPStub.setMode(.accepted)
        await app.checkHostedChat(operation, form: form, delay: .zero)
        #expect(form.error == nil && form.pendingOperationId == nil && form.message.isEmpty)
        #expect(app.selectedSession?.id == operation.targetId)
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/operations" }.isEmpty)
        await hosts.disconnect(target)
    }

    @Test @MainActor func checkCannotAdoptReceiptFromAReplacedConnectionGeneration() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        try hosts.install(recoveryClient(), host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let form = app.newSessionForm
        form.message = "retained"
        let (operation, _) = try await hosts.deliver(host: target, kind: "chat-create", targetId: nil,
            payload: SpawnRequest(projectId: "p", message: form.message, mode: .build), origin: origin)
        RecoveryHTTPStub.setMode(.heldLookup)
        let check = Task { await app.checkHostedChat(operation, form: form, attempts: 1, delay: .zero) }
        defer { check.cancel(); RecoveryHTTPStub.releaseLookups() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while RecoveryHTTPStub.heldCount == 0, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        #expect(RecoveryHTTPStub.heldCount == 1)
        #expect(form.checkingStart)
        try hosts.install(recoveryClient(), host: target)
        RecoveryHTTPStub.releaseLookups()
        await check.value
        #expect(form.error?.contains("Check again") == true)
        #expect(form.message == "retained" && form.pendingOperationId == operation.operationId)
        #expect(app.selectedSessionId == nil)
        RecoveryHTTPStub.setMode(.accepted)
        await app.checkHostedChat(operation, form: form, delay: .zero)
        #expect(app.selectedSession?.id == operation.targetId)
        #expect(RecoveryHTTPStub.requests.allSatisfy { $0.host == "remote.recovery.invalid" })
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/operations" }.isEmpty)
        await hosts.disconnect(target)
    }

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
