import Foundation
import Darwin
import PilotCore
import Testing
@testable import Pilot

private final class TerminalFixtureDiagnostics: @unchecked Sendable {
    private let lock = NSLock()
    private var retained = Data()
    private let finished = DispatchSemaphore(value: 0)
    let pipe = Pipe()

    init() {
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            guard let chunk = try? handle.read(upToCount: 1024), !chunk.isEmpty else {
                handle.readabilityHandler = nil
                self.finished.signal()
                return
            }
            self.lock.withLock {
                self.retained.append(chunk.prefix(max(0, 4096 - self.retained.count)))
            }
        }
    }

    func finish() {
        _ = finished.wait(timeout: .now() + 1)
        pipe.fileHandleForReading.readabilityHandler = nil
    }

    func failure(status: Int32) -> String {
        let text = lock.withLock { String(decoding: retained, as: UTF8.self) }
        let reason: String
        if text.contains("PILOT_TERMINAL_FIXTURE_STARTUP:listen-address-in-use") {
            reason = "Could not reserve a disposable loopback port."
        } else if text.contains("PILOT_TERMINAL_FIXTURE_STARTUP:listen-failed") {
            reason = "Could not start the disposable loopback server."
        } else if text.contains("env: node:") {
            reason = "Node is unavailable on PATH. Install the repository's pinned Node version."
        } else {
            reason = "Check the Node executable and the dependency-free terminal fixture startup."
        }
        return "Terminal fixture did not start (exit \(status)). \(reason)"
    }
}

private final class TerminalWireFixture: @unchecked Sendable {
    let process: Process
    let url: URL
    private let diagnostics: TerminalFixtureDiagnostics
    private let control: Pipe
    init(legacy: Bool = false) throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let process = Process(), output = Pipe(), control = Pipe()
        let diagnostics = TerminalFixtureDiagnostics()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", root.appendingPathComponent("apps/macos/Tests/Fixtures/workspace-terminal.cjs").path, root.path, legacy ? "legacy" : "current"]
        process.standardOutput = output
        process.standardInput = control
        process.standardError = diagnostics.pipe
        do { try process.run() }
        catch {
            diagnostics.finish()
            throw ClientError("Could not launch the terminal fixture. Check the Node executable on PATH.")
        }
        var line = Data()
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty, byte != Data([10]), line.count < 16 { line.append(byte) }
        guard let port = Int(String(decoding: line, as: UTF8.self)), (1...65535).contains(port) else {
            Self.reap(process, control: control)
            diagnostics.finish()
            throw ClientError(diagnostics.failure(status: process.terminationStatus))
        }
        self.process = process
        self.diagnostics = diagnostics
        self.control = control
        url = URL(string: "http://127.0.0.1:\(port)")!
    }
    func close() {
        Self.reap(process, control: control)
        diagnostics.finish()
    }

    private static func reap(_ process: Process, control: Pipe) {
        try? control.fileHandleForWriting.close()
        let fallback = DispatchWorkItem {
            if process.isRunning { _ = kill(process.processIdentifier, SIGKILL) }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 3, execute: fallback)
        process.waitUntilExit()
        fallback.cancel()
    }
}

@Suite(.serialized) struct WorkspaceTerminalTransportTests {
    @Test func fixtureStartupDiagnosticsAreBoundedAndNeverEchoUntrustedStderr() throws {
        let known = TerminalFixtureDiagnostics()
        try known.pipe.fileHandleForWriting.write(contentsOf: Data("PILOT_TERMINAL_FIXTURE_STARTUP:listen-failed\nprivate-fixture-token".utf8))
        try known.pipe.fileHandleForWriting.close()
        known.finish()
        #expect(known.failure(status: 78).contains("disposable loopback server"))
        #expect(!known.failure(status: 78).contains("private-fixture-token"))

        let oversized = TerminalFixtureDiagnostics()
        let raw = "private-fixture-token\n" + String(repeating: "x", count: 8192)
            + "PILOT_TERMINAL_FIXTURE_STARTUP:listen-address-in-use"
        try oversized.pipe.fileHandleForWriting.write(contentsOf: Data(raw.utf8))
        try oversized.pipe.fileHandleForWriting.close()
        oversized.finish()
        #expect(!oversized.failure(status: 1).contains("private-fixture-token"))
        #expect(oversized.failure(status: 1).contains("dependency-free"))
    }

    @Test @MainActor func oldRuntimeIsRefusedBeforeAnyLegacySocketCanStartAShell() async throws {
        let fixture = try await Task.detached { try TerminalWireFixture(legacy: true) }.value
        let client = PilotClient(baseURL: fixture.url)
        client.loadFixture(projects: [], sessions: [])
        do {
            _ = try await client.hello()
            var status: TerminalConnectionState = .connecting
            client.attachTerminal("same", cols: 80, rows: 24, .init(cols: 80, rows: 24,
                onData: { _ in }, onExit: { _ in }, onReplay: {}, onStatus: { status = $0 }))
            guard case .unavailable = status else { throw ClientError("Old terminal capability was not refused") }
            let (data, _) = try await URLSession.shared.data(from: fixture.url.appendingPathComponent("api/stats"))
            let stats = try JSONValue.decode(data)
            #expect(stats["connections"]?.int == 0)
        } catch {
            client.detachTerminal("same"); await Task.detached { fixture.close() }.value; throw error
        }
        client.detachTerminal("same"); await Task.detached { fixture.close() }.value
    }

    @MainActor private func until(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !condition() {
            guard Date() < deadline else { throw ClientError("Terminal condition timed out") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    @Test @MainActor func lostReplyReconnectNeverRestartsOrReplaysInputAndCloseWaitsForExitFrame() async throws {
        let fixture = try await Task.detached { try TerminalWireFixture() }.value
        let client = PilotClient(baseURL: fixture.url)
        client.loadFixture(projects: [], sessions: [])
        var statuses: [TerminalConnectionState] = [], data = "", replays = 0, exits = 0
        client.attachTerminal("same", cols: 80, rows: 24, restart: true, .init(cols: 80, rows: 24,
            onData: { data += $0 }, onExit: { _ in exits += 1 }, onReplay: { replays += 1 },
            onStatus: { status in
                statuses.append(status)
                if status == .disconnected { #expect(!client.terminalInput("same", Data("offline".utf8))) }
            }))
        do {
            try await until { statuses.contains(.connected) }
            #expect(exits == 0)
            #expect(replays == 1)
            #expect(client.terminalInput("same", Data("once".utf8)))
            try await until { !data.isEmpty }
            let stats = try JSONValue.decode(Data(data.utf8))
            let opens = try #require(stats["opens"]?.array)
            #expect(opens.count == 2)
            #expect(opens[0]["requestId"] == opens[1]["requestId"])
            #expect(stats["inputs"]?.array == [.string("once")])
            #expect(client.closeTerminal("same"))
            try await until { exits == 1 }
        } catch {
            client.detachTerminal("same"); await Task.detached { fixture.close() }.value; throw error
        }
        client.detachTerminal("same")
        await Task.detached { fixture.close() }.value
    }

    @Test @MainActor func daemonBootChangeRequiresExplicitNewShellInsteadOfAutomaticRecreation() async throws {
        let fixture = try await Task.detached { try TerminalWireFixture() }.value
        let client = PilotClient(baseURL: fixture.url)
        client.loadFixture(projects: [], sessions: [])
        var status: TerminalConnectionState = .connecting, exited = false
        client.attachTerminal("same", cols: 80, rows: 24, .init(cols: 80, rows: 24,
            onData: { _ in }, onExit: { _ in exited = true }, onReplay: {}, onStatus: { status = $0 }))
        do {
            try await until { status == .connected }
            #expect(client.terminalInput("same", Data("reboot".utf8)))
            try await until { if case .unavailable = status { return true }; return false }
            #expect(!exited)
            #expect(!client.terminalInput("same", Data("must not recreate".utf8)))
        } catch {
            client.detachTerminal("same"); await Task.detached { fixture.close() }.value; throw error
        }
        client.detachTerminal("same")
        await Task.detached { fixture.close() }.value
    }
}
