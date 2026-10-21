import Combine
import Foundation
import PilotCore

@MainActor final class LegacyCheckoutCatalog: ObservableObject {
    @Published private(set) var revision: UInt64 = 0
    @Published private(set) var error: String?
    private var state = RepositoryAssociations()
    private var projects: [Hosted<Project>] = []
    private var inventory: [HostResourceRef: Project] = [:]
    private var groupsByLocal: [HostRef?: [ProjectCheckoutGroup]] = [:]
    private let store: RepositoryAssociationStore
    private var started = false
    init(store: RepositoryAssociationStore) { self.store = store }
    func start() async {
        guard !started else { return }
        started = true
        do { state = try await store.load() }
        catch { self.error = "Could not read saved checkout identities. The saved file was kept." }
        groupsByLocal.removeAll()
        revision &+= 1
    }
    func update(_ values: [Hosted<Project>]) {
        let next = Dictionary(values.map { ($0.ref, $0.value) }, uniquingKeysWith: { first, _ in first })
        guard inventory != next else { return }
        projects = values; inventory = next; groupsByLocal.removeAll(); revision &+= 1
    }
    func groups(local: HostRef?) -> [ProjectCheckoutGroup] {
        if let cached = groupsByLocal[local] { return cached }
        let result = ProjectCheckouts.groups(projects, origins: state.origins, bindings: state.bindings, local: local)
        if groupsByLocal.count >= 2 { groupsByLocal.removeAll() }
        groupsByLocal[local] = result
        return result
    }
}
