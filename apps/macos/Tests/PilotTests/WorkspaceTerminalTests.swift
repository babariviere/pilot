import Foundation
import PilotCore
import Testing
@testable import Pilot

@Suite(.serialized) struct WorkspaceTerminalTests {

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
