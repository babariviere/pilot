import Foundation
import PilotCore
import SwiftUI

/// Immutable ownership for one native surface. Availability never changes its destination.
@MainActor
struct HostViewContext {
    let host: HostRef
    let hosts: HostClients

    func ref(_ kind: HostResourceKind, _ id: String) -> HostResourceRef {
        HostResourceRef(host: host, kind: kind, localId: id)
    }

    func perform<Value>(_ kind: HostResourceKind, _ id: String,
                        _ action: (PilotClient, String) async throws -> Value) async throws -> Value {
        try await hosts.perform(ref(kind, id), kind: kind, action)
    }

    var openURL: OpenURLAction {
        OpenURLAction { url in
            if url.scheme?.lowercased() == "artifact" {
                if let link = ArtifactLink(url: url) {
                    AppModel.shared.artifactLinkContext = self
                    AppModel.shared.artifactLink = link
                }
                return .handled
            }
            if BrowserLinkOpener.handles(url) { BrowserLinkOpener.shared.open(url); return .handled }
            return .systemAction
        }
    }

    var available: Bool { hosts.available.contains(host) }
    var name: String { host.hostId == "local" ? "Local" : hosts.offlineHosts[host]?.configuration.alias ?? host.hostId }
}

private struct HostViewContextKey: EnvironmentKey {
    static let defaultValue: HostViewContext? = nil
}

extension EnvironmentValues {
    var hostViewContext: HostViewContext? {
        get { self[HostViewContextKey.self] }
        set { self[HostViewContextKey.self] = newValue }
    }
}
