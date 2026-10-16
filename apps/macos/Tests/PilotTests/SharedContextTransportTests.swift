import Foundation
import Darwin
import PilotCore
import Testing
@testable import Pilot

private final class SharedContextWireFixture: @unchecked Sendable {
    let process: Process
    let home: URL
    let target: URL
    private let control: FileHandle
    init() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let process = Process(), output = Pipe(), input = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", root.appendingPathComponent("apps/macos/Tests/Fixtures/shared-context.cjs").path, root.path]
        process.standardOutput = output
        process.standardInput = input
        try process.run()
        var line = Data()
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty,
              byte != Data([10]), line.count < 256 { line.append(byte) }
        guard let ports = try? JSONValue.decode(line), let home = ports["home"]?.int, let target = ports["target"]?.int else {
            if process.isRunning { process.terminate() }
            process.waitUntilExit(); throw ClientError("Shared-context fixture did not start")
        }
        self.process = process
        control = input.fileHandleForWriting
        self.home = URL(string: "http://127.0.0.1:\(home)")!
        self.target = URL(string: "http://127.0.0.1:\(target)")!
    }
    func close() {
        try? control.close()
        let force = DispatchWorkItem { [process] in
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 2, execute: force)
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
        force.cancel()
    }

    func command(_ path: String) async throws {
        var request = URLRequest(url: home.appendingPathComponent("fixture/\(path)"))
        request.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ClientError("Shared-context fixture command failed")
        }
    }
    func stats() async throws -> JSONValue {
        let (data, response) = try await URLSession.shared.data(from: home.appendingPathComponent("fixture/stats"))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ClientError("Shared-context fixture statistics failed")
        }
        return try JSONValue.decode(data)
    }
}

@Suite struct SharedContextTransportTests {
    @MainActor private func until(_ predicate: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(90))
        while !(try await predicate()) {
            guard ContinuousClock.now < deadline else { throw ClientError("Shared-context wire condition timed out") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    @Test @MainActor func liveChangeThenLostReplyReconnectUsesRealPinnedClientsAndOriginalOperation() async throws {
        let fixture = try await Task.detached { try SharedContextWireFixture() }.value
        let home = HostRef(hostId: "local", daemonId: "home", lineageId: "home-lineage")
        let target = HostRef(hostId: "my-ssh-alias", daemonId: "target", lineageId: "target-lineage")
        let homeClient = PilotClient(), targetClient = PilotClient()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory)
        do {
            try hosts.install(homeClient, host: home); try hosts.install(targetClient, host: target)
            homeClient.connect(to: fixture.home); targetClient.connect(to: fixture.target)
            try await until { hosts.available == [home, target] && hosts.sharedContextCourier.isIdle }
            let firstGeneration = targetClient.connectionGeneration
            var homeBarriers = 0, targetBarriers = 0
            homeClient.onSessionsChanged = { _, _ in homeBarriers += 1 }
            targetClient.onSessionsChanged = { _, _ in targetBarriers += 1 }

            // Already connected, no reconnect or explicit app reconcile call. The control
            // invalidation must move this daemon-produced envelope and durably ack its owner.
            try await fixture.command("enqueue")
            try await until { try await fixture.stats()["acknowledgments"]?.array?.count == 2 }
            #expect(targetClient.connectionGeneration == firstGeneration)

            // First transmission fence, pending/final receipt and source ack notifications
            // deliberately overtake HTTP responses. Both directions must still converge.
            try await until { hosts.sharedContextCourier.isIdle }
            var settled = try await fixture.stats()
            #expect(settled["outstandingByHost"]?["home"]?.int == 0)
            #expect(settled["outstandingByHost"]?["target"]?.int == 0)
            let notifications = try #require(settled["notifications"]?.array)
            for operation in ["original-1", "fact-original-1"] {
                for phase in ["transmit-fence", "receipt-pending", "receipt-final", "source-ack"] {
                    #expect(notifications.filter {
                        $0["phase"]?.string == phase && $0["operationId"]?.string == operation
                    }.count == 1, "Only durable transitions emit invalidations, not reads")
                }
            }
            // Event-driven round trips drain preceding control frames. No fixed sleeps or
            // production polling timer is needed to prove unrelated snapshots stay quiet.
            try await fixture.command("barrier")
            try await until { homeBarriers >= 1 && targetBarriers >= 1 && hosts.sharedContextCourier.isIdle }
            settled = try await fixture.stats()
            let idleRequests = settled["requests"]?.array?.count
            try await fixture.command("barrier")
            try await until { homeBarriers >= 2 && targetBarriers >= 2 && hosts.sharedContextCourier.isIdle }
            #expect(try await fixture.stats()["requests"]?.array?.count == idleRequests)

            // Acceptance survives a lost HTTP response. Reconnecting the actual control
            // sockets must look up the original receipt, not reserve or POST a new intent.
            try await fixture.command("lost-reply")
            try await until {
                try await fixture.stats()["requests"]?.array?.contains {
                    $0["path"]?.string == "/api/operations" && $0["operationId"]?.string == "original-2"
                } == true
            }
            try await fixture.command("reconnect")
            try await until { try await fixture.stats()["acknowledgments"]?.array?.count == 4 }
            try await until { hosts.sharedContextCourier.isIdle }
            let stats = try await fixture.stats()
            let requests = try #require(stats["requests"]?.array)
            let posts = requests.filter { $0["path"]?.string == "/api/operations" }
            #expect(posts.count == 4)
            #expect(Set(posts.compactMap { $0["operationId"]?.string }) ==
                ["original-1", "original-2", "fact-original-1", "fact-original-2"])
            #expect(posts.filter { $0["operationId"]?.string?.hasPrefix("original-") == true }
                .allSatisfy { $0["name"]?.string == "target" })
            #expect(posts.filter { $0["operationId"]?.string?.hasPrefix("fact-") == true }
                .allSatisfy { $0["name"]?.string == "home" })
            #expect(posts.first { $0["operationId"]?.string == "original-2" }?["payload"]?.string ==
                "{ \"source\": \"daemon\", \"sequence\": 2 }")
            for operation in ["original-1", "original-2", "fact-original-1", "fact-original-2"] {
                let post = try #require(requests.firstIndex {
                    $0["path"]?.string == "/api/operations" && $0["operationId"]?.string == operation
                })
                #expect(requests[..<post].contains {
                    $0["path"]?.string == "/api/operations/receipt" && $0["operationId"]?.string == operation
                })
            }
            #expect(targetClient.connectionGeneration != firstGeneration)
            #expect(stats["outstanding"]?.int == 0)
            #expect(try await OperationOutbox(directory: directory).pending().isEmpty,
                "The app never owns executable shared-context intents")
        } catch {
            await hosts.disconnectAll(); homeClient.disconnect(); targetClient.disconnect()
            await Task.detached { fixture.close() }.value
            throw error
        }
        await hosts.disconnectAll(); homeClient.disconnect(); targetClient.disconnect()
        await Task.detached { fixture.close() }.value
    }
}
