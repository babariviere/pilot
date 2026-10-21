import PilotCore
import SwiftUI

@MainActor struct ScopedModelsSettings: View {
    @ObservedObject var hosts: ClientDirectory
    let localHost: HostRef?

    var body: some View {
        SettingsPage("Scoped models", subtitle: "Choose pi’s global models on this Mac.") {
            ScopedModelsSection(sync: hosts.scopedModels, hosts: rows, localHost: localHost)
        }
    }

    private var rows: [ScopedModelsHostRow] {
        return localHost.map { [ScopedModelsHostRow(host: $0, title: "Local", connected: hosts.available.contains($0))] } ?? []
    }
}
