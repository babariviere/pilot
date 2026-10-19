import AppKit
import Combine
import Foundation
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private final class RecoveryHTTPStub: URLProtocol {
    struct Request { let host: String; let path: String; let operation: DurableOperation? }
    enum Mode { case normal, accepted, loseAcceptedReply, pending, pendingThenAccepted, unknown, failedLookup, missingChat, heldLookup, heldChat, rejected, wrongIdentity, stopLost, stopAcknowledged }
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
            else if let session = item.heldSession { item.reply(try! JSONEncoder().encode(session)) }
        }
    }
    private var heldOperation: DurableOperation?
    private var heldSession: SessionSummary?
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
            if mode == .heldChat {
                heldSession = session
                Self.state.lock.lock(); Self.state.held.append(self); Self.state.lock.unlock()
                return
            }
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
                           draftStore: DraftStore(directory: directory, attachmentDirectory: directory.deletingLastPathComponent()),
                           client: recoveryClient(local: true), hosts: hosts)
        try app.registerLocal(origin)
        try hosts.install(app.client, host: origin)
        app.newSessionForm.executionHost = target
        return app
    }

    @MainActor private func pendingStart(_ app: AppModel, on host: HostRef? = nil) async throws -> DurableOperation {
        let host = host ?? target
        app.draftProjectId = "p"
        app.newSessionForm.message = "original remote request"
        let (operation, _) = try await app.hosts.deliver(host: host, kind: "chat-create", targetId: nil,
            payload: SpawnRequest(projectId: "p", message: app.newSessionForm.message, mode: .build), origin: origin)
        app.newSessionForm.pendingOperationId = operation.operationId
        return operation
    }

    @Test @MainActor func pendingRemoteStartDoesNotBlockCommandNOrTheProductionLocalSpawnAction() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let operations = directory.appendingPathComponent("operations")
        let hosts = HostClients(operationDirectory: operations)
        try hosts.install(recoveryClient(), host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let localProject = Project(id: "local-project", name: "Local", path: "/local", workspace: "direct", createdAt: 0)
        app.client.loadFixture(projects: [localProject], sessions: [])
        let original = try await pendingStart(app)
        #expect(app.newSessionForm.canChooseExecutionHost, "An unknown remote start does not lock the host selector")
        app.newSessionForm.message = "newer remote draft"
        app.newChatInScope()
        let form = app.newSessionForm
        #expect(form.executionHost == origin && form.pendingOperationId == nil)
        #expect(form.canChooseExecutionHost)
        #expect(form.message.isEmpty && form.folder.isEmpty && app.draftProjectId == nil)
        #expect(app.pendingChatCreate(on: origin, operationId: original.operationId) == nil)
        #expect(app.pendingChatCreate(on: target) == original)
        form.message = "independent Local request"
        #expect(form.canStart(in: localProject))
        let session = try await app.createLocalChat(form.spawnRequest(in: localProject), form: form, revision: form.revision)
        #expect(app.client.fixtureSpawnRequests.map(\.message) == ["independent Local request"])
        #expect(app.client.fixtureSpawnRequests.first?.projectId == localProject.id)
        #expect(app.selectedSessionId == session.id && form.pendingOperationId == nil)
        #expect(try await OperationOutbox(directory: operations).pending() == [original])
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/operations/receipt" }.count == 1)
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/operations" }.isEmpty,
                "The fixture reports a pending durable owner on lookup, so neither path may POST it again")
        #expect(app.chooseNewChatHost(target))
        #expect(form.pendingOperationId == original.operationId && form.message == "newer remote draft")
        await hosts.disconnect(target)
    }

    @Test @MainActor func switchingHostsAndRelaunchKeepNewerRemoteImagesAndIndependentDrafts() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let operations = directory.appendingPathComponent("operations"), drafts = directory.appendingPathComponent("drafts")
        let hosts = HostClients(operationDirectory: operations)
        try hosts.install(recoveryClient(), host: target)
        let other = HostRef(hostId: "other-box", daemonId: "other", lineageId: "other-history")
        try hosts.install(recoveryClient(), host: other)
        let first = try app(drafts, hosts: hosts)
        let original = try await pendingStart(first)
        let imageURL = directory.appendingPathComponent("newer.png")
        let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1, pixelsHigh: 1,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        bitmap.setColor(.black, atX: 0, y: 0)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: imageURL)
        let image = PastedImage(id: UUID(), url: imageURL, preview: NSImage(size: NSSize(width: 1, height: 1)))
        first.newSessionForm.message = "newer remote draft"
        first.newSessionForm.attachments.items = [image]
        first.newSessionForm.model = "remote/model"
        first.newSessionForm.folder = "/remote-only"
        first.newSessionForm.mode = .ask
        #expect(first.chooseNewChatHost(origin))
        #expect(first.newSessionForm.attachments.items.isEmpty && first.newSessionForm.model.isEmpty)
        first.newSessionForm.message = "Local unsent draft"
        first.newSessionForm.model = "local/model"
        #expect(first.chooseNewChatHost(other))
        let otherOperation = try await pendingStart(first, on: other)
        first.newSessionForm.message = "other devbox draft"
        #expect(first.chooseNewChatHost(origin))
        #expect(first.newSessionForm.message == "Local unsent draft" && first.newSessionForm.model == "local/model")
        try first.persistDrafts()
        let restored = AppModel(projectFolderDefaults: UserDefaults(suiteName: UUID().uuidString)!,
            draftStore: DraftStore(directory: drafts, attachmentDirectory: directory), hosts: hosts)
        #expect(restored.newSessionForm.executionHost == origin)
        #expect(restored.newSessionForm.message == "Local unsent draft")
        #expect(try DraftStore(directory: drafts).load().parkedNewTasks?.count == 2)
        #expect(restored.chooseNewChatHost(target))
        #expect(restored.newSessionForm.message == "newer remote draft")
        #expect(restored.newSessionForm.mode == .ask && restored.newSessionForm.model == "remote/model")
        #expect(restored.newSessionForm.folder == "/remote-only" && restored.draftProjectId == "p")
        #expect(restored.newSessionForm.pendingOperationId == original.operationId)
        #expect(restored.newSessionForm.attachments.items.map(\.id) == [image.id])
        #expect(FileManager.default.fileExists(atPath: imageURL.path))
        #expect(restored.chooseNewChatHost(other))
        #expect(restored.newSessionForm.message == "other devbox draft")
        #expect(restored.newSessionForm.pendingOperationId == otherOperation.operationId)
        #expect(try await OperationOutbox(directory: operations).pending() == [original, otherOperation])
        await hosts.disconnect(target)
        await hosts.disconnect(other)
    }

    @Test(arguments: [false, true]) @MainActor func lateCheckCannotRelockEraseOrNavigateAwayFromIndependentLocalChat(holdChat: Bool) async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let operations = directory.appendingPathComponent("operations")
        let hosts = HostClients(operationDirectory: operations)
        try hosts.install(recoveryClient(), host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let localProject = Project(id: "local", name: "Local", path: "/local", createdAt: 0)
        app.client.loadFixture(projects: [localProject], sessions: [])
        let original = try await pendingStart(app)
        RecoveryHTTPStub.setMode(holdChat ? .heldChat : .heldLookup)
        defer { RecoveryHTTPStub.releaseLookups() }
        let check = Task { await app.checkHostedChat(original, form: app.newSessionForm, openConfirmed: true, delay: .zero) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while RecoveryHTTPStub.heldCount == 0, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        try #require(RecoveryHTTPStub.heldCount == 1 && app.newSessionForm.checkingStart)
        app.newChatInScope()
        #expect(app.newSessionForm.executionHost == origin && !app.newSessionForm.checkingStart)
        app.newSessionForm.message = "Local request"
        let session = try await app.createLocalChat(app.newSessionForm.spawnRequest(in: localProject),
            form: app.newSessionForm, revision: app.newSessionForm.revision)
        app.newSessionForm.message = "newer Local unsent text"
        RecoveryHTTPStub.releaseLookups()
        await check.value
        #expect(app.newSessionForm.executionHost == origin && app.newSessionForm.pendingOperationId == nil)
        #expect(app.newSessionForm.message == "newer Local unsent text" && app.newSessionForm.error == nil)
        #expect(app.selectedSessionId == session.id)
        #expect(!app.newSessionForm.checkingStart && app.newSessionForm.startRecoveryMessage == nil)
        #expect(try await OperationOutbox(directory: operations).pending() == [original])
        #expect(RecoveryHTTPStub.requests.filter { $0.path == "/api/sessions/\(original.targetId)" }.count == (holdChat ? 1 : 0))
        await hosts.disconnect(target)
    }

    @Test @MainActor func staleRejectedAdoptionAndOpenCannotTouchAnotherHostsDraft() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let operations = directory.appendingPathComponent("operations")
        let hosts = HostClients(operationDirectory: operations)
        try hosts.install(recoveryClient(), host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let original = try await pendingStart(app), oldRevision = app.newSessionForm.revision
        #expect(app.chooseNewChatHost(origin))
        app.newSessionForm.message = "keep Local"
        RecoveryHTTPStub.setMode(.rejected)
        let delivery = try await hosts.checkOperation(original, attempts: 1, delay: .zero)
        guard case let .receipt(receipt) = delivery else { Issue.record("Missing rejection fixture"); return }
        try await app.adoptCreatedChat(original, receipt: receipt, form: app.newSessionForm, revision: oldRevision, openWhenDraftChanged: true)
        let reads = RecoveryHTTPStub.requests.count
        await app.checkHostedChat(original, form: app.newSessionForm, openConfirmed: true, delay: .zero)
        #expect(RecoveryHTTPStub.requests.count == reads)
        #expect(app.newSessionForm.message == "keep Local" && app.newSessionForm.pendingOperationId == nil)
        #expect(app.newSessionForm.error == nil && app.selectedSessionId == nil)
        #expect(try await OperationOutbox(directory: operations).pending() == [original])
        #expect(app.chooseNewChatHost(target))
        await app.checkHostedChat(original, form: app.newSessionForm, delay: .zero)
        #expect(app.newSessionForm.pendingOperationId == nil && app.newSessionForm.message == "original remote request")
        #expect(try await OperationOutbox(directory: operations).pending().isEmpty)
        await hosts.disconnect(target)
    }

    @Test @MainActor func busyAndBoundDraftHostLocksAndOrdinaryCommandNStillApply() throws {
        let app = AppModel()
        try app.registerLocal(origin)
        let form = app.newSessionForm
        form.executionHost = target
        form.message = "ordinary unsent draft"
        let revision = form.revision
        app.newChatInScope()
        #expect(form.executionHost == target && form.message == "ordinary unsent draft" && form.revision == revision)
        form.pendingOperationId = UUID().uuidString
        form.busy = true
        #expect(!app.chooseNewChatHost(origin) && !app.newLocalChatWhileRemoteStartPending())
        form.busy = false
        form.trackedItem = TrackedItemBinding(itemId: "ticket", projectId: "p", label: "T-1")
        #expect(!app.chooseNewChatHost(origin))
        #expect(form.executionHost == target && form.pendingOperationId != nil)
        #expect(app.newLocalChatWhileRemoteStartPending(), "Independent creation parks the bound draft instead of retargeting it")
        #expect(form.executionHost == origin && form.trackedItem == nil)
    }

    @Test @MainActor func nativeIndependentLocalButtonWorksWhileOriginalCheckIsInProgress() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        try hosts.install(recoveryClient(), host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let original = try await pendingStart(app)
        app.newSessionForm.checkingStart = true
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 80),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let hosting = NSHostingView(rootView: IndependentLocalChatButton(form: app.newSessionForm).environmentObject(app))
        window.contentView = hosting
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        window.orderFrontRegardless(); window.update(); hosting.layoutSubtreeIfNeeded()
        func buttons(_ view: NSView) -> [NSButton] {
            (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(buttons)
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while buttons(hosting).isEmpty, ContinuousClock.now < deadline {
            hosting.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
        }
        let controls = buttons(hosting)
        try #require(controls.count == 1)
        let button = try #require(controls.first)
        try #require(button.isEnabled, "A slow Check must not disable independent Local creation")
        button.performClick(nil)
        #expect(app.newSessionForm.executionHost == origin && app.newSessionForm.pendingOperationId == nil)
        #expect(!app.newSessionForm.checkingStart)
        #expect(hosts.pendingOperations[original.operationId] == original)
        #expect(app.pendingChatCreate(on: target) == original)
        await hosts.disconnect(target)
    }

    @Test @MainActor func explicitProjectStartParksRemoteAndSameHostPrefillCannotOverwriteIt() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        try hosts.install(recoveryClient(), host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let original = try await pendingStart(app)
        app.newSessionForm.message = "newer remote text"
        #expect(!app.newSession(in: "p", message: "would replace it", context: HostViewContext(host: target, hosts: hosts)))
        #expect(app.newSessionForm.message == "newer remote text" && app.newSessionForm.pendingOperationId == original.operationId)
        #expect(app.newSession(in: "local-project", message: "Local prefill"))
        app.newSessionForm.consumeDraft(from: app)
        #expect(app.newSessionForm.executionHost == origin && app.newSessionForm.message == "Local prefill")
        #expect(app.draftProjectId == "local-project" && app.newSessionForm.pendingOperationId == nil)
        #expect(app.chooseNewChatHost(target))
        #expect(app.newSessionForm.message == "newer remote text" && app.newSessionForm.pendingOperationId == original.operationId)
        #expect(hosts.pendingOperations[original.operationId] == original)
        await hosts.disconnect(target)
    }

    @Test @MainActor func failedParkingWriteKeepsOriginalHostDraftAndOperation() async throws {
        RecoveryHTTPStub.reset(.pending)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let drafts = directory.appendingPathComponent("drafts")
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        try hosts.install(recoveryClient(), host: target)
        let store = DraftStore(directory: drafts, writeSnapshot: { snapshot, url in
            if snapshot.newTask.executionHost == origin, snapshot.parkedNewTasks?.isEmpty == false {
                throw CocoaError(.fileWriteOutOfSpace)
            }
            try DraftStore.write(snapshot, to: url)
        })
        let app = AppModel(draftStore: store, hosts: hosts)
        try app.registerLocal(origin)
        app.newSessionForm.executionHost = target
        let original = try await pendingStart(app)
        app.newSessionForm.message = "never lose this newer draft"
        try app.persistDrafts()
        let before = try Data(contentsOf: drafts.appendingPathComponent("drafts.json"))
        #expect(!app.chooseNewChatHost(origin))
        #expect(app.newSessionForm.executionHost == target && app.newSessionForm.pendingOperationId == original.operationId)
        #expect(app.newSessionForm.message == "never lose this newer draft" && app.newSessionForm.error != nil)
        #expect(try Data(contentsOf: drafts.appendingPathComponent("drafts.json")) == before)
        #expect(hosts.pendingOperations[original.operationId] == original)
        try app.persistDrafts()
        await hosts.disconnect(target)
    }

    @Test @MainActor func invalidOrUnboundedParkedDraftIndexesFailWithoutReplacingSavedDrafts() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let remote = StoredTaskDraft(executionHost: target, pendingOperationId: "original", message: "kept")
        for parked in [[remote, remote], [StoredTaskDraft(executionHost: origin)],
                       (0..<33).map { StoredTaskDraft(executionHost: HostRef(hostId: "box-\($0)", daemonId: "daemon", lineageId: "lineage")) }] {
            var value = StoredDrafts()
            value.newTask.executionHost = origin
            value.parkedNewTasks = parked
            try DraftStore.write(value, to: directory)
            let before = try Data(contentsOf: directory.appendingPathComponent("drafts.json"))
            do { _ = try DraftStore(directory: directory).load(); Issue.record("Invalid parked index was accepted") }
            catch { #expect(error as? HostRoutingError == .invalidReference) }
            #expect(try Data(contentsOf: directory.appendingPathComponent("drafts.json")) == before)
        }
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

    @Test @MainActor func mappedCheckoutUsesRemoteProjectInActualDurableCreateAction() async throws {
        RecoveryHTTPStub.reset(.normal)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
        let remote = recoveryClient()
        let project = Project(id: "remote-project", name: "Code", path: "/home/test/code", workspace: "direct", createdAt: 0)
        remote.loadFixture(projects: [project], sessions: [])
        try hosts.install(remote, host: target)
        let app = try app(directory.appendingPathComponent("drafts"), hosts: hosts)
        let source = HostResourceRef(host: origin, kind: .project, localId: "p")
        let destination = HostResourceRef(host: target, kind: .project, localId: project.id)
        try await hosts.projectCheckouts.confirm(source: source, target: destination)
        #expect(try await OperationOutbox(directory: directory.appendingPathComponent("operations")).pending().isEmpty,
                "Saved checkout metadata must not be decoded as a pending operation")
        #expect(app.chooseNewChatHost(origin))
        app.draftProjectId = "p"
        app.newSessionForm.message = "Use the mapped checkout"
        #expect(app.chooseNewChatHost(target, sourceProject: app.client.project("p")))
        #expect(app.draftProjectId == project.id)
        await app.newSessionForm.checkoutValidationTask?.value
        try await app.createHostedChat(form: app.newSessionForm, host: target, project: project, revision: app.newSessionForm.revision)
        let mutation = try #require(RecoveryHTTPStub.requests.first { $0.path == "/api/operations" }?.operation)
        let payload = try JSONValue.decode(Data(mutation.payload.utf8))
        #expect(mutation.destination == target)
        #expect(payload["projectId"]?.string == project.id)
        #expect(payload["cwd"] == nil, "Use the daemon's registered checkout, not a Mac path")
        #expect(hosts.projectCheckouts.groups(local: origin).count == 1)
        await hosts.disconnectAll()
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
