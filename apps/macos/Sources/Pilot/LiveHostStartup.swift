import Foundation
import PilotCore

extension AppModel {
    /// Called only by live start(), or explicitly by disposable startup fixtures. Local admission
    /// never opens remote connections. restoreOffline itself remains a read-only metadata operation.
    func startHostConnections(offlineStore: OfflineHostStore,
                              localStart: @MainActor () async -> Void) async {
        hosts.startScopedModels()
        await hosts.projectCheckouts.start()
        do {
            try await hosts.restoreOffline(from: offlineStore)
        } catch {
            sessionActionError = "Could not restore saved remote history. The saved file was kept."
        }
        await localStart()
    }
}
