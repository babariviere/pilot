import Foundation
import PilotCore
import Testing
@testable import Pilot

private let machineHost = HostRef(hostId: "box", daemonId: "daemon", lineageId: "history")
private let otherMachineHost = HostRef(hostId: "box-two", daemonId: "daemon-two", lineageId: "history-two")

private func machineFixture(_ memory: Int = 16_000_000_000) throws -> MachineInformation {
    try JSONDecoder().decode(MachineInformation.self, from: Data("""
    {"checkedAt":1000,"runtime":{"state":"running","version":"1.2.3","nodeVersion":"24.1.0"},
    "service":{"state":"unknown"},"os":"Fixture Linux","kernel":"6.fixture","architecture":"x64",
    "cpuModel":"Fixture CPU","logicalCpuCount":8,"memoryTotalBytes":\(memory),
    "disk":{"scope":"runtime-data","totalBytes":1000000,"availableBytes":250000}}
    """.utf8))
}

@Test func machineCopySeparatesConnectionFromRuntimeAndAgesLastKnownObservations() throws {
    let token = HostConnectionToken(host: machineHost)
    let now = Date(timeIntervalSince1970: 1000)
    let value = DevboxMachineObservation(information: try machineFixture(), token: token, receivedAt: now)
    #expect(DevboxMachineCopy.availability(connected: true, state: nil) == "Connected")
    #expect(DevboxMachineCopy.availability(connected: false, state: nil) == "Unknown")
    #expect(DevboxMachineCopy.availability(connected: false, state: .disconnected) == "Disconnected")
    #expect(DevboxMachineCopy.availability(connected: false, state: .connecting(attempt: 1)) == "Connecting")
    #expect(DevboxMachineCopy.runtime(nil) == "Unknown")
    #expect(DevboxMachineCopy.runtime(value.information).contains("Running at last check"))
    #expect(!DevboxMachineCopy.stale(value, token: token, failed: false, now: now))
    #expect(DevboxMachineCopy.stale(value, token: nil, failed: false, now: now))
    #expect(DevboxMachineCopy.stale(value, token: token, failed: true, now: now))
    #expect(DevboxMachineCopy.stale(value, token: HostConnectionToken(host: machineHost), failed: false, now: now))
    #expect(DevboxMachineCopy.stale(value, token: token, failed: false, now: now.addingTimeInterval(300)))
    #expect(DevboxMachineCopy.bytes(nil) == "Unavailable")
    #expect(DevboxMachineCopy.bytes(-1) == "Unavailable")
    #expect(DevboxMachineCopy.bytes(.infinity) == "Unavailable")
    #expect(DevboxMachineCopy.disk(nil) == "Unavailable")
}

@Test @MainActor func machineObservationsKeepPinsIsolatedAndRetainStaleDataAfterFailedChecks() async throws {
    let store = DevboxMachineStore()
    let first = DevboxMachineObservation(information: try machineFixture(), token: HostConnectionToken(host: machineHost), receivedAt: Date())
    let second = DevboxMachineObservation(information: try machineFixture(8_000_000_000), token: HostConnectionToken(host: otherMachineHost), receivedAt: Date())
    await store.refresh(machineHost) { host in #expect(host == machineHost); return first }
    await store.refresh(otherMachineHost) { host in #expect(host == otherMachineHost); return second }
    #expect(store.observations[machineHost] == first)
    #expect(store.observations[otherMachineHost] == second)
    await store.refresh(machineHost) { _ in throw NSError(domain: "private-token-diagnostic", code: 1) }
    #expect(store.failures.contains(machineHost))
    #expect(!store.failures.contains(otherMachineHost))
    #expect(store.observations[machineHost] == first)
    #expect(store.attempts[machineHost] != nil)
    #expect(store.checking.isEmpty)
    // A mismatched response cannot populate a different host partition.
    await store.refresh(machineHost) { _ in second }
    #expect(store.observations[machineHost] == first)
    await store.refresh(machineHost) { _ in first }
    #expect(!store.failures.contains(machineHost))
}

@Test @MainActor func machineRefreshCoalescesOverlappingRequests() async throws {
    let store = DevboxMachineStore()
    let value = DevboxMachineObservation(information: try machineFixture(), token: HostConnectionToken(host: machineHost), receivedAt: Date())
    var release: CheckedContinuation<DevboxMachineObservation, Never>?
    let first = Task { await store.refresh(machineHost) { _ in await withCheckedContinuation { release = $0 } } }
    for _ in 0..<100 where release == nil { await Task.yield() }
    guard let release else { first.cancel(); Issue.record("Refresh did not reach its fixture barrier"); return }
    await store.refresh(machineHost) { _ in Issue.record("Overlapping refresh should coalesce"); return value }
    release.resume(returning: value)
    await first.value
    #expect(store.observations[machineHost] == value)
    #expect(store.checking.isEmpty)
}

private final class MachineHTTPFixture: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".machine.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard request.url?.path == "/api/machine", request.httpMethod == "GET" else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL)); return
        }
        let memory = request.url?.host == "a.machine.invalid" ? 16_000_000_000 : 8_000_000_000
        do {
            let data = try JSONEncoder().encode(machineFixture(memory))
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["content-type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@Test @MainActor func machineAPIUsesOnlyTheRequestedHostAndNeverFallsBackWhenDisconnected() async throws {
    func client(_ name: String) -> PilotClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MachineHTTPFixture.self]
        let client = PilotClient(baseURL: URL(string: "http://\(name).machine.invalid"), commandConfiguration: configuration)
        client.loadFixture(projects: [], sessions: [])
        return client
    }
    let hosts = HostClients(), first = client("a"), second = client("b")
    try hosts.install(first, host: machineHost)
    try hosts.install(second, host: otherMachineHost)
    let a = try await hosts.machineInformation(on: machineHost)
    let b = try await hosts.machineInformation(on: otherMachineHost)
    #expect(a.token.host == machineHost && a.information.memoryTotalBytes == 16_000_000_000)
    #expect(b.token.host == otherMachineHost && b.information.memoryTotalBytes == 8_000_000_000)
    await hosts.disconnect(machineHost)
    do { _ = try await hosts.machineInformation(on: machineHost); Issue.record("Disconnected host must not use another endpoint") }
    catch { #expect(error as? HostRoutingError == .disconnected) }
    #expect(second.connected)
    #expect(DevboxMachineCopy.stale(a, token: try? hosts.token(for: machineHost), failed: false, now: Date()))
}
