import Combine
import Foundation
import PilotCore
import SwiftUI

struct DevboxMachineObservation: Equatable {
    let information: MachineInformation
    let token: HostConnectionToken
    /// Local receipt time avoids treating the remote clock as a freshness authority.
    let receivedAt: Date
}

/// One owner per HostClients. Keep last-known observations across selection changes, never across pins.
@MainActor final class DevboxMachineStore: ObservableObject {
    @Published private(set) var observations: [HostRef: DevboxMachineObservation] = [:]
    @Published private(set) var checking: Set<HostRef> = []
    @Published private(set) var failures: Set<HostRef> = []
    @Published private(set) var attempts: [HostRef: Date] = [:]

    func refresh(_ host: HostRef, read: (HostRef) async throws -> DevboxMachineObservation) async {
        guard checking.insert(host).inserted else { return }
        attempts[host] = Date()
        defer { checking.remove(host) }
        do {
            let value = try await read(host)
            guard value.token.host == host else { throw HostRoutingError.identityChanged }
            observations[host] = value
            failures.remove(host)
        } catch {
            // Keep the last observation and never render raw transport/server diagnostics.
            failures.insert(host)
        }
    }
}

extension HostClients {
    func machineInformation(on host: HostRef) async throws -> DevboxMachineObservation {
        let client = try endpoint(host), fence = try token(for: host)
        let value = try await client.machineInformation()
        try validate(fence)
        return DevboxMachineObservation(information: value, token: fence, receivedAt: Date())
    }
}

enum DevboxMachineCopy {
    static func availability(connected: Bool, state: SSHTunnelState?) -> String {
        if connected { return "Connected" }
        switch state {
        case .connecting: return "Connecting"
        case .disconnected, .failed: return "Disconnected"
        default: return "Unknown"
        }
    }

    static func stale(_ observation: DevboxMachineObservation, token: HostConnectionToken?, failed: Bool, now: Date) -> Bool {
        token != observation.token || failed || now.timeIntervalSince(observation.receivedAt) >= 300
    }

    static func runtime(_ information: MachineInformation?) -> String {
        guard let information, information.runtime.state == "running" else { return "Unknown" }
        return "Running at last check · v\(information.runtime.version) · Node \(information.runtime.nodeVersion)"
    }

    static func bytes(_ value: Double?) -> String {
        guard let value, value.isFinite, value >= 0, value < Double(Int64.max) else { return "Unavailable" }
        return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .memory)
    }

    static func disk(_ value: MachineInformation.Disk?) -> String {
        guard let value, value.scope == "runtime-data" else { return "Unavailable" }
        guard value.totalBytes != nil || value.availableBytes != nil else { return "Unavailable" }
        return "\(bytes(value.availableBytes)) available / \(bytes(value.totalBytes)) total"
    }
}

@MainActor struct DevboxMachineSection: View {
    let host: HostRef
    @ObservedObject private var hosts: HostClients
    @ObservedObject private var store: DevboxMachineStore

    init(host: HostRef, hosts: HostClients) {
        self.host = host; self.hosts = hosts; self.store = hosts.machineInformationStore
    }

    private var connected: Bool { hosts.available.contains(host) }
    private var token: HostConnectionToken? { try? hosts.token(for: host) }

    var body: some View {
        // This only ages the display. It never performs a network request.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let observation = store.observations[host]
            let information = observation?.information
            let stale = observation.map { DevboxMachineCopy.stale($0, token: token, failed: store.failures.contains(host), now: context.date) } ?? false
            SettingsSection("Machine", explanation: "Read-only information from this devbox. Values describe the last check, not live monitoring. Disconnected machines may still be running work.") {
                SettingsRow("Connection", detail: DevboxMachineCopy.availability(connected: connected, state: hosts.connectionStates[host])) {
                    Button(store.checking.contains(host) ? "Checking…" : "Refresh") { Task { await refresh() } }
                        .controlSize(.small).disabled(!connected || store.checking.contains(host))
                }
                SettingsRow("Last checked") {
                    if let observation {
                        Text("\(stale ? "Stale · " : "")\(RelativeDate.ago(observation.receivedAt.timeIntervalSince1970 * 1000, now: context.date))")
                            .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                            .help("Received: \(RelativeDate.exact(observation.receivedAt.timeIntervalSince1970 * 1000)). Devbox check time: \(RelativeDate.exact(observation.information.checkedAt))")
                    } else { value("Not checked") }
                }
                if stale { SettingsRow { SettingsNote("Stale, last-known values below. Refresh after reconnecting; current runtime and service state are unknown.") } }
                if store.failures.contains(host) {
                    SettingsRow { InlineProblem("Machine information could not be checked. This runtime may not support it yet. Existing values were kept; no host changes were made.") }
                    if let attempt = store.attempts[host] {
                        row("Last attempt", RelativeDate.ago(attempt.timeIntervalSince1970 * 1000, now: context.date))
                    }
                }
                row("Runtime", DevboxMachineCopy.runtime(information))
                row("Service", "Unknown · service manager not inspected")
                row("Operating system", information?.os ?? "Unavailable")
                row("Kernel", information?.kernel ?? "Unavailable")
                row("Architecture", information?.architecture ?? "Unavailable")
                row("CPU", information?.cpuModel ?? "Unavailable")
                row("Online logical CPUs", information?.logicalCpuCount.map { String($0) } ?? "Unavailable")
                row("Total memory", DevboxMachineCopy.bytes(information?.memoryTotalBytes))
                row("Runtime data volume", DevboxMachineCopy.disk(information?.disk))
                SettingsRow { SettingsNote("Disk space is for the runtime data filesystem. Project or nested workspace volumes may differ. Unavailable fields are not reported by this host; no packages are installed to inspect them.") }
            }
        }
        .task(id: token) { if connected { await refresh() } }
    }

    private func refresh() async { await store.refresh(host) { try await hosts.machineInformation(on: $0) } }
    private func row(_ title: String, _ text: String) -> some View {
        SettingsRow(title) { value(text) }
    }
    private func value(_ text: String) -> some View {
        Text(text).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            .multilineTextAlignment(.trailing).textSelection(.enabled)
    }
}
