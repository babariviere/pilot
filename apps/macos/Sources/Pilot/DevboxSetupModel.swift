import Combine
import Foundation
import PilotCore

@MainActor
struct DevboxSetupActions {
    var bootstrap: (SSHConnectionConfiguration, LinuxRuntimePackage, String, HostRef?,
                    @escaping @Sendable (DevboxSetupDiagnosticStage) async -> Void) async throws -> LinuxBootstrapConnection
    var enroll: (HostRef, SSHConnectionConfiguration) async throws -> Void
    var adopt: (LinuxBootstrapConnection, SSHConnectionConfiguration) async throws -> Void
    var dispose: (LinuxBootstrapConnection) async -> Void
    var record: (String, Int, DevboxSetupDiagnosticStage, DevboxSetupDiagnosticOutcome,
                 DevboxSetupDiagnosticReason?) async -> Void = { attempt, sequence, stage, outcome, reason in
        await NativeDiagnostics.shared.recordSetup(attemptRef: attempt, sequence: sequence, stage: stage,
                                                   outcome: outcome, reason: reason)
    }

    @MainActor static func live(_ hosts: HostClients) -> Self {
        Self(bootstrap: { try await LinuxSSHBootstrap.install(configuration: $0, package: $1, hostId: $2,
                                                              pinnedHost: $3, progress: $4) },
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
    private var diagnosticAttempt: String?
    private var diagnosticStage: DevboxSetupDiagnosticStage?
    private var diagnosticSequence = 0

    init(loadPackage: @escaping DevboxPackageLoader, actions: DevboxSetupActions) {
        self.loadPackage = loadPackage; self.actions = actions
    }

    var busy: Bool { phase == .preparing || phase == .saving }

    func prepare(alias: String) async {
        guard !busy, connection == nil else { return }
        diagnosticAttempt = NativeDiagnostics.setupAttemptReference()
        diagnosticStage = nil
        diagnosticSequence = 0
        await advanceDiagnostic(to: .configuration)
        let config: SSHConnectionConfiguration
        do { config = try SSHConnectionConfiguration(alias: alias.trimmingCharacters(in: .whitespacesAndNewlines)) }
        catch {
            await failDiagnostic(.invalidConfiguration)
            problem = DevboxProblemText.setup(DevboxProblem.invalidAlias); phase = .failed; return
        }
        if configuration != nil, configuration != config {
            await failDiagnostic(.invalidConfiguration)
            problem = "Retry this setup with its original SSH alias, or close the form before adding a different devbox."; phase = .failed; return
        }
        configuration = config
        phase = .preparing; problem = nil
        await advanceDiagnostic(to: .package)
        let generation = self.generation, load = loadPackage, actions = actions, id = hostId, pin = observedHost
        let existingPackage = package
        let task = Task { [weak self] in
            let package: LinuxRuntimePackage
            if let existingPackage { package = existingPackage } else { package = try await load() }
            try Task.checkCancellation()
            guard let self, self.generation == generation else { throw CancellationError() }
            self.package = package
            return try await actions.bootstrap(config, package, id, pin) { [weak self] stage in
                await self?.observeDiagnostic(stage, generation: generation)
            }
        }
        operation = task
        do {
            let result = try await task.value
            guard self.generation == generation else { await actions.dispose(result); return }
            await succeedDiagnostic()
            connection = result; candidate = result.host; observedHost = result.host; phase = .awaitingTrust
        } catch {
            guard self.generation == generation else { return }
            if error is CancellationError {
                await finishDiagnostic(outcome: .cancelled, reason: .cancelled)
            } else {
                await failDiagnostic(Self.diagnosticReason(error))
            }
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
            await advanceDiagnostic(to: .enrollment)
            try await actions.enroll(connection.host, configuration)
            guard self.generation == generation else { return }
            await advanceDiagnostic(to: .adoption)
            try await actions.adopt(connection, configuration)
            guard self.generation == generation else { return }
            await succeedDiagnostic()
            diagnosticAttempt = nil
            self.connection = nil; candidate = nil; completed = connection.host; phase = .complete
        } catch {
            await actions.dispose(connection)
            guard self.generation == generation else { return }
            let reason: DevboxSetupDiagnosticReason = diagnosticStage == .enrollment ? .enrollmentFailed : .adoptionFailed
            await failDiagnostic(reason)
            self.connection = nil; candidate = nil; phase = .failed
            problem = "The devbox could not be adopted. If it was saved, reconnect its pinned entry. No remote service was stopped."
        }
    }

    func cancel() async {
        if diagnosticAttempt != nil {
            if diagnosticStage == nil, phase == .awaitingTrust { await advanceDiagnostic(to: .enrollment) }
            await finishDiagnostic(outcome: .cancelled, reason: .cancelled)
        }
        generation = UUID()
        operation?.cancel(); operation = nil
        if let connection { self.connection = nil; await actions.dispose(connection) }
        candidate = nil; observedHost = nil; package = nil; configuration = nil
        phase = .idle; problem = nil
    }

    private func advanceDiagnostic(to stage: DevboxSetupDiagnosticStage) async {
        guard let attempt = diagnosticAttempt, diagnosticStage != stage else { return }
        if let previous = diagnosticStage { await recordDiagnostic(attempt, previous, .succeeded, nil) }
        diagnosticStage = stage
        await recordDiagnostic(attempt, stage, .started, nil)
    }

    private func observeDiagnostic(_ stage: DevboxSetupDiagnosticStage, generation: UUID) async {
        guard self.generation == generation else { return }
        await advanceDiagnostic(to: stage)
    }

    private func succeedDiagnostic() async { await finishDiagnostic(outcome: .succeeded, reason: nil) }
    private func failDiagnostic(_ reason: DevboxSetupDiagnosticReason) async {
        await finishDiagnostic(outcome: .failed, reason: reason)
    }

    private func finishDiagnostic(outcome: DevboxSetupDiagnosticOutcome,
                                  reason: DevboxSetupDiagnosticReason?) async {
        guard let attempt = diagnosticAttempt, let stage = diagnosticStage else { return }
        await recordDiagnostic(attempt, stage, outcome, reason)
        diagnosticStage = nil
    }

    private func recordDiagnostic(_ attempt: String, _ stage: DevboxSetupDiagnosticStage,
                                  _ outcome: DevboxSetupDiagnosticOutcome,
                                  _ reason: DevboxSetupDiagnosticReason?) async {
        guard diagnosticSequence <= 31 else { return }
        let sequence = diagnosticSequence
        diagnosticSequence += 1
        await actions.record(attempt, sequence, stage, outcome, reason)
    }

    private static func diagnosticReason(_ error: Error) -> DevboxSetupDiagnosticReason {
        if error is CancellationError { return .cancelled }
        if let package = error as? DevboxPackageFailure {
            switch package {
            case .trust: return .packageUntrusted
            case .assets, .access: return .packageUnavailable
            }
        }
        if let validation = error as? LinuxRuntimeManifest.ValidationError {
            switch validation {
            case .incompatible: return .incompatible
            case .signature, .archive: return .packageUntrusted
            }
        }
        if let failure = error as? LinuxBootstrapFailure {
            switch failure.code {
            case "ssh_timeout": return .sshTimeout
            case "ssh_launch": return .sshLaunchFailed
            case "ssh": return .sshTransportUnknown
            case "python", "abi", "prerequisites", "persistence": return .remotePrerequisite
            case "sandbox": return .sandboxUnavailable
            case "identity": return .remoteIdentity
            case "configuration": return .invalidConfiguration
            default: return .remoteSetup
            }
        }
        if let routing = error as? HostRoutingError {
            if routing == .identityChanged { return .identityChanged }
            if routing == .incompatible { return .incompatible }
        }
        if let tunnel = error as? SSHTunnelError {
            switch tunnel {
            case .timedOut: return .sshTimeout
            case .rejectedHello: return .handshakeRejected
            case .launchFailed: return .sshLaunchFailed
            default: return .sshTransportUnknown
            }
        }
        return .unknown
    }
}
