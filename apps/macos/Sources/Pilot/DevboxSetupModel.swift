import Combine
import Foundation
import PilotCore

@MainActor
struct DevboxSetupActions {
    var bootstrap: (SSHConnectionConfiguration, LinuxRuntimePackage, String, HostRef?) async throws -> LinuxBootstrapConnection
    var enroll: (HostRef, SSHConnectionConfiguration) async throws -> Void
    var adopt: (LinuxBootstrapConnection, SSHConnectionConfiguration) async throws -> Void
    var dispose: (LinuxBootstrapConnection) async -> Void

    @MainActor static func live(_ hosts: HostClients) -> Self {
        Self(bootstrap: { try await LinuxSSHBootstrap.install(configuration: $0, package: $1, hostId: $2, pinnedHost: $3) },
             enroll: { try await hosts.enroll($0, configuration: $1) },
             adopt: { try await hosts.adopt($0, configuration: $1) }, dispose: { await $0.tunnel.disconnect() })
    }
}

/// Owns only initial setup and its not-yet-adopted local forward. Does not create a project/chat.
@MainActor
final class DevboxSetupModel: ObservableObject {
    enum Phase: Equatable { case idle, preparing, awaitingTrust, saving, complete, failed }
    @Published private(set) var phase = Phase.idle
    @Published private(set) var problem: String?
    @Published private(set) var candidate: HostRef?
    @Published private(set) var completed: HostRef?
    private let loadPackage: DevboxPackageLoader
    private let actions: DevboxSetupActions
    private var configuration: SSHConnectionConfiguration?
    private var package: LinuxRuntimePackage?
    private var connection: LinuxBootstrapConnection?
    private var observedHost: HostRef?
    private var hostId = "devbox-" + UUID().uuidString.lowercased()
    private var generation = UUID()
    private var operation: Task<LinuxBootstrapConnection, Error>?

    init(loadPackage: @escaping DevboxPackageLoader, actions: DevboxSetupActions) {
        self.loadPackage = loadPackage; self.actions = actions
    }

    var busy: Bool { phase == .preparing || phase == .saving }

    func prepare(alias: String) async {
        guard !busy, connection == nil else { return }
        let config: SSHConnectionConfiguration
        do { config = try SSHConnectionConfiguration(alias: alias.trimmingCharacters(in: .whitespacesAndNewlines)) }
        catch { problem = DevboxProblemText.setup(DevboxProblem.invalidAlias); phase = .failed; return }
        if configuration != nil, configuration != config {
            problem = "Retry this setup with its original SSH alias, or close the form before adding a different devbox."; phase = .failed; return
        }
        configuration = config
        phase = .preparing; problem = nil
        let generation = self.generation, load = loadPackage, actions = actions, id = hostId, pin = observedHost
        let existingPackage = package
        let task = Task { [weak self] in
            let package: LinuxRuntimePackage
            if let existingPackage { package = existingPackage } else { package = try await load() }
            try Task.checkCancellation()
            guard let self, self.generation == generation else { throw CancellationError() }
            self.package = package
            return try await actions.bootstrap(config, package, id, pin)
        }
        operation = task
        do {
            let result = try await task.value
            guard self.generation == generation else { await actions.dispose(result); return }
            connection = result; candidate = result.host; observedHost = result.host; phase = .awaitingTrust
        } catch {
            guard self.generation == generation else { return }
            problem = DevboxProblemText.setup(error); phase = .failed
        }
        if self.generation == generation { operation = nil }
    }

    func confirmEnrollment() async {
        guard phase == .awaitingTrust, let connection, let configuration else { return }
        phase = .saving; problem = nil
        let generation = self.generation
        do {
            // Durable enrollment is a mandatory gate, not a side effect after adoption.
            try await actions.enroll(connection.host, configuration)
            guard self.generation == generation else { return }
            try await actions.adopt(connection, configuration)
            guard self.generation == generation else { return }
            self.connection = nil; candidate = nil; completed = connection.host; phase = .complete
        } catch {
            await actions.dispose(connection)
            guard self.generation == generation else { return }
            self.connection = nil; candidate = nil; phase = .failed
            problem = "The devbox could not be adopted. If it was saved, reconnect its pinned entry. No remote service was stopped."
        }
    }

    func cancel() async {
        generation = UUID()
        operation?.cancel(); operation = nil
        if let connection { self.connection = nil; await actions.dispose(connection) }
        candidate = nil; observedHost = nil; package = nil; configuration = nil
        phase = .idle; problem = nil
    }
}
