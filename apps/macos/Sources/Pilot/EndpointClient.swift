import Combine
import PilotCore
import SwiftUI

/// Existing native views use their immutable surface owner, not a process-wide selected backend.
/// The source forwards only that endpoint's changes and follows verified client replacement.
@propertyWrapper @MainActor
struct EndpointClient: @MainActor DynamicProperty {
    @Environment(\.hostViewContext) private var context
    @StateObject private var source = EndpointClientSource()
    private var explicit: PilotClient?

    init() { explicit = nil }
    init(wrappedValue: PilotClient) { explicit = wrappedValue }
    init(_ client: PilotClient?) { explicit = client }

    var wrappedValue: PilotClient {
        if let context { return context.hosts.presentationClient(context.host) }
        return explicit ?? AppModel.shared.client
    }

    mutating func update() { source.bind(wrappedValue, hosts: context?.hosts) }
}

@MainActor private final class EndpointClientSource: ObservableObject {
    private weak var client: PilotClient?
    private var observation: AnyCancellable?
    private weak var hosts: HostClients?
    private var hostsObservation: AnyCancellable?
    func bind(_ next: PilotClient, hosts nextHosts: HostClients?) {
        if hosts !== nextHosts {
            hosts = nextHosts
            hostsObservation = nextHosts?.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        }
        guard client !== next else { return }
        client = next
        observation = Publishers.Merge3(next.objectWillChange, next.mcp.objectWillChange, next.sourceSignIns.objectWillChange).sink { [weak self] _ in self?.objectWillChange.send() }
    }
}
