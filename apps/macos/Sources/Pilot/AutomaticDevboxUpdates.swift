import Combine
import Foundation
import PilotCore

/// Dependency injection for disposable lifecycle fixtures, not host policy or a second update protocol.
@MainActor struct DevboxAutomaticUpdateConfiguration {
    var targetVersion: () -> String? = { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String }
    var loadPackage: DevboxPackageLoader = { try await DevboxRuntimePackage.load() }
    var actions: DevboxUpdateActions?
    var store: DevboxUpdateIntentStore?
}

enum DevboxAutomaticUpdatePhase: String, Equatable {
    case checking, current, newer, incompatible, tracking, requested, cancelled, failed
    var title: String {
        switch self {
        case .checking: "Checking compatible runtime"
        case .current: "Up to date"
        case .newer: "Devbox runtime is newer"
        case .incompatible: "Runtime compatibility is unknown"
        case .tracking: "Checking the existing update"
        case .requested: "Automatic update requested"
        case .cancelled: "Automatic update cancelled for this version"
        case .failed: "Automatic update needs attention"
        }
    }
}

enum DevboxRuntimeVersion {
    /// Stable installed versions only. Unknown/prerelease/overflow values never imply older.
    static func components(_ value: String) -> [UInt64]? {
        guard value.utf8.count <= 64, value.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil else { return nil }
        let parts = value.split(separator: ".")
        guard parts.allSatisfy({ $0 == "0" || $0.first != "0" }) else { return nil }
        let values = parts.compactMap { UInt64($0) }
        return values.count == 3 ? values : nil
    }

    static func comparison(remote: String, target: String) -> ComparisonResult? {
        guard let a = components(remote), let b = components(target) else { return nil }
        for index in a.indices where a[index] != b[index] { return a[index] < b[index] ? .orderedAscending : .orderedDescending }
        return .orderedSame
    }
}

/// Shares the existing update models/store with Settings. Consumes verified hello evidence only;
/// never connects, reads hello, elects an authority, stops work or changes the remote restart policy.
@MainActor final class AutomaticDevboxUpdates: ObservableObject {
    private struct Attempt: Equatable {
        let token: HostConnectionToken
        let target: String?
    }
    private let runtimes: VerifiedRemoteRuntimes
    private let targetVersion: () -> String?
    private let loadPackage: DevboxPackageLoader
    private let actions: DevboxUpdateActions
    private let store: DevboxUpdateIntentStore
    private let validate: (HostConnectionToken) -> Bool
    private var observation: AnyCancellable?
    private var models: [HostRef: DevboxUpdateModel] = [:]
    private var attempted: [HostRef: Attempt] = [:]
    private var pending: [HostRef: VerifiedRemoteRuntime] = [:]
    private var running: [HostRef: (UUID, Task<Void, Never>)] = [:]
    private var latest: [HostRef: VerifiedRemoteRuntime] = [:]
    private var savedHosts: Set<HostRef>?
    private var started = false
    private var stopped = false
    var isIdle: Bool { pending.isEmpty && running.isEmpty }

    init(runtimes: VerifiedRemoteRuntimes, targetVersion: @escaping () -> String?,
         loadPackage: @escaping DevboxPackageLoader, actions: DevboxUpdateActions,
         store: DevboxUpdateIntentStore, validate: @escaping (HostConnectionToken) -> Bool) {
        self.runtimes = runtimes; self.targetVersion = targetVersion; self.loadPackage = loadPackage
        self.actions = actions; self.store = store; self.validate = validate
    }

    func model(for host: HostRef, packageLoader: DevboxPackageLoader? = nil) -> DevboxUpdateModel {
        if let model = models[host] { return model }
        let model = DevboxUpdateModel(host: host, loadPackage: packageLoader ?? loadPackage, actions: actions, store: store)
        model.onIdle = { [weak self] in self?.prune(); self?.pump() }
        models[host] = model
        return model
    }

    func start() {
        guard !started, !stopped else { return }
        started = true
        observation = Publishers.CombineLatest(runtimes.$observations, runtimes.$failures).sink { [weak self] values, failures in
            self?.update(values, failures: failures)
        }
    }

    /// Called by live connection/installed-target changes, never a polling timer.
    func targetChanged() {
        guard started, !stopped else { return }
        update(runtimes.observations, failures: runtimes.failures)
    }

    func retainSavedHosts(_ hosts: Set<HostRef>) {
        guard hosts.count <= 32 else { stop(); return }
        savedHosts = hosts
        prune()
    }

    private func prune() {
        guard let savedHosts else { return }
        let keep = savedHosts.union(latest.keys).union(running.keys)
        for host in models.keys where !keep.contains(host) && models[host]?.busy != true {
            models[host]?.onIdle = nil; models[host] = nil; attempted[host] = nil
        }
    }

    private func update(_ values: [HostRef: VerifiedRemoteRuntime], failures: Set<HostRef>) {
        guard started, !stopped else { return }
        for host in latest.keys where values[host]?.token != latest[host]?.token {
            running[host]?.1.cancel()
            models[host]?.disconnected()
            pending[host] = nil
        }
        latest = values
        for host in failures { model(for: host).automaticUnavailable() }
        let target = targetVersion()
        for (host, runtime) in values {
            let key = Attempt(token: runtime.token, target: target)
            if attempted[host] != key { pending[host] = runtime }
        }
        pump()
    }

    private func pump() {
        guard !stopped else { return }
        while running.count < 2, let host = pending.keys.sorted(by: { $0.hostId < $1.hostId }).first(where: { running[$0] == nil && models[$0]?.busy != true }) {
            guard let runtime = pending.removeValue(forKey: host) else { continue }
            let target = targetVersion(), key = Attempt(token: runtime.token, target: target)
            guard attempted[host] != key else { continue }
            let id = UUID(), model = model(for: host)
            let task = Task { [weak self] in
                guard let self else { return }
                if model.busy {
                    if !self.stopped, self.latest[host]?.token == runtime.token, self.targetVersion() == target {
                        self.pending[host] = runtime
                    }
                } else {
                    self.attempted[host] = key
                    await model.checkAutomatically(runtime, targetVersion: target) { [weak self] in
                        guard let self else { return false }
                        return !self.stopped && !Task.isCancelled && self.latest[host]?.token == runtime.token
                            && self.targetVersion() == target && self.validate(runtime.token)
                    }
                }
                if self.running[host]?.0 == id { self.running[host] = nil }
                self.prune()
                self.pump()
            }
            running[host] = (id, task)
        }
    }

    func stop() {
        stopped = true; observation = nil; pending.removeAll(); latest.removeAll()
        for item in running.values { item.1.cancel() }
        for model in models.values { model.disconnected() }
    }

    func stopAndWait() async {
        stop()
        for item in Array(running.values) { await item.1.value }
    }
}
