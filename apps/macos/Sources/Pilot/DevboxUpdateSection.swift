import Combine
import PilotCore
import SwiftUI

@MainActor
struct DevboxUpdateActions {
    var available: (HostRef) -> Bool
    var configuration: (HostRef) -> SSHConnectionConfiguration?
    var status: (String?, HostRef) async throws -> RuntimeUpdateStatus?
    var start: (SSHConnectionConfiguration, LinuxRuntimePackage, HostRef, UUID) async throws -> String
    var cancel: (String, HostRef) async throws -> RuntimeUpdateCancellation

    static func live(_ hosts: HostClients) -> Self {
        Self(available: { hosts.available.contains($0) }, configuration: { hosts.offlineHosts[$0]?.configuration },
             status: { try await hosts.runtimeUpdate($0, on: $1) },
             start: { try await LinuxSSHUpdate.start(configuration: $0, package: $1, host: $2, id: $3) },
             cancel: { try await hosts.cancelRuntimeUpdate($0, on: $1) })
    }
}

@MainActor
final class DevboxUpdateModel: ObservableObject {
    let host: HostRef
    @Published private(set) var status: RuntimeUpdateStatus?
    @Published private(set) var intent: DevboxUpdateIntent?
    @Published private(set) var problem: String?
    @Published private(set) var notice: String?
    @Published private(set) var busy = false
    @Published private(set) var checked = false
    @Published private(set) var cancellationRequested = false
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
    var mayRequest: Bool { checked && available && !busy && !unresolved }
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
    static func conclusive(_ phase: RuntimeUpdatePhase) -> Bool { phase == .completed || phase == .cancelled }

    func refresh() async {
        guard !busy, available else { return }
        busy = true; defer { busy = false }
        let generation = self.generation
        do {
            let saved = try await store.current(host)
            let value = try await actions.status(saved?.conclusive == false ? saved?.id.uuidString.lowercased() : nil, host)
            guard self.generation == generation, available else { return }
            if let value, !value.requestConfirmed && value.phase != .staged { throw DevboxProblem.savedUpdate }
            guard value == nil || saved == nil || saved!.conclusive || value!.id == saved!.id.uuidString.lowercased() else { throw DevboxProblem.savedUpdate }
            intent = saved; status = value; checked = true; problem = nil
            if let value, Self.conclusive(value.phase) { cancellationRequested = false }
            if let value, Self.conclusive(value.phase), let saved, value.id == saved.id.uuidString.lowercased() {
                try await store.markConclusive(host: host, id: saved.id)
                intent = try await store.current(host)
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
        guard !busy, available, let configuration = actions.configuration(host) else { return }
        busy = true; problem = nil; notice = nil; defer { busy = false }
        let generation = self.generation
        let finishingCancellation = cancellationRequested
        var dispatched = false
        do {
            let previous = try await store.current(host)
            let current = try await actions.status(nil, host)
            guard self.generation == generation, available else { return }
            status = current; checked = true
            if finishingCancellation {
                guard let previous, !previous.conclusive, let current,
                      current.id == previous.id.uuidString.lowercased(), current.phase == .staged,
                      !current.requestConfirmed else { throw DevboxProblem.savedUpdate }
            }
            if let current, !Self.conclusive(current.phase) {
                guard previous?.id.uuidString.lowercased() == current.id, current.phase == .staged else { throw DevboxProblem.savedUpdate }
            }
            let package = try await loadPackage()
            guard self.generation == generation, available else { return }
            let saved: DevboxUpdateIntent
            if finishingCancellation {
                // Do not call reserve here: even if local state changed, recovery must never mint
                // a replacement UUID or erase the existing remote cancellation request.
                guard let previous, !previous.conclusive,
                      previous.version == package.manifest.version,
                      previous.archive == package.manifest.archive.sha256 else { throw DevboxProblem.packageChanged }
                saved = previous
            } else {
                saved = try await store.reserve(host: host, version: package.manifest.version, archive: package.manifest.archive.sha256)
            }
            guard self.generation == generation, available else { return }
            intent = saved
            if finishingCancellation {
                // Package download can take time. An owner may have started in the meantime;
                // never resubmit an accepted update merely because cancellation is pending.
                let latest = try await actions.status(saved.id.uuidString.lowercased(), host)
                guard self.generation == generation, available else { return }
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
            guard self.generation == generation else { return }
            notice = finishingCancellation
                ? "Cancellation recovery requested for the same saved update. Waiting for the devbox to confirm cancellation; no replacement update was created."
                : "Update requested. It continues on the devbox through disconnection, sleep and app quit."
            checked = true
            if available {
                let value = try await actions.status(id, host)
                guard self.generation == generation, available else { return }
                guard value == nil || value?.id == id else { throw DevboxProblem.savedUpdate }
                status = value
                if let value, value.requestConfirmed, Self.conclusive(value.phase) {
                    try await store.markConclusive(host: host, id: saved.id)
                    intent = try await store.current(host)
                    cancellationRequested = false
                    notice = value.phase == .cancelled ? "Update cancelled. The devbox confirmed it; no replacement update was created." : "Runtime update completed."
                }
            }
        } catch {
            guard self.generation == generation else { return }
            if !dispatched, error is DevboxPackageFailure || error is LinuxBootstrapFailure { problem = DevboxProblemText.setup(error) }
            else { problem = DevboxProblemText.update(error) }
        }
    }

    func requestCancellation() async {
        guard !busy, available, let id = status?.id ?? intent?.id.uuidString.lowercased() else { return }
        busy = true; defer { busy = false }
        let generation = self.generation
        do {
            let result = try await actions.cancel(id, host)
            guard self.generation == generation, available, result.id == id else { return }
            cancellationRequested = result.requested
            notice = result.requested ? "Cancellation requested. The devbox must confirm it before this update is cancelled." : "Cancellation was not accepted. Check the update; restart may already be committed."
        } catch { if self.generation == generation { problem = "Cancellation has no confirmed reply. Reconnect and check this update; no cancellation is queued or replayed." } }
    }

    func disconnected() { generation = UUID(); checked = false }
}

@MainActor
struct DevboxUpdateSection: View {
    let host: HostRef
    @ObservedObject var hosts: HostClients
    let navigate: (HostResourceRef) -> Void
    @StateObject private var model: DevboxUpdateModel
    @State private var confirmUpdate = false
    @State private var showAllBlockers = false

    init(host: HostRef, hosts: HostClients, loadPackage: @escaping DevboxPackageLoader,
         navigate: @escaping (HostResourceRef) -> Void = { _ in }) {
        self.host = host; self.hosts = hosts; self.navigate = navigate
        _model = StateObject(wrappedValue: DevboxUpdateModel(host: host, loadPackage: loadPackage, actions: .live(hosts)))
    }

    var body: some View {
        SettingsSection("Runtime updates", explanation: "Updates use a verified runtime matching this app. The devbox waits for jobs, terminals and transfers to finish. Nothing is stopped silently.") {
            SettingsRow(model.status.map { $0.requestConfirmed ? DevboxUpdateCopy.phase($0.phase) : "Package staged, request not confirmed" } ?? "Update this devbox",
                detail: hosts.available.contains(host) ? "Accepted work continues independently while an update waits." : "Disconnected. The last update state may be out of date.") {
                HStack(spacing: 8) {
                    if model.busy { ProgressView().controlSize(.small) }
                    if model.mayFinishCancellation {
                        Button("Finish cancelling…") { confirmUpdate = true }.controlSize(.small)
                    } else if model.mayRetry {
                        Button("Retry saved request…") { confirmUpdate = true }.controlSize(.small)
                    } else if !model.unresolved {
                        Button("Update…") { confirmUpdate = true }.controlSize(.small).disabled(!model.mayRequest)
                    }
                    Button("Check status") { Task { await model.refresh() } }.controlSize(.small)
                        .disabled(model.busy || !hosts.available.contains(host))
                }
            }
            if let value = model.status {
                let blockers = showAllBlockers ? value.blockers : Array(value.blockers.prefix(5))
                ForEach(Array(blockers.enumerated()), id: \.offset) { _, blocker in
                    SettingsRow(DevboxUpdateCopy.blocker(blocker), detail: "Finish this work or stop/close it explicitly. Actual cleanup must finish before restart.") {
                        if let id = blocker.sessionId {
                            Button("Open chat") { navigate(HostResourceRef(host: host, kind: .session, localId: id)) }
                                .controlSize(.small).disabled(!hosts.available.contains(host))
                        }
                    }
                }
                if value.blockers.count > 5 {
                    SettingsRow { Button(showAllBlockers ? "Show fewer blockers" : "Show all \(value.blockers.count) blockers") { showAllBlockers.toggle() }.buttonStyle(.link) }
                }
                if !DevboxUpdateModel.conclusive(value.phase) {
                    SettingsRow("Keep the current runtime", detail: "Request cancellation without stopping chats or terminals.") {
                        Button(model.cancellationRequested ? "Cancellation requested" : "Request cancellation") { Task { await model.requestCancellation() } }
                            .controlSize(.small).disabled(model.busy || model.cancellationRequested || !hosts.available.contains(host))
                    }
                }
            }
            if let notice = model.notice { SettingsRow { SettingsNote(notice) } }
            if let problem = model.problem { SettingsRow { InlineProblem(problem) } }
        }
        .task(id: hosts.available.contains(host)) {
            if hosts.available.contains(host) { await model.refresh() } else { model.disconnected() }
        }
        .sheet(isPresented: $confirmUpdate) {
            SheetScaffold(model.cancellationRequested ? "Finish cancelling update" : model.intent?.conclusive == false ? "Retry saved update" : "Update devbox",
                subtitle: hosts.offlineHosts[host]?.configuration.alias ?? "Devbox",
                primary: SheetPrimaryAction(title: model.cancellationRequested ? "Confirm cancellation" : model.intent?.conclusive == false ? "Retry same request" : "Request update",
                    enabled: model.mayFinishCancellation || model.mayRetry || model.mayRequest, action: {
                        confirmUpdate = false; Task { await model.request() }
                    })) {
                if model.cancellationRequested {
                    SettingsNote("Retry only the original saved request and verified package so its independent owner can finish cancellation. The retained cancellation is not cleared, and no new update ID is created.")
                    SettingsNote("Pilot will check that the request is still unconfirmed and staged before dispatch. Cancellation is complete only when the devbox reports it.")
                } else {
                    SettingsNote("Pilot will stage the signed compatible runtime and save a host-pinned request first. The remote owner waits for live work to finish and will not silently kill jobs or terminals.")
                    SettingsNote("If delivery is interrupted, check this same request. Closing Pilot does not cancel an accepted update.")
                }
            }
        }
    }
}

enum DevboxUpdateCopy {
    static func phase(_ phase: RuntimeUpdatePhase) -> String {
        switch phase {
        case .staged: "Package staged, request not confirmed"
        case .requested: "Update requested"
        case .waiting: "Waiting for work to finish"
        case .draining: "Waiting for safe checkpoints"
        case .ready: "Ready to restart"
        case .stopping, .switching: "Updating the runtime"
        case .validating: "Checking the new runtime"
        case .completed: "Runtime updated"
        case .cancelled: "Update cancelled"
        case .needsRepair: "Runtime needs repair"
        }
    }
    static func blocker(_ blocker: RuntimeUpdateStatus.Blocker) -> String {
        switch blocker.kind {
        case "terminal", "workspace-terminal": "Workspace terminal is still open"
        case "setup": "Provider setup is still running"
        case "job", "child", "worker": "A job or agent process is still running"
        case "transfer", "attachment", "artifact-download", "file-download": "A transfer is still settling"
        default: "Live work or cleanup is still pending"
        }
    }
}
