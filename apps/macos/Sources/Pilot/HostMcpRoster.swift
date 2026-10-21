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
    private let hosts: ClientDirectory
    private var local: HostRef?
    private var available: Set<HostRef>
    private var subscriptions: Set<AnyCancellable> = []

    init(hosts: ClientDirectory, local: HostRef?) {
        self.hosts = hosts; self.local = local; available = hosts.available
        hosts.$available.sink { [weak self] value in self?.available = value; self?.refresh() }.store(in: &subscriptions)
    }

    func update(local: HostRef?) { self.local = local; refresh() }

    private func refresh() {
        let next = local.map { [Row(host: $0, name: "Local", available: available.contains($0), client: hosts.presentationClient($0))] } ?? []
        if next != rows { rows = next }
    }
}
