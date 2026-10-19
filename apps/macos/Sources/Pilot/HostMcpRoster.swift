import Combine
import Foundation
import PilotCore

/// Presentation projection only, not another MCP/config registry. Session streaming must not redraw
/// every Connections row; publish only host/availability/client replacements. No network or file I/O.
@MainActor final class HostMcpRoster: ObservableObject {
    struct Row: Identifiable, Equatable {
        let host: HostRef
        let name: String
        let available: Bool
        let client: PilotClient
        var id: HostRef { host }
        nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.host == rhs.host && lhs.name == rhs.name && lhs.available == rhs.available && lhs.client === rhs.client
        }
    }
    @Published private(set) var rows: [Row] = []
    private let hosts: HostClients
    private var local: HostRef?
    private var saved: [HostRef: OfflineHostSnapshot]
    private var available: Set<HostRef>
    private var subscriptions: Set<AnyCancellable> = []

    init(hosts: HostClients, local: HostRef?) {
        self.hosts = hosts; self.local = local; saved = hosts.offlineHosts; available = hosts.available
        hosts.$offlineHosts.sink { [weak self] value in self?.saved = value; self?.refresh() }.store(in: &subscriptions)
        hosts.$available.sink { [weak self] value in self?.available = value; self?.refresh() }.store(in: &subscriptions)
    }

    func update(local: HostRef?) { self.local = local; refresh() }

    private func refresh() {
        let peers = saved.keys.filter { $0.hostId != "local" }
        let aliases = Dictionary(grouping: peers, by: { saved[$0]?.configuration.alias ?? $0.hostId })
        let ordered = peers.sorted {
            let a = saved[$0]?.configuration.alias ?? $0.hostId, b = saved[$1]?.configuration.alias ?? $1.hostId
            return a == b ? $0.hostId < $1.hostId : a < b
        }
        let all = local.map { [$0] } ?? []
        let next = (all + ordered).map { host in
            let alias = saved[host]?.configuration.alias ?? host.hostId
            let name = host.hostId == "local" ? "Local" : (aliases[alias]?.count ?? 0) > 1 ? "\(alias) · \(host.daemonId.prefix(8))" : alias
            return Row(host: host, name: name, available: available.contains(host), client: hosts.presentationClient(host))
        }
        if next != rows { rows = next }
    }
}
