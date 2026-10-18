import Foundation
import PilotCore
import SwiftUI

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
        _model = StateObject(wrappedValue: hosts.devboxUpdates.model(for: host, packageLoader: loadPackage))
    }

    var body: some View {
        SettingsSection("Runtime updates", explanation: "Pilot automatically checks saved devboxes and requests the signed runtime matching this app when they are older. Restart waits for jobs, terminals, transfers and cleanup. Nothing is stopped silently.") {
            SettingsRow(DevboxUpdateCopy.title(model.status, automatic: model.automaticPhase),
                detail: hosts.available.contains(host) ? "Accepted work continues independently while an update waits." : "Disconnected. The last update state may be out of date.") {
                HStack(spacing: 8) {
                    if model.busy { ProgressView().controlSize(.small) }
                    if model.mayFinishCancellation {
                        Button("Finish cancelling…") { confirmUpdate = true }.controlSize(.small)
                    } else if model.mayRetry {
                        Button("Retry saved request…") { confirmUpdate = true }.controlSize(.small)
                    } else if !model.unresolved, model.mayRequest {
                        Button("Retry update…") { confirmUpdate = true }.controlSize(.small)
                    }
                    Button("Check status") { Task { await model.refresh() } }.controlSize(.small)
                        .disabled(model.busy || !hosts.available.contains(host))
                }
            }
            if let observed = model.observedVersion {
                SettingsRow("Verified runtime", detail: "Devbox \(observed) · app target \(model.targetVersion ?? "unknown")") { EmptyView() }
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
    static func title(_ status: RuntimeUpdateStatus?, automatic: DevboxAutomaticUpdatePhase?) -> String {
        if let status, !DevboxUpdateModel.conclusive(status.phase) {
            return status.requestConfirmed ? phase(status.phase) : "Package staged, request not confirmed"
        }
        return automatic?.title ?? status.map { phase($0.phase) } ?? "Check this devbox"
    }

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
