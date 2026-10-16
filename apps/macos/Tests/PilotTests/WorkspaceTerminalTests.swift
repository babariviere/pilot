import Foundation
import PilotCore
import Testing
@testable import Pilot

@Suite(.serialized) struct WorkspaceTerminalTests {
    @Test @MainActor func hostRegistrationsKeepCollidingIDsAndReconnectIntentWithoutLocalFallback() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory)
        let local = HostRef(hostId: "local", daemonId: "local", lineageId: "one")
        let remote = HostRef(hostId: "box", daemonId: "remote", lineageId: "two")
        let localClient = PilotClient(), remoteClient = PilotClient()
        localClient.loadFixture(projects: [], sessions: [])
        remoteClient.loadFixture(projects: [], sessions: [])
        try hosts.install(localClient, host: local); try hosts.install(remoteClient, host: remote)
        let a = HostResourceRef(host: local, kind: .session, localId: "same")
        let b = HostResourceRef(host: remote, kind: .session, localId: "same")
        var localData: [String] = [], remoteData: [String] = [], remoteStatus: [TerminalConnectionState] = []
        try hosts.attachTerminal(a, attachment: .init(cols: 80, rows: 24,
            onData: { localData.append($0) }, onExit: { _ in }, onReplay: {}))
        try hosts.attachTerminal(b, restart: true, attachment: .init(cols: 80, rows: 24,
            onData: { remoteData.append($0) }, onExit: { _ in }, onReplay: {}, onStatus: { remoteStatus.append($0) }))
        let intent = try #require(remoteClient.terminalIntents["same"])
        intent.bootId = "remembered-boot"; intent.terminalId = "remembered-shell"
        localClient.handle(.terminalData(sessionId: "same", data: "Local"))
        remoteClient.handle(.terminalData(sessionId: "same", data: "Remote"))
        #expect(localData == ["Local"]); #expect(remoteData == ["Remote"])
        await hosts.disconnect(remote)
        #expect(remoteStatus.last == .disconnected)
        #expect(!hosts.terminalInput(b, data: Data("never queued".utf8)))
        #expect(!hosts.closeTerminal(b))
        remoteClient.handle(.terminalExit(sessionId: "same", code: 0))
        #expect(localClient.terminalIntents["same"] != nil)
        let replacement = PilotClient(); replacement.loadFixture(projects: [], sessions: [])
        try hosts.install(replacement, host: remote)
        #expect(replacement.terminalIntents["same"] === intent)
        #expect(intent.restart)
        #expect(intent.bootId == "remembered-boot")
        #expect(intent.terminalId == "remembered-shell")
        remoteClient.handle(.terminalData(sessionId: "same", data: "stale"))
        replacement.handle(.terminalData(sessionId: "same", data: "new endpoint"))
        #expect(remoteData == ["Remote", "new endpoint"])
        hosts.detachTerminal(b)
        #expect(replacement.terminalIntents["same"] == nil)
        #expect(localClient.terminalIntents["same"] != nil)
        hosts.detachTerminal(a)
    }

    @Test @MainActor func callbackQueuesBoundInputCoalesceResizesAndCancelLateDelivery() async throws {
        var received: [Data] = [], resize: (Int, Int)?, overflow = false, paused: Bool?
        let callbacks = TerminalCallbacks { inputs, viewport, rejected, backlog in
            received += inputs; resize = viewport; overflow = rejected; paused = backlog
        }
        for i in 0..<1000 {
            callbacks.write(Data(repeating: 120, count: 16 * 1024))
            callbacks.resize(cols: i, rows: 24)
            callbacks.backlog(i % 2 == 0)
        }
        let deadline = Date().addingTimeInterval(1)
        while !overflow && Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        #expect(received.reduce(0) { $0 + $1.count } <= 256 * 1024)
        #expect(overflow)
        #expect(resize?.0 == 999)
        #expect(paused == false)
        callbacks.close()
        let count = received.count
        callbacks.write(Data("must not send".utf8))
        await Task.yield()
        #expect(received.count == count)
    }

    @Test func protocolDecodesBootAndInstanceHandshake() throws {
        let hello = try ServerUpdate.decode(Data(#"{"type":"terminal.hello","sessionId":"same","bootId":"boot","terminalId":"shell"}"#.utf8))
        guard let hello, case let .terminalHello(id, boot, terminal) = hello else { Issue.record("Missing terminal hello"); return }
        #expect(id == "same" && boot == "boot" && terminal == "shell")
        let ready = try ServerUpdate.decode(Data(#"{"type":"terminal.ready","sessionId":"same","terminalId":"shell"}"#.utf8))
        guard let ready, case let .terminalReady(readyId, readyTerminal) = ready else { Issue.record("Missing terminal ready"); return }
        #expect(readyId == "same" && readyTerminal == "shell")
    }

    @Test @MainActor func nativeInputQueuedBeforeDisconnectCannotLeakIntoAReplacementConnection() async throws {
        var received: [Data] = []
        let callbacks = TerminalCallbacks { inputs, _, _, _ in received += inputs }
        callbacks.write(Data("before disconnect".utf8))
        callbacks.setInputEnabled(false)
        callbacks.write(Data("offline".utf8))
        callbacks.setInputEnabled(true)
        callbacks.write(Data("new explicit input".utf8))
        let deadline = Date().addingTimeInterval(1)
        while received.isEmpty && Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        #expect(received == [Data("new explicit input".utf8)])
        callbacks.close()
    }
}
