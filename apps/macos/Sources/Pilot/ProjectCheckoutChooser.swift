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
