import AppKit
import Foundation
import PilotCore
import Testing
@testable import Pilot

private let retiredLocal = HostRef(hostId: "local", daemonId: "mac", lineageId: "mac-history")
private let retiredBox = HostRef(hostId: "box", daemonId: "linux", lineageId: "linux-history")

@Test @MainActor func localDirectoryRejectsRemoteEndpointsWithoutCallingThem() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    var capabilities = 0
    let clients = ClientDirectory(operationDirectory: directory, readNativeCapability: { _ in
        capabilities += 1
        return "must-not-be-read"
    })
    do {
        #expect(clients.localHost == nil)
        let previousLocal = HostRef(hostId: "local", daemonId: "older", lineageId: "older")
        clients.restoreLegacySnapshot(OfflineHostSnapshot(host: previousLocal,
            configuration: try LegacyDevboxAddress(alias: "old-local")))
        let live = PilotClient(); live.loadFixture(projects: [], sessions: [])
        try clients.install(live, host: retiredLocal)
        #expect(clients.localHost == retiredLocal)
        let remote = PilotClient()
        remote.loadFixture(projects: [], sessions: [])
        #expect(throws: HostRoutingError.identityChanged) { try clients.install(remote, host: retiredBox) }
        #expect(throws: HostRoutingError.identityChanged) { try clients.install(remote, host: previousLocal) }
        #expect(clients.localHost == retiredLocal)
        #expect(clients.available == [retiredLocal])
        var invoked = false
        for host in [retiredBox, previousLocal] {
            do {
                let ref = HostResourceRef(host: host, kind: .session, localId: "same")
                _ = try await clients.perform(ref, kind: .session) { _, _ in invoked = true }
                Issue.record("A historical endpoint was admitted")
            } catch { #expect(error as? HostRoutingError == .disconnected) }
        }
        #expect(!invoked && capabilities == 0)
        #expect(try clients.endpoint(retiredLocal) === live)
        await clients.disconnectAll()
        #expect(clients.localHost == nil)
        try? FileManager.default.removeItem(at: directory)
    } catch {
        await clients.disconnectAll()
        try? FileManager.default.removeItem(at: directory)
        throw error
    }
}

@Test(arguments: [false, true]) @MainActor
func retiredHistoryNoticeStaysReadOnlyWithoutReconnect(cached: Bool) throws {
    let clients = ClientDirectory()
    let context = HostViewContext(host: retiredBox, hosts: clients)
    let message = DisconnectedHistoryMessage(context: context, historyCached: cached)
    #expect(message.title == "Remote history · box")
    #expect(message.detail.contains(cached ? "Cached history is read-only" : "not cached on this Mac"))
    #expect(!message.detail.contains("Reconnect"))
    let ownership = try #require(message.ownership)
    #expect(ownership.contains("does not stop work"))
}

@Test @MainActor func localHistoryNoticeKeepsLocalOutageSeparateFromRetiredHistory() {
    let context = HostViewContext(host: retiredLocal, hosts: ClientDirectory())
    let message = DisconnectedHistoryMessage(context: context, historyCached: true)
    #expect(message.title == "Local daemon unavailable")
    #expect(message.detail.contains("pilotd") && message.detail.contains("stays on this Mac"))
    #expect(!message.detail.contains("Remote devboxes"))
    #expect(message.ownership == nil)
}

@MainActor private func retiredApp(_ directory: URL, hosts: ClientDirectory) throws -> AppModel {
    let client = PilotClient()
    client.loadFixture(projects: [], sessions: [])
    let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: UUID().uuidString)!,
        draftStore: DraftStore(directory: directory.appendingPathComponent("drafts"), attachmentDirectory: directory), client: client, hosts: hosts)
    try app.registerLocal(retiredLocal)
    return app
}

@Test @MainActor func retiredDevboxesKeepSettingsLocalAndCachedHistoryReadOnly() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let hosts = ClientDirectory(operationDirectory: directory)
    do {
        let store = OfflineHostStore(directory: directory.appendingPathComponent("hosts"))
        let chat = SessionSummary(id: "old", title: "Saved remote chat", cwd: "/remote", createdAt: 1, updatedAt: 2, state: "working")
        try await store.save([OfflineHostSnapshot(host: retiredBox,
            configuration: LegacyDevboxAddress(alias: "old-box"), sessions: [chat])])
        try await hosts.restoreOffline(from: store)
        let ref = HostResourceRef(host: retiredBox, kind: .session, localId: chat.id)
        #expect(!SettingsTab.general.map(\.title).contains("Devboxes"))
        #expect(HostMcpRoster(hosts: hosts, local: retiredLocal).rows.map(\.host) == [retiredLocal])
        #expect(hosts.sessions.first?.ref == ref)
        #expect(hosts.sessions.first?.value.state == "working", "Retirement is not proof of termination")
        #expect(hosts.historyAvailability(ref, cached: true) == .cached)
        #expect(hosts.historyAvailability(ref, cached: false) == .requiresReconnect)
        #expect(!hosts.presentationClient(retiredBox).connected && hosts.available.isEmpty)
        await hosts.disconnectAll()
        try FileManager.default.removeItem(at: directory)
    } catch {
        await hosts.disconnectAll()
        try? FileManager.default.removeItem(at: directory)
        throw error
    }
}

@Test @MainActor func retiredOfflineRestoreKeepsLegacyBytesAndUnknownOutboxWithoutNetwork() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let hosts = ClientDirectory(operationDirectory: directory.appendingPathComponent("operations"))
    do {
        let cache = directory.appendingPathComponent("hosts")
        let store = OfflineHostStore(directory: cache)
        try await store.save([OfflineHostSnapshot(host: retiredBox,
            configuration: LegacyDevboxAddress(alias: "old-box"), stopRequests: ["old": .requested])])
        let before = try Data(contentsOf: cache.appendingPathComponent("hosts.json"))
        let outbox = OperationOutbox(directory: directory.appendingPathComponent("operations"))
        let operation = try await outbox.reserve(kind: "chat-create", targetId: nil,
            payload: ["message": "Uncertain remote start"], origin: retiredLocal, destination: retiredBox)
        let app = try retiredApp(directory, hosts: hosts)
        var localStarted = false
        await app.startHostConnections(offlineStore: store) { localStarted = true }
        #expect(localStarted && hosts.available.isEmpty)
        #expect(hosts.pendingOperations[operation.operationId] == operation)
        #expect(hosts.operationDeliveries[operation.operationId] == .unknown)
        #expect(hosts.offlineHosts[retiredBox]?.stopRequests["old"] == .requested)
        #expect(throws: HostRoutingError.disconnected) { try hosts.endpoint(retiredBox) }
        await hosts.disconnectAll()
        #expect(try Data(contentsOf: cache.appendingPathComponent("hosts.json")) == before)
        #expect(try await outbox.pending() == [operation])
        try app.persistDrafts()
        try FileManager.default.removeItem(at: directory)
    } catch {
        await hosts.disconnectAll()
        try? FileManager.default.removeItem(at: directory)
        throw error
    }
}

@Test @MainActor func retiredLocalDraftParksUnsubmittedRemoteTextWithoutRetargeting() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let hosts = ClientDirectory(operationDirectory: directory.appendingPathComponent("operations"))
    do {
        let app = try retiredApp(directory, hosts: hosts)
        app.newSessionForm.executionHost = retiredBox
        app.newSessionForm.message = "Keep this remote draft"
        app.newSessionForm.folder = "/remote-only"
        let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1, pixelsHigh: 1,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        bitmap.setColor(.black, atX: 0, y: 0)
        let imageURL = directory.appendingPathComponent("remote-draft.png")
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: imageURL)
        let image = PastedImage(id: UUID(), url: imageURL, preview: NSImage(size: NSSize(width: 1, height: 1)))
        app.newSessionForm.attachments.items = [image]
        try app.persistDrafts()
        #expect(app.chooseNewChatHost(retiredLocal, independent: true))
        #expect(app.newSessionForm.executionHost == retiredLocal)
        #expect(app.newSessionForm.message.isEmpty && app.newSessionForm.folder.isEmpty)
        #expect(!app.chooseNewChatHost(retiredBox), "Retired destinations cannot be selected again")
        try app.persistDrafts()
        let saved = try DraftStore(directory: directory.appendingPathComponent("drafts")).load()
        let parked = try #require(saved.parkedNewTasks?.first)
        #expect(parked.executionHost == retiredBox && parked.message == "Keep this remote draft")
        #expect(parked.folder == "/remote-only" && saved.newTask.executionHost == retiredLocal)
        #expect(parked.attachments.map(\.id) == [image.id] && saved.newTask.attachments.isEmpty)
        let restored = try retiredApp(directory, hosts: hosts)
        #expect(restored.newSessionForm.executionHost == retiredLocal && restored.newSessionForm.message.isEmpty)
        try restored.persistDrafts()
        let after = try DraftStore(directory: directory.appendingPathComponent("drafts")).load()
        #expect(after.parkedNewTasks?.first?.message == parked.message)
        #expect(after.parkedNewTasks?.first?.attachments.map(\.id) == [image.id])
        #expect(try Data(contentsOf: imageURL) == png)
        await hosts.disconnectAll()
        try FileManager.default.removeItem(at: directory)
    } catch {
        await hosts.disconnectAll()
        try? FileManager.default.removeItem(at: directory)
        throw error
    }
}

@Test @MainActor func retiredRemoteProjectsCannotStartOrImportChats() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let hosts = ClientDirectory(operationDirectory: directory)
    do {
        let app = try retiredApp(directory, hosts: hosts)
        app.newSessionForm.message = "Keep Local text"
        #expect(!app.newSession(in: "old-project", message: "Remote request",
            context: HostViewContext(host: retiredBox, hosts: hosts)))
        #expect(app.newSessionForm.message == "Keep Local text")
        app.importGitHubProject(host: retiredBox)
        #expect(!app.githubImportPresented)
        app.importGitHubProject()
        #expect(app.githubImportPresented && app.githubImportHost == retiredLocal)
        try app.persistDrafts()
        await hosts.disconnectAll()
        try FileManager.default.removeItem(at: directory)
    } catch {
        await hosts.disconnectAll()
        try? FileManager.default.removeItem(at: directory)
        throw error
    }
}

@Test @MainActor func retiredCorruptOfflineMetadataCannotBlockLocalOrReplaceSavedFiles() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let hosts = ClientDirectory(operationDirectory: directory.appendingPathComponent("operations"))
    do {
        let cache = directory.appendingPathComponent("hosts")
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        let original = Data("{unreadable legacy metadata".utf8)
        let file = cache.appendingPathComponent("hosts.json")
        try original.write(to: file)
        let app = try retiredApp(directory, hosts: hosts)
        var localStarted = false
        await app.startHostConnections(offlineStore: OfflineHostStore(directory: cache)) { localStarted = true }
        #expect(localStarted && app.sessionActionError != nil)
        await hosts.disconnectAll()
        #expect(try Data(contentsOf: file) == original)
        try app.persistDrafts()
        try FileManager.default.removeItem(at: directory)
    } catch {
        await hosts.disconnectAll()
        try? FileManager.default.removeItem(at: directory)
        throw error
    }
}
