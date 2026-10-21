import AppKit
import Foundation
import PilotCore
import Testing
import SwiftUI
@testable import Pilot

private final class PreviousHistoryHTTP: URLProtocol {
    struct Request { let host: String; let path: String; let method: String }
    private final class State: @unchecked Sendable {
        let lock = NSLock(); var requests: [Request] = []; var hold = false; var pending: PreviousHistoryHTTP?
    }
    private static let state = State()
    static func reset() { state.lock.lock(); defer { state.lock.unlock() }; state.requests = []; state.hold = false; state.pending = nil }
    static func holdNext() { state.lock.lock(); defer { state.lock.unlock() }; state.hold = true }
    static func release() {
        state.lock.lock(); let pending = state.pending; state.pending = nil; state.lock.unlock()
        pending?.respond()
    }
    static var requests: [Request] { state.lock.lock(); defer { state.lock.unlock() }; return state.requests }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".previous-control.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.state.lock.lock()
        Self.state.requests.append(.init(host: request.url!.host!, path: request.url!.path, method: request.httpMethod ?? "GET"))
        let hold = Self.state.hold
        if hold { Self.state.pending = self; Self.state.hold = false }
        Self.state.lock.unlock()
        if !hold { respond() }
    }
    private func respond() {
        let before = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "before" }?.value
        let ids = before == "3" ? [1, 2] : [3, 4]
        let entries = ids.map { id in "{\"id\":\(id),\"kind\":\"pi.assistant\",\"model\":[{\"role\":\"assistant\",\"content\":\"\(request.url!.host!) message \(id)\"}]}" }.joined(separator: ",")
        let body = "{\"entries\":[\(entries)],\"more\":\(before == "3" ? "false" : "true")}"
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func previousSession(_ id: String = "same", control: Bool = true, title: String = "Renamed helper") throws -> SessionSummary {
    try JSONDecoder().decode(SessionSummary.self, from: Data("{\"id\":\"\(id)\",\"title\":\"\(title)\",\"cwd\":\"/tmp\",\"control\":\(control),\"createdAt\":1,\"updatedAt\":2,\"state\":\"working\"}".utf8))
}

@MainActor private func previousClient(_ name: String, sessions: [SessionSummary]) -> PilotClient {
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [PreviousHistoryHTTP.self]
    let client = PilotClient(baseURL: URL(string: "http://\(name).previous-control.invalid"), commandConfiguration: configuration)
    client.loadFixture(projects: [], sessions: sessions)
    return client
}

@Suite(.serialized) struct RetainedConversationTests {
    private let local = HostRef(hostId: "local", daemonId: "mac", lineageId: "mac-lineage")
    private let box = HostRef(hostId: "box", daemonId: "executor", lineageId: "executor-lineage")

    @Test func identityNotTitleAndMissingMacIdentityNeverPromoteAnotherControl() throws {
        let control = try previousSession()
        let ordinary = try previousSession(control: false, title: "Control")
        let ref = HostResourceRef(host: box, kind: .session, localId: control.id)
        #expect(RetainedConversation.isHistory(control, reference: ref, localHost: local))
        #expect(RetainedConversation.isHistory(control, reference: ref, localHost: nil))
        #expect(!RetainedConversation.isHistory(ordinary, reference: ref, localHost: local))
        #expect(RetainedConversation.isHistory(control, reference: .init(host: local, kind: .session, localId: control.id), localHost: local))
    }

    @Test @MainActor func sourceQualifiedReadsPageWithoutAnyWriteOrLocalFallback() async throws {
        PreviousHistoryHTTP.reset()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = ClientDirectory(operationDirectory: directory)
        try hosts.install(previousClient("box", sessions: [previousSession()]), host: box)
        let ref = HostResourceRef(host: box, kind: .session, localId: "same")
        let model = RetainedConversationHistoryModel(source: RetainedConversationReader(reference: ref, hosts: hosts))
        #expect(PreviousHistoryHTTP.requests.isEmpty)
        await model.load(); await model.load(older: true)
        #expect(model.error == nil && model.entries.map(\.id) == [1, 2, 3, 4])
        #expect(model.entries.first?.messages.first?.text.contains("box.previous-control.invalid") == true)
        #expect(PreviousHistoryHTTP.requests.count == 2)
        #expect(PreviousHistoryHTTP.requests.allSatisfy { $0.host == "box.previous-control.invalid" && $0.path == "/api/sessions/same/history" && $0.method == "GET" })
        model.stop()
        await hosts.disconnectAll()
    }

    @Test @MainActor func paletteKeyboardAndActionEntrypointsCannotWriteHistoricalControlButKeepOrdinaryChats() async throws {
        PreviousHistoryHTTP.reset()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = ClientDirectory(operationDirectory: directory)
        let defaults = UserDefaults(suiteName: "previous-control-\(UUID())")!
        let app = AppModel(projectFolderDefaults: defaults, hosts: hosts)
        app.client.loadFixture(projects: [], sessions: [try previousSession()])
        try app.registerLocal(local); try hosts.install(app.client, host: local)
        try hosts.install(previousClient("box", sessions: [previousSession(), previousSession("ordinary", control: false, title: "Control")]), host: box)
        let ref = HostResourceRef(host: box, kind: .session, localId: "same")
        try app.selectSession(ref)
        #expect(app.isRetainedHistorySelected && !app.canStopSelectedChat && !app.canToggleTerminal)
        #expect(!app.focusComposer() && !app.openInspector(.terminal))
        #expect(!GoDestination.allCases.map(\.rawValue).contains("control"))
        #expect(hosts.sessions.contains { $0.ref == ref && $0.value.isRetainedHistory })
        let catalog = CommandPaletteCatalog(model: app, openSettings: {}, openKeyboardShortcuts: {})
        #expect(catalog.chatActions(try previousSession(), reference: ref).isEmpty)
        let items = catalog.entries().map(\.item.id)
        #expect(!items.contains("chat:" + ref.storageKey) && !items.contains("history:" + ref.storageKey))
        #expect(!items.contains { $0.hasPrefix("history:") } && !items.contains("page:control"))
        let ordinary = HostResourceRef(host: box, kind: .session, localId: "ordinary")
        #expect(items.contains("chat:" + ordinary.storageKey) && app.canMutateSession(ordinary.storageKey))
        app.setPinned(false, sessionId: ref.storageKey); app.renameSession(ref.storageKey, title: "No")
        app.setArchived(true, sessionId: ref.storageKey)
        #expect(app.stopSession(ref.storageKey) == nil)
        app.retry(try previousSession(), context: HostViewContext(host: box, hosts: hosts))
        for _ in 0..<10 { await Task.yield() }
        #expect(PreviousHistoryHTTP.requests.isEmpty)
        #expect(app.hosts.selection == ref && app.selectedSessionId == ref.storageKey)
        let localRef = HostResourceRef(host: local, kind: .session, localId: "same")
        try app.selectSession(localRef)
        #expect(app.isRetainedHistorySelected && !app.focusComposer() && !app.canStopSelectedChat)
        #expect(!app.canMutateSession("same") && !app.canMutateSession(localRef.storageKey))
        app.renameSession("same", title: "No")
        app.setArchived(false, sessionId: localRef.storageKey)
        #expect(app.stopSession("same") == nil)
        for _ in 0..<10 { await Task.yield() }
        #expect(PreviousHistoryHTTP.requests.isEmpty)
        await hosts.disconnectAll()
    }

    @Test @MainActor func persistedOfflineControlKeepsIdentityAndHistoryAcrossReconnect() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = OfflineHostStore(directory: directory.appendingPathComponent("offline"))
        let original = try previousSession()
        let ordinary = try previousSession("ordinary", control: false, title: "Control")
        try await store.save([OfflineHostSnapshot(host: box, configuration: LegacyDevboxAddress(alias: "fixture"),
            sessions: [original, ordinary])])
        let disk = try await store.load()
        let sanitized = try #require(disk.first { $0.host == box })
        #expect(sanitized.sessions.first { $0.id == original.id }?.control == true)
        #expect(sanitized.sessions.first { $0.id == ordinary.id }?.control == false)
        #expect(sanitized.sessions.first { $0.id == ordinary.id }?.title == "Control")
        #expect(original.control == true && ordinary.control == false)
        let hosts = ClientDirectory(operationDirectory: directory.appendingPathComponent("operations"))
        try await hosts.restoreOffline(from: store)
        let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "previous-control-\(UUID())")!, hosts: hosts)
        app.client.loadFixture(projects: [], sessions: [original])
        try app.registerLocal(local)
        try hosts.install(app.client, host: local)
        let ref = HostResourceRef(host: box, kind: .session, localId: "same")
        #expect(hosts.sessions.contains { $0.ref == ref && $0.value.isRetainedHistory })
        let offlineEntries = CommandPaletteCatalog(model: app, openSettings: {}, openKeyboardShortcuts: {}).entries()
        #expect(!offlineEntries.contains { $0.item.id == "chat:" + ref.storageKey || $0.item.id.hasPrefix("history:") })
        #expect(!GoDestination.allCases.map(\.rawValue).contains("control") && app.client.session(original.id)?.isRetainedHistory == true)
        let ordinaryRef = HostResourceRef(host: box, kind: .session, localId: ordinary.id)
        #expect(app.canMutateSession(ordinaryRef.storageKey))
        #expect(hosts.sessions.first { $0.ref == ordinaryRef }?.value.isRetainedHistory == false)
        #expect(!app.canMutateSession(ref.storageKey))
        let model = RetainedConversationHistoryModel(source: RetainedConversationReader(reference: ref, hosts: hosts))
        await model.load()
        #expect(!model.loaded && model.error?.contains("Reconnect") == true)
        try hosts.install(previousClient("box", sessions: [original, ordinary]), host: box)
        await model.load()
        #expect(model.loaded && model.error == nil && hosts.sessions.contains { $0.ref == ref && $0.value.isRetainedHistory })
        let reconnectedEntries = CommandPaletteCatalog(model: app, openSettings: {}, openKeyboardShortcuts: {}).entries()
        #expect(!reconnectedEntries.contains { $0.item.id == "chat:" + ref.storageKey || $0.item.id.hasPrefix("history:") })
        #expect(reconnectedEntries.contains { $0.item.id == "chat:" + ordinaryRef.storageKey })
        model.stop(); await hosts.disconnectAll()
    }

    @Test @MainActor func replacedHostRejectsLateOldGenerationReadAndUsesOnlyNewEndpoint() async throws {
        PreviousHistoryHTTP.reset()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = ClientDirectory(operationDirectory: directory)
        try hosts.install(previousClient("box", sessions: [previousSession()]), host: box)
        let model = RetainedConversationHistoryModel(source: RetainedConversationReader(reference: .init(host: box, kind: .session, localId: "same"), hosts: hosts))
        await model.load()
        let entries = model.entries
        let oldToken = try hosts.token(for: box)
        PreviousHistoryHTTP.holdNext()
        let task = Task { await model.load(older: true) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while PreviousHistoryHTTP.requests.count < 2 {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }; await Task.yield()
        }
        try hosts.install(previousClient("replacement", sessions: [previousSession()]), host: box)
        let replacementToken = try hosts.token(for: box)
        #expect(oldToken != replacementToken)
        PreviousHistoryHTTP.release(); await task.value
        #expect(model.entries == entries && model.error != nil)
        await model.load()
        #expect(model.error == nil && model.entries.first?.messages.first?.text.contains("replacement.previous-control.invalid") == true)
        #expect(PreviousHistoryHTTP.requests.map(\.host) == ["box.previous-control.invalid", "box.previous-control.invalid", "replacement.previous-control.invalid"])
        #expect(PreviousHistoryHTTP.requests.allSatisfy { $0.method == "GET" })
        model.stop(); await hosts.disconnectAll()
    }

    @Test @MainActor func mountedHistoricalDestinationHasNoEditableComposer() async throws {
        PreviousHistoryHTTP.reset()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = ClientDirectory(operationDirectory: directory)
        let session = try previousSession()
        let client = previousClient("box", sessions: [session])
        try hosts.install(client, host: box)
        let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "previous-control-\(UUID())")!, hosts: hosts)
        try app.registerLocal(local)
        let ref = HostResourceRef(host: box, kind: .session, localId: session.id)
        try app.selectSession(ref)
        let view = NSHostingView(rootView: SessionDetail(session: session, context: HostViewContext(host: box, hosts: hosts)).environmentObject(app))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        defer { window.close() }
        window.orderFront(nil)
        view.setFrameSize(NSSize(width: 760, height: 500)); view.layoutSubtreeIfNeeded()
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while PreviousHistoryHTTP.requests.isEmpty {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }; await Task.yield()
        }
        func editors(_ view: NSView) -> [NSTextView] { (view as? NSTextView).map { [$0] } ?? view.subviews.flatMap(editors) }
        #expect(editors(view).allSatisfy { !$0.isEditable })
        #expect(!app.canToggleTerminal && !app.canStopSelectedChat)
        // Inspect only this fixture's private collections, avoiding a production instrumentation hook.
        let chats = try #require(Mirror(reflecting: client).children.first { $0.label == "chats" })
        let subscriptions = try #require(Mirror(reflecting: hosts).children.first { $0.label == "subscriptions" })
        #expect(Mirror(reflecting: chats.value).children.isEmpty)
        #expect(Mirror(reflecting: subscriptions.value).children.isEmpty)
        #expect(PreviousHistoryHTTP.requests.allSatisfy { $0.method == "GET" && $0.path == "/api/sessions/same/history" })
        await hosts.disconnectAll()
    }

    @Test @MainActor func sourceQualifiedChatLinkCannotFallBackToTheSameIdOnMac() async throws {
        PreviousHistoryHTTP.reset()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = "d9edf76b-4f75-4abb-a09f-e313fc05ae39"
        let session = try previousSession(id)
        let hosts = ClientDirectory(operationDirectory: directory)
        let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "previous-control-\(UUID())")!, hosts: hosts)
        app.client.loadFixture(projects: [], sessions: [session])
        try app.registerLocal(local); try hosts.install(app.client, host: local)
        try hosts.install(previousClient("box", sessions: [session]), host: box)
        let link = try #require(ChatDestination(url: URL(string: "pilot://chat/\(id)")!))
        // The same source qualification used by HostViewContext.openURL before native navigation.
        let reference = HostViewContext(host: box, hosts: hosts).ref(.session, link.sessionId)
        app.navigate(.session, id: reference.storageKey)
        #expect(hosts.selection == reference && app.selectedSessionId == reference.storageKey && app.isRetainedHistorySelected)
        let model = RetainedConversationHistoryModel(source: RetainedConversationReader(reference: reference, hosts: hosts))
        await model.load()
        #expect(model.loaded && model.error == nil)
        #expect(PreviousHistoryHTTP.requests.count == 1)
        #expect(PreviousHistoryHTTP.requests.first?.host == "box.previous-control.invalid")
        #expect(PreviousHistoryHTTP.requests.first?.path == "/api/sessions/\(id)/history")
        model.stop(); await hosts.disconnectAll()
    }

    @Test @MainActor func savedRemoteControlSelectionIsClearedForInitialAndLateInventoryWithoutArchivingOrLosingDrafts() async throws {
        for initialInventory in [false, true] {
            for control in [false, true] {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                defer { try? FileManager.default.removeItem(at: directory) }
                let hosts = ClientDirectory(operationDirectory: directory.appendingPathComponent("operations"))
                let reference = HostResourceRef(host: box, kind: .session, localId: "same")
                let session = try previousSession(control: control, title: "Control")
                let client = previousClient("box", sessions: [session])
                if initialInventory { try hosts.install(client, host: box) }
                let store = DraftStore(directory: directory.appendingPathComponent("drafts"))
                _ = try store.load()
                var drafts = StoredDrafts()
                drafts.localHost = local; drafts.selection = reference
                drafts.chats[reference.storageKey] = StoredChatDraft(text: "Retain this unsent draft")
                try store.save(drafts)
                let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "retained-control-\(UUID())")!,
                                   draftStore: store, hosts: hosts)
                if !initialInventory { try hosts.install(client, host: box) }
                #expect(app.selectedSessionId == (control ? nil : reference.storageKey))
                #expect(hosts.selection == (control ? nil : reference))
                #expect(hosts.sessions.first { $0.ref == reference }?.value.isArchived == false)
                #expect(app.composer(for: reference.storageKey).draft == "Retain this unsent draft")
                // A later refresh must not resurrect the saved selection or drop an ordinary one.
                client.loadFixture(projects: [], sessions: [session])
                #expect(app.selectedSessionId == (control ? nil : reference.storageKey))
                // Explicit source-qualified access still opens only the read-only destination.
                try app.selectSession(reference)
                #expect(app.isRetainedHistorySelected == control)
                #expect(app.canMutateSession(reference.storageKey) == !control)
                app.flushDrafts()
                await hosts.disconnectAll()
            }
        }
    }

    @Test @MainActor func navigationHistoryDoesNotRediscoverRemoteControl() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = ClientDirectory(operationDirectory: directory)
        let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "retained-control-\(UUID())")!, hosts: hosts)
        try app.registerLocal(local)
        let reference = HostResourceRef(host: box, kind: .session, localId: "same")
        try hosts.install(previousClient("box", sessions: [previousSession()]), host: box)
        try app.selectSession(reference)
        #expect(app.isRetainedHistorySelected)
        app.openHome()
        app.goBack()
        #expect(!app.isRetainedHistorySelected)
        #expect(hosts.sessions.contains { $0.ref == reference && $0.value.isRetainedHistory && !$0.value.isArchived })
        await hosts.disconnectAll()
    }

    @Test @MainActor func explicitQualifiedAccessCancelsSavedSelectionCleanupBeforeLateInventory() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = ClientDirectory(operationDirectory: directory.appendingPathComponent("operations"))
        let reference = HostResourceRef(host: box, kind: .session, localId: "same")
        let store = DraftStore(directory: directory.appendingPathComponent("drafts"))
        _ = try store.load()
        var drafts = StoredDrafts()
        drafts.localHost = local; drafts.selection = reference
        try store.save(drafts)
        let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "retained-control-\(UUID())")!,
                           draftStore: store, hosts: hosts)
        try app.selectSession(reference)
        try hosts.install(previousClient("box", sessions: [previousSession()]), host: box)
        #expect(app.isRetainedHistorySelected && hosts.selection == reference)
        #expect(!app.canMutateSession(reference.storageKey) && !app.canStopSelectedChat && !app.canToggleTerminal)
        app.flushDrafts()
        await hosts.disconnectAll()
    }
}
