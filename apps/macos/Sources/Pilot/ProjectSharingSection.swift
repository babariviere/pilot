import PilotCore
import SwiftUI

/// Embedded in the existing project settings. Choosing equal names never enrolls a project.
struct ProjectSharingSection: View {
    let project: HostResourceRef
    @ObservedObject var hosts: HostClients
    @State private var bindings: [SharedContextSummary] = []
    @State private var showingLink = false
    @State private var resuming: SharedContextBinding?
    @State private var error: String?

    var body: some View {
        SettingsSection("Sharing", explanation: "Choose which project notes and missions to share. Each computer keeps its own project files, sign-ins and access approvals.") {
            if let error { SettingsRow { InlineProblem(error) { Task { await load() } } } }
            ForEach(bindings, id: \.binding.bindingId) { summary in
                let context = SharedProjectContext(binding: summary.binding, readingHost: project.host, hosts: hosts)
                SettingsRow("Shared information", detail: "Notes saved on \(context.name(summary.binding.memoryHome.host)) · Missions saved on \(context.name(summary.binding.missionHome)) · Work runs on \(context.name(summary.binding.executionProject.host))") {
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(summary.freshness.conflictCount > 0 ? SharedSaveState.conflict.rawValue
                             : summary.freshness.pendingCount > 0 || !summary.freshness.complete ? SharedSaveState.pending.rawValue : SharedSaveState.saved.rawValue)
                            .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        Button("Finish linking…") { resuming = summary.binding; showingLink = true }
                    }
                }
            }
            SettingsRow("Linked projects", detail: bindings.isEmpty ? "Nothing shared yet." : "Only the confirmed memory and missions are shared.") {
                Button("Link project…") { resuming = nil; showingLink = true }.disabled(project.kind != .project)
            }
        }
        .task(id: [project.storageKey, String(hosts.sharedRevision), String(hosts.available.contains(project.host))]) {
            if !bindings.isEmpty { try? await Task.sleep(for: .milliseconds(200)) }
            guard !Task.isCancelled else { return }
            await load()
        }
        .sheet(isPresented: $showingLink, onDismiss: { Task { await load() } }) {
            SharedProjectLinkSheet(project: project, hosts: hosts, existingBinding: resuming)
        }
    }

    private func load() async {
        do {
            let values = try await hosts.sharedContexts(on: project.host)
            guard !Task.isCancelled else { return }
            bindings = values.filter {
                $0.binding.state == .active &&
                (($0.binding.executionProject.host.matches(project.host) && $0.binding.executionProject.projectId == project.localId)
                 || ($0.binding.memoryHome.host.matches(project.host) && $0.binding.memoryHome.projectId == project.localId))
            }
            error = nil
        } catch { self.error = "Sharing is unavailable. Reconnect to this devbox." }
    }
}

private struct SharedProjectLinkSheet: View {
    let project: HostResourceRef
    @ObservedObject var hosts: HostClients
    @Environment(\.dismiss) private var dismiss
    @StateObject private var enrollment: SharedEnrollmentModel
    @State private var memoryProject: HostResourceRef?
    @State private var missionHost: HostRef?
    @State private var missionIds = Set<String>()
    @State private var shareMemory = true
    @State private var confirmed = false
    let existingBinding: SharedContextBinding?

    init(project: HostResourceRef, hosts: HostClients, existingBinding: SharedContextBinding? = nil) {
        self.project = project; self.hosts = hosts
        self.existingBinding = existingBinding
        _enrollment = StateObject(wrappedValue: SharedEnrollmentModel(service: SharedEnrollmentClient(hosts: hosts)))
        if let binding = existingBinding {
            _memoryProject = State(initialValue: hosts.projects.first {
                binding.memoryHome.host.matches($0.ref.host) && binding.memoryHome.projectId == $0.ref.localId
            }?.ref)
            _missionHost = State(initialValue: Set(hosts.projects.map { $0.ref.host }).first { binding.missionHome.matches($0) })
            _missionIds = State(initialValue: Set(binding.missionIds))
            _shareMemory = State(initialValue: binding.shareMemory)
        }
    }

    private var availableHosts: [HostRef] {
        Array(Set(hosts.projects.map { $0.ref.host }).union(hosts.available).union(hosts.offlineHosts.keys))
            .sorted { $0.hostId < $1.hostId }
    }
    private func name(_ host: HostRef) -> String { HostViewContext(host: host, hosts: hosts).name }
    private var executionDescription: String {
        if let binding = enrollment.binding ?? existingBinding {
            let context = SharedProjectContext(binding: binding, readingHost: project.host, hosts: hosts)
            let title = hosts.projects.first {
                binding.executionProject.host.matches($0.ref.host) && $0.ref.localId == binding.executionProject.projectId
            }?.value.name ?? binding.executionProject.projectId
            return "\(title) · \(context.name(binding.executionProject.host))"
        }
        return "\(hosts.projects.first(where: { $0.ref == project })?.value.name ?? project.localId) · \(name(project.host))"
    }
    private var canConfirm: Bool {
        !enrollment.busy && confirmed && memoryProject != nil && missionHost != nil && missionIds.count <= 128
            && (shareMemory || !missionIds.isEmpty)
    }
    private var participants: [HostRef] {
        if let binding = enrollment.binding ?? existingBinding {
            let context = SharedProjectContext(binding: binding, readingHost: project.host, hosts: hosts)
            let peers = binding.peers.compactMap { try? context.host(for: $0) }.filter { $0 != project.host }
            return [project.host] + peers.sorted { $0.hostId < $1.hostId }
        }
        guard let memoryProject, let missionHost else { return [] }
        // Persist this page's enrollment first, so closing a partially completed link
        // still leaves its exact scope discoverable here after reopening.
        let peers = Set([memoryProject.host, missionHost]).filter { $0 != project.host }
        return [project.host] + peers.sorted { $0.hostId < $1.hostId }
    }

    var body: some View {
        SheetScaffold("Share project information", subtitle: "The selected computer owns its work. Sharing does not move it.", error: enrollment.error,
                      primary: SheetPrimaryAction(title: enrollment.busy ? "Linking…" : enrollment.binding == nil ? "Link projects" : "Finish linking",
                                                  enabled: canConfirm, action: link), width: 560) {
            VStack(alignment: .leading, spacing: 12) {
                SettingsRow("Work stays on", detail: executionDescription) { EmptyView() }
                Picker("Save notes on", selection: $memoryProject) {
                    Text("Choose a project").tag(nil as HostResourceRef?)
                    ForEach(hosts.projects) { item in
                        Text("\(item.value.name) · \(name(item.ref.host))").tag(Optional(item.ref))
                    }
                }
                Toggle("Share project notes", isOn: $shareMemory)
                Picker("Save missions on", selection: $missionHost) {
                    Text("Choose a devbox").tag(nil as HostRef?)
                    ForEach(availableHosts, id: \.self) { host in Text(name(host)).tag(Optional(host)) }
                }
                .onChange(of: missionHost) { _, _ in missionIds.removeAll(); confirmed = false }
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(hosts.missions.filter { $0.ref.host == missionHost }) { item in
                            Toggle(item.value.title, isOn: Binding(get: { missionIds.contains(item.ref.localId) }, set: { selected in
                                if selected { missionIds.insert(item.ref.localId) } else { missionIds.remove(item.ref.localId) }
                                confirmed = false
                            }))
                            .lineLimit(1)
                        }
                        if !hosts.missions.contains(where: { $0.ref.host == missionHost }) {
                            Text("No missions selected. Notes can be shared on their own.").foregroundStyle(Theme.mutedForeground)
                        }
                    }
                }.frame(maxHeight: 160)
                Text("\(missionIds.count) missions selected").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                Text("Only the selected notes and missions are shared. Project files, sign-ins, settings and access approvals are not copied.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
            .font(.pilot(.body)).foregroundStyle(Theme.foreground)
            .disabled(enrollment.binding != nil || existingBinding != nil)
            Toggle("I confirm these projects, devboxes and sharing scope", isOn: $confirmed)
                .font(.pilot(.body)).foregroundStyle(Theme.foreground)
            if enrollment.binding != nil, !enrollment.complete {
                Text("\(enrollment.confirmedHosts.count) of \(participants.count) devboxes confirmed. The scope is kept for recovery.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }
        .onChange(of: memoryProject) { _, _ in confirmed = false }
        .onChange(of: shareMemory) { _, _ in confirmed = false }
    }

    private func link() {
        guard canConfirm, let memoryProject, let missionHost else { return }
        let binding = enrollment.binding ?? existingBinding ?? SharedContextBinding(
            bindingId: UUID().uuidString, generation: 1, logicalProjectId: UUID().uuidString,
            memoryHome: SharedProjectRef(host: OperationHost(memoryProject.host), projectId: memoryProject.localId),
            missionHome: OperationHost(missionHost),
            executionProject: SharedProjectRef(host: OperationHost(project.host), projectId: project.localId),
            missionIds: missionIds.sorted(), shareMemory: shareMemory)
        Task {
            await enrollment.confirm(binding, participants: participants)
            if enrollment.complete { dismiss() }
        }
    }
}
