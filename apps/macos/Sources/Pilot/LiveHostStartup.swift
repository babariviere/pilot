import Foundation
import PilotCore

extension AppModel {
    /// Called only by live start(), or explicitly by disposable startup fixtures. Local admission
    /// never awaits SSH attempts. restoreOffline itself remains a read-only metadata operation.
    func startHostConnections(offlineStore: OfflineHostStore,
                              localStart: @MainActor () async -> Void) async {
        hosts.startScopedModels()
        hosts.startAutomaticDevboxUpdates()
        await hosts.projectCheckouts.start()
        do {
            try await hosts.restoreOffline(from: offlineStore)
            hosts.startSavedConnections()
        } catch {
            sessionActionError = "Could not restore offline devbox metadata. The saved file was kept."
        }
        await localStart()
    }
}
