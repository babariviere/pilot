import Foundation
import PilotCore
import SwiftUI

struct CheckoutChoice: Identifiable {
    let id = UUID()
    let source: HostResourceRef
    let host: HostRef
    let revision: UUID
    var projectId: String? = nil
    var folder = ""
}

extension AppModel {
    func verifyMappedCheckout(source: HostResourceRef, target: Hosted<Project>) {
        let form = newSessionForm, validation = UUID(), revision = newSessionForm.revision
        form.checkoutValidation = validation
        form.checkoutValidationTask = Task {
            defer { if form.checkoutValidation == validation { form.checkoutValidation = nil; form.checkoutValidationTask = nil } }
            var verified = false
            do { try await hosts.projectCheckouts.verify([source, target.ref]); verified = true }
            catch { /* A failed read requires explicit selection, never an automatic substitute checkout. */ }
            guard !Task.isCancelled, form.checkoutValidation == validation, form.revision == revision,
                  (form.executionHost ?? localHost) == target.ref.host, draftProjectId == target.value.id,
                  form.folder.isEmpty, form.pendingOperationId == nil, !form.busy else { return }
            if !verified || hosts.projectCheckouts.mapped(source, on: target.ref.host)?.ref != target.ref {
                draftProjectId = ""
                form.checkoutChoice = CheckoutChoice(source: source, host: target.ref.host, revision: revision, projectId: "")
            }
        }
    }

    /// Late chooser responses cannot select a different host's draft or rewrite a pending intent.
    func applyCheckoutChoice(_ choice: CheckoutChoice, target: Hosted<Project>) {
        let form = newSessionForm
        guard form.checkoutChoice?.id == choice.id, form.revision == choice.revision,
              (form.executionHost ?? localHost) == choice.host, target.ref.host == choice.host,
              form.pendingOperationId == nil, pendingChatCreate(on: choice.host) == nil,
              draftProjectId == choice.projectId, form.folder == choice.folder,
              !form.busy, form.mission == nil, form.trackedItem == nil,
              hosts.projects.contains(where: { $0.ref == target.ref && $0.value.path == target.value.path }) else { return }
        draftProjectId = target.value.id
        form.folder = ""; form.workspace = nil; form.pendingBaseBranch = nil
        form.branches.restoreSelection(scope: nil, branch: nil)
        form.checkoutChoice = nil
    }
}

struct ProjectCheckoutChooser: View {
    let source: HostResourceRef
    let initialHost: HostRef?
    @ObservedObject var hosts: HostClients
    let selected: (Hosted<Project>) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var host: HostRef?
    @State private var target: HostResourceRef?
    @State private var busy = false
    @State private var problem: String?

    private var destinations: [HostRef] {
        Set(hosts.projects.map { $0.ref.host }).filter { $0 != source.host }.sorted { $0.hostId < $1.hostId }
    }
    private var choices: [Hosted<Project>] { hosts.projects.filter { $0.ref.host == host } }
    var body: some View {
        SheetScaffold("Checkout locations", subtitle: "Use one project with a separate checkout on each devbox.",
            primary: SheetPrimaryAction(title: busy ? "Saving…" : "Use checkout", enabled: target != nil && !busy, action: confirm), width: 560) {
            VStack(alignment: .leading, spacing: 12) {
                Text("This only matches projects. It does not copy files or credentials, or share memory or missions.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                Picker("Devbox", selection: $host) {
                    Text("Choose devbox").tag(HostRef?.none)
                    ForEach(destinations, id: \.self) { value in
                        Text(HostViewContext(host: value, hosts: hosts).name).tag(Optional(value))
                    }
                }.disabled(initialHost != nil || busy)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(choices) { item in
                            Button { target = item.ref } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.value.name).font(.pilot(.body))
                                        Text(item.value.path).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                                    }
                                    Spacer()
                                    if target == item.ref { PilotSymbol(PilotIcon.selectedOption) }
                                }.padding(.vertical, 8).contentShape(Rectangle())
                            }.rowButtonStyle().disabled(busy)
                            HairlineDivider()
                        }
                        if choices.isEmpty { Text("No known checkout here. Add a project on this devbox first.").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground) }
                    }
                }.frame(maxHeight: 240)
                if let host, !hosts.available.contains(host) {
                    Text("Disconnected. This saved choice can be used after reconnecting.").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                if let host {
                    Button("Use Git origin matching instead") { Task {
                        busy = true
                        defer { busy = false }
                        await hosts.projectCheckouts.useAutomatic(source: source, host: host)
                        if let error = hosts.projectCheckouts.error { problem = error; return }
                        hosts.projectCheckouts.refreshOrigins()
                        dismiss()
                    } }.disabled(busy)
                }
                if let problem { InlineProblem(problem) }
                else if let error = hosts.projectCheckouts.error { InlineProblem(error) }
            }
        }
        .onAppear { host = initialHost ?? destinations.first }
        .onChange(of: host) { _, value in target = value.flatMap { hosts.projectCheckouts.mapped(source, on: $0)?.ref } }
    }

    private func confirm() {
        guard let target, let item = choices.first(where: { $0.ref == target }) else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await hosts.projectCheckouts.confirm(source: source, target: target)
                selected(item); dismiss()
            } catch { problem = error.localizedDescription }
        }
    }
}
