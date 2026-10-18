import PilotCore
import SwiftUI

@MainActor struct ScopedModelsSettings: View {
    @ObservedObject var hosts: HostClients
    let localHost: HostRef?

    var body: some View {
        SettingsPage("Scoped models", subtitle: "Choose pi’s global models, with independent availability on each host.") {
            ScopedModelsSection(sync: hosts.scopedModels, hosts: rows, localHost: localHost)
        }
    }

    private var rows: [ScopedModelsHostRow] {
        let local = localHost.map { [ScopedModelsHostRow(host: $0, title: "Local", connected: hosts.available.contains($0))] } ?? []
        return local + hosts.offlineHosts.values.sorted {
            $0.configuration.alias.localizedStandardCompare($1.configuration.alias) == .orderedAscending
        }.map { ScopedModelsHostRow(host: $0.host, title: $0.configuration.alias, connected: hosts.available.contains($0.host)) }
    }
}
