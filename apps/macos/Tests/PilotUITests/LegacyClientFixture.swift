import Foundation
import PilotCore
@testable import Pilot

/// Writable fixtures are Local only. Legacy identities contribute immutable navigation snapshots.
@MainActor func loadClientFixture(_ client: PilotClient, host: HostRef, into directory: ClientDirectory) throws {
    if host.hostId == "local", directory.localHost == nil || directory.localHost == host {
        try directory.install(client, host: host); return
    }
    directory.restoreLegacySnapshot(OfflineHostSnapshot(host: host,
        configuration: try LegacyDevboxAddress(alias: host.hostId), sessions: client.sessions,
        projects: client.projects, missions: client.missions))
}
