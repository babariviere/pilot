import Combine
import Foundation
import PilotCore

@MainActor
struct DevboxUpdateActions {
    var available: (HostRef) -> Bool
    var configuration: (HostRef) -> SSHConnectionConfiguration?
    var status: (String?, HostRef) async throws -> RuntimeUpdateStatus?
    var start: (SSHConnectionConfiguration, LinuxRuntimePackage, HostRef, UUID) async throws -> String
    var cancel: (String, HostRef) async throws -> RuntimeUpdateCancellation

    static func live(_ hosts: HostClients) -> Self {
        Self(available: { [weak hosts] in hosts?.available.contains($0) == true }, configuration: { [weak hosts] in hosts?.offlineHosts[$0]?.configuration },
             status: { [weak hosts] id, host in
                 guard let hosts else { throw HostRoutingError.disconnected }
                 return try await hosts.runtimeUpdate(id, on: host)
             },
             start: { try await LinuxSSHUpdate.start(configuration: $0, package: $1, host: $2, id: $3) },
             cancel: { [weak hosts] id, host in
                 guard let hosts else { throw HostRoutingError.disconnected }
                 return try await hosts.cancelRuntimeUpdate(id, on: host)
             })
    }
}

@MainActor
final class DevboxUpdateModel: ObservableObject {
    let host: HostRef
    @Published private(set) var status: RuntimeUpdateStatus?
    @Published private(set) var intent: DevboxUpdateIntent?
    @Published private(set) var problem: String?
    @Published private(set) var notice: String?
    @Published private(set) var busy = false { didSet { if oldValue && !busy { onIdle?() } } }
    var onIdle: (() -> Void)?
    @Published private(set) var checked = false
    @Published private(set) var cancellationRequested = false
    @Published private(set) var automaticPhase: DevboxAutomaticUpdatePhase?
    @Published private(set) var observedVersion: String?
    @Published private(set) var targetVersion: String?
    private let loadPackage: DevboxPackageLoader
    private let actions: DevboxUpdateActions
    private let store: DevboxUpdateIntentStore
    private var generation = UUID()

    init(host: HostRef, loadPackage: @escaping DevboxPackageLoader,
         actions: DevboxUpdateActions, store: DevboxUpdateIntentStore = .shared) {
        self.host = host; self.loadPackage = loadPackage; self.actions = actions; self.store = store
    }

    var available: Bool { actions.available(host) }
    var unresolved: Bool { status.map { !Self.conclusive($0.phase) } ?? (intent != nil && intent?.conclusive != true) }
    var mayRequest: Bool {
        checked && available && !busy && !unresolved && automaticPhase != .current &&
            automaticPhase != .newer && automaticPhase != .incompatible
    }
    /// A staged request may have crashed before installing its independent owner. Retrying the
    /// exact saved request starts that owner so it can settle the durable remote cancellation.
    var mayFinishCancellation: Bool {
        available && !busy && cancellationRequested && intent?.conclusive == false &&
            status?.phase == .staged && status?.requestConfirmed == false &&
            status?.id == intent?.id.uuidString.lowercased() &&
            problem != DevboxProblemText.update(DevboxProblem.storage)
    }
    var mayRetry: Bool {
        if cancellationRequested { return mayFinishCancellation }
        return available && !busy && intent != nil && intent?.conclusive != true &&
            (status == nil || status?.phase == .staged) && problem != DevboxProblemText.update(DevboxProblem.storage)
    }
    nonisolated static func conclusive(_ phase: RuntimeUpdatePhase) -> Bool { phase == .completed || phase == .cancelled }

    func automaticUnavailable() {
        automaticPhase = .incompatible
        notice = "The verified runtime version is unavailable. No update can be selected safely."
    }

    func checkAutomatically(_ runtime: VerifiedRemoteRuntime, targetVersion target: String?,
                            isCurrent: () -> Bool) async {
        guard isCurrent(), host.hostId != "local", runtime.token.host == host else { return }
        observedVersion = runtime.hello.daemonVersion; targetVersion = target
        automaticPhase = .checking
        guard let target, runtime.hello.platform == "linux", runtime.hello.arch == "x64",
              runtime.hello.capabilities.runtimeUpdates == 1,
              (try? host.validate(runtime.hello)) != nil,
              let comparison = DevboxRuntimeVersion.comparison(remote: runtime.hello.daemonVersion, target: target) else {
            automaticUnavailable(); return
        }
        if busy { automaticPhase = .tracking; return }
        busy = true; defer { busy = false }
        await readState()
        guard isCurrent() else { return }
        guard checked else { automaticPhase = .failed; return }
        // Lookup-only for every existing/ambiguous owner, including a different package.
        guard !unresolved else { automaticPhase = .tracking; return }
        if comparison == .orderedSame { automaticPhase = .current; return }
        if comparison == .orderedDescending { automaticPhase = .newer; return }
        if let status, status.phase == .completed {
            guard let installed = DevboxRuntimeVersion.comparison(remote: status.version, target: target) else {
                automaticUnavailable(); return
            }
            if installed != .orderedAscending {
                automaticPhase = .tracking
                notice = "The update journal reports this version or newer. Waiting for verified runtime evidence; no replacement update was created."
                return
            }
        }
        do {
            let suppressed = try await store.automaticSuppressed(host: host, version: target)
            guard isCurrent() else { return }
            if suppressed { automaticPhase = .cancelled; return }
        } catch { problem = DevboxProblemText.update(error); automaticPhase = .failed; return }
        await performRequest(automatic: true, expectedVersion: target, isCurrent: isCurrent)
        guard isCurrent() else { return }
        automaticPhase = problem == nil ? .requested : .failed
    }

    func refresh() async {
        guard !busy, available else { return }
        busy = true; defer { busy = false }
        await readState()
    }

    private func readState() async {
        let generation = self.generation
        do {
            let saved = try await store.current(host)
            let value = try await actions.status(saved?.conclusive == false ? saved?.id.uuidString.lowercased() : nil, host)
            guard self.generation == generation, available else { return }
            if let value, !value.requestConfirmed && value.phase != .staged { throw DevboxProblem.savedUpdate }
            guard value == nil || saved == nil || saved!.conclusive || value!.id == saved!.id.uuidString.lowercased() else { throw DevboxProblem.savedUpdate }
            intent = saved; status = value; checked = true; problem = nil
            if let value, value.phase == .cancelled, value.requestConfirmed {
                try await store.suppressAutomatic(host: host, version: value.version, updateId: value.id)
            }
            guard self.generation == generation, available else { return }
            if let saved, !saved.conclusive,
               try await store.automaticSuppressed(host: host, version: saved.version) { cancellationRequested = true }
            if let value, Self.conclusive(value.phase) { cancellationRequested = false }
            if let value, Self.conclusive(value.phase), let saved, value.id == saved.id.uuidString.lowercased() {
                try await store.markConclusive(host: host, id: saved.id)
                let updated = try await store.current(host)
                guard self.generation == generation, available else { return }
                intent = updated
                cancellationRequested = false
            }
            if value?.phase == .staged {
                notice = saved == nil ? "This package was staged elsewhere. Reconcile it from its original request; Pilot will not invent a replacement." : "The package is staged, but the request is not confirmed. Retry only this saved update."
            }
            else if value == nil, let saved, !saved.conclusive { notice = "This saved request has no confirmed result. Check or explicitly retry the same request; it is never sent automatically." }
            else { notice = nil }
        } catch { if self.generation == generation { problem = error as? DevboxProblem == .storage ? DevboxProblemText.update(error) : "Could not check this devbox's update. Existing state has been kept. Reconnect and check again."; checked = false } }
    }

    /// Both a first request and an explicit unconfirmed retry go through the same immutable-intent gate.
    func request() async {
        guard !busy, available else { return }
        busy = true; defer { busy = false }
        await performRequest(automatic: false, expectedVersion: nil, isCurrent: { true })
    }

    private func performRequest(automatic: Bool, expectedVersion: String?, isCurrent: () -> Bool) async {
        guard available, isCurrent() else { return }
        guard let configuration = actions.configuration(host) else {
            problem = DevboxProblemText.update(DevboxProblem.incompatibleRuntime); return
        }
        problem = nil; notice = nil
        let generation = self.generation
        let finishingCancellation = cancellationRequested
        var dispatched = false
        do {
            if automatic {
                guard let expectedVersion, let observedVersion,
                      DevboxRuntimeVersion.comparison(remote: observedVersion, target: expectedVersion) == .orderedAscending else {
                    throw DevboxProblem.incompatibleRuntime
                }
            }
            let previous = try await store.current(host)
            let current = try await actions.status(nil, host)
            guard self.generation == generation, available, isCurrent() else { return }
            status = current; checked = true
            if let current, !current.requestConfirmed && current.phase != .staged { throw DevboxProblem.savedUpdate }
            if automatic, previous?.conclusive == false { throw DevboxProblem.savedUpdate }
            if finishingCancellation {
                guard let previous, !previous.conclusive, let current,
                      current.id == previous.id.uuidString.lowercased(), current.phase == .staged,
                      !current.requestConfirmed else { throw DevboxProblem.savedUpdate }
            }
            if let current, !Self.conclusive(current.phase) {
                guard previous?.id.uuidString.lowercased() == current.id, current.phase == .staged else { throw DevboxProblem.savedUpdate }
            }
            let package = try await loadPackage()
            guard self.generation == generation, available, isCurrent() else { return }
            if let expectedVersion, package.manifest.version != expectedVersion { throw DevboxProblem.packageChanged }
            if automatic {
                // Package acquisition can outlast another app's update/cancel. Recheck before
                // allocating any new durable ID, never replacing an owner discovered meanwhile.
                let latest = try await actions.status(nil, host)
                guard self.generation == generation, available, isCurrent() else { return }
                status = latest
                if let latest {
                    guard Self.conclusive(latest.phase), latest.requestConfirmed else { throw DevboxProblem.savedUpdate }
                    guard DevboxRuntimeVersion.components(latest.version) != nil else { throw DevboxProblem.incompatibleRuntime }
                    if latest.phase == .cancelled, latest.version == expectedVersion {
                        try await store.suppressAutomatic(host: host, version: latest.version, updateId: latest.id)
                        throw DevboxProblem.cancelledTarget
                    }
                    if latest.phase == .completed,
                       let order = DevboxRuntimeVersion.comparison(remote: latest.version, target: package.manifest.version),
                       order != .orderedAscending { throw DevboxProblem.savedUpdate }
                }
            }
            let saved: DevboxUpdateIntent
            if finishingCancellation {
                // Do not call reserve here: even if local state changed, recovery must never mint
                // a replacement UUID or erase the existing remote cancellation request.
                guard let previous, !previous.conclusive,
                      previous.version == package.manifest.version,
                      previous.archive == package.manifest.archive.sha256 else { throw DevboxProblem.packageChanged }
                saved = previous
            } else {
                saved = try await store.reserve(host: host, version: package.manifest.version, archive: package.manifest.archive.sha256, automatic: automatic)
            }
            guard self.generation == generation, available, isCurrent() else { return }
            intent = saved
            if finishingCancellation {
                // Package download can take time. An owner may have started in the meantime;
                // never resubmit an accepted update merely because cancellation is pending.
                let latest = try await actions.status(saved.id.uuidString.lowercased(), host)
                guard self.generation == generation, available, isCurrent() else { return }
                status = latest
                guard let latest, latest.id == saved.id.uuidString.lowercased() else { throw DevboxProblem.savedUpdate }
                if Self.conclusive(latest.phase), latest.requestConfirmed {
                    try await store.markConclusive(host: host, id: saved.id)
                    intent = try await store.current(host)
                    cancellationRequested = false
                    notice = latest.phase == .cancelled ? "Update cancelled. The devbox confirmed it; no replacement update was created." : "The update completed before cancellation settled."
                    return
                }
                guard latest.phase == .staged, !latest.requestConfirmed else { throw DevboxProblem.savedUpdate }
            }
            // The store has completed atomic publication and fsync of UUID, pin and package hash.
            dispatched = true
            let id = try await actions.start(configuration, package, host, saved.id)
            guard id == saved.id.uuidString.lowercased() else { throw HostRoutingError.identityChanged }
            guard self.generation == generation, isCurrent() else { return }
            notice = finishingCancellation
                ? "Cancellation recovery requested for the same saved update. Waiting for the devbox to confirm cancellation; no replacement update was created."
                : "Update requested. It continues on the devbox through disconnection, sleep and app quit."
            checked = true
            if available {
                let value = try await actions.status(id, host)
                guard self.generation == generation, available, isCurrent() else { return }
                guard value == nil || value?.id == id else { throw DevboxProblem.savedUpdate }
                status = value
                if let value, value.requestConfirmed, Self.conclusive(value.phase) {
                    if value.phase == .cancelled {
                        try await store.suppressAutomatic(host: host, version: value.version, updateId: value.id)
                    }
                    guard self.generation == generation, available, isCurrent() else { return }
                    try await store.markConclusive(host: host, id: saved.id)
                    intent = try await store.current(host)
                    cancellationRequested = false
                    notice = value.phase == .cancelled ? "Update cancelled. The devbox confirmed it; no replacement update was created." : "Runtime update completed."
                }
            }
        } catch {
            guard self.generation == generation, isCurrent() else { return }
            if dispatched, error as? DevboxProblem == .storage {
                problem = "The request may continue remotely, but its local state could not be saved safely. Check this same update; no replacement request was sent."
            }
            else if !dispatched, error is DevboxPackageFailure || error is LinuxBootstrapFailure || error is LinuxRuntimeManifest.ValidationError { problem = DevboxProblemText.setup(error) }
            else { problem = DevboxProblemText.update(error) }
        }
    }

    func requestCancellation() async {
        guard !busy, available, let id = status?.id ?? intent?.id.uuidString.lowercased() else { return }
        busy = true; defer { busy = false }
        let generation = self.generation
        do {
            guard let version = status?.version ?? intent?.version else { throw DevboxProblem.savedUpdate }
            try await store.suppressAutomatic(host: host, version: version, updateId: id)
            guard self.generation == generation, available else { return }
            cancellationRequested = true
            let result = try await actions.cancel(id, host)
            guard self.generation == generation, available, result.id == id else { return }
            cancellationRequested = result.requested
            notice = result.requested ? "Cancellation requested. The devbox must confirm it before this update is cancelled." : "Cancellation was not accepted. Check the update; restart may already be committed."
        } catch {
            if self.generation == generation {
                problem = error as? DevboxProblem == .storage
                    ? "The cancellation preference could not be saved safely. No cancellation was sent. Repair local storage before retrying."
                    : "Cancellation has no confirmed reply. Reconnect and check this update; no cancellation is queued or replayed."
            }
        }
    }

    func disconnected() { generation = UUID(); checked = false }
}
